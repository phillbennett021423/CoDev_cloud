// Scene dressing for agents: furnish and arrange a 3D scene from the user's own assets,
// by real-world rules, and learn from what the user changes afterwards.
//
//   - Assets: asset-index.js reads every .glb/.gltf/.png/.jpg in the project and works
//     out what each is (category, real size, materials, colors, style) by itself.
//     No manifests or naming rules; the user can correct anything and it sticks.
//   - Rules: RULES below say where things go in a lived-in room: a desk lamp on a desk's
//     back corner, an office chair tucked in front of the desk facing it, chairs around
//     a dining table, nightstands beside a bed's head, a rug under the coffee table,
//     pictures on the wall above the sofa. Things stand on real surfaces (the parent's
//     measured top), don't overlap, stay inside the room and keep walkways clear.
//   - Learning: every placement is logged. Before each new dressing, and on scene_learn,
//     the open scene is compared with the log: a prop the user moved teaches where
//     that kind of thing goes on that kind of parent, a deleted one counts against it
//     (and against its look), a swapped asset is preferred next time with its style,
//     and a prop the user added on a surface teaches a new "goes on" rule. It's kept in
//     <project>/.codev/scene/, so it can be committed and shared with a team.
//   - Editors: the plan is applied in the open Godot editor through the CoDev Bridge,
//     or written as a bpy script for blender_run. Clearing or moving a surface takes
//     the things on it along.
// Everything here is plain local code: deterministic for a given seed, and free.
const fs = require('fs');
const path = require('path');
const assetIndex = require('./asset-index');

const CONTAINER = 'Dressing';
const STORE_DIR = path.join('.codev', 'scene');
const MAX_OUTPUT = 12000;

// Default sizes (w, h, d in meters, front +Z) for placeholders when the library has no asset.
const DEFAULT_SIZE = {
    desk: [1.4, 0.75, 0.7], office_chair: [0.6, 1.05, 0.6], chair: [0.45, 0.9, 0.5], stool: [0.4, 0.75, 0.4],
    monitor: [0.55, 0.42, 0.2], laptop: [0.34, 0.02, 0.24], keyboard: [0.45, 0.03, 0.15], desk_lamp: [0.2, 0.45, 0.2],
    mug: [0.09, 0.1, 0.09], plant_small: [0.18, 0.3, 0.18], plant: [0.5, 1.4, 0.5], shelf: [0.9, 1.8, 0.35],
    book: [0.16, 0.24, 0.05], trash_bin: [0.3, 0.4, 0.3], picture: [0.8, 0.6, 0.04], rug: [2.0, 0.01, 1.4],
    bed: [1.6, 0.6, 2.1], nightstand: [0.5, 0.55, 0.4], wardrobe: [1.2, 2.0, 0.6], dresser: [1.2, 0.85, 0.5],
    sofa: [2.1, 0.85, 0.9], coffee_table: [1.1, 0.42, 0.6], armchair: [0.85, 0.9, 0.85], tv_stand: [1.6, 0.5, 0.45],
    tv: [1.25, 0.75, 0.08], floor_lamp: [0.4, 1.6, 0.4], side_table: [0.5, 0.55, 0.5], vase: [0.15, 0.3, 0.15],
    dining_table: [1.8, 0.75, 0.9], table: [1.2, 0.75, 0.8], ceiling_lamp: [0.5, 0.4, 0.5], plate: [0.26, 0.02, 0.26],
    counter: [2.4, 0.9, 0.65], fridge: [0.75, 1.8, 0.7], stove: [0.75, 0.9, 0.65], sink: [0.8, 0.9, 0.6], bottle: [0.08, 0.3, 0.08],
    candle: [0.08, 0.15, 0.08], clock: [0.3, 0.3, 0.08], phone: [0.08, 0.01, 0.16], speaker: [0.2, 0.3, 0.2],
    pillow: [0.45, 0.15, 0.45], box: [0.5, 0.4, 0.4], lamp: [0.3, 0.5, 0.3], bench: [1.2, 0.45, 0.4]
};

// How each kind of thing is placed.
//   wall: back against a wall, facing into the room (clear: keep this much free in front)
//   on: standing on a parent's top, at a spot (back_corner, back_center, front_center, front_corner, center, any)
//   front: in front of a parent (gap, negative tucks it in), facing it ("toward") or the same way ("same")
//   around: several around a table, facing it
//   side: beside a parent (align back/center/front)
//   under: under a parent (rugs)   corner: in a room corner   center: middle of the room
//   wall_above: on the wall above a parent   ceiling: hanging over a parent   free: anywhere on the floor
const RULES = {
    desk: { place: 'wall', clear: 0.9 }, shelf: { place: 'wall', clear: 0.6 }, wardrobe: { place: 'wall', clear: 0.8 },
    dresser: { place: 'wall', clear: 0.7 }, bed: { place: 'wall', clear: 0.6 }, sofa: { place: 'wall', clear: 0.5 },
    tv_stand: { place: 'wall', clear: 0.5 }, counter: { place: 'wall', clear: 0.9 }, fridge: { place: 'wall', clear: 0.9 },
    stove: { place: 'wall', clear: 0.9 }, sink: { place: 'wall', clear: 0.9 }, bench: { place: 'wall', clear: 0.4 },
    dining_table: { place: 'center' }, table: { place: 'center' },
    coffee_table: { place: 'front', of: ['sofa'], gap: 0.4, face: 'same' },
    office_chair: { place: 'front', of: ['desk'], gap: -0.2, face: 'toward' },
    chair: { place: 'around', of: ['dining_table', 'table', 'desk'], gap: -0.12 },
    stool: { place: 'front', of: ['counter', 'desk'], gap: 0.05, face: 'toward' },
    armchair: { place: 'side', of: ['coffee_table', 'sofa'], gap: 0.35, align: 'center', face: 'toward' },
    nightstand: { place: 'side', of: ['bed'], gap: 0.05, align: 'back', face: 'same' },
    side_table: { place: 'side', of: ['sofa', 'armchair', 'bed'], gap: 0.05, align: 'center', face: 'same' },
    floor_lamp: { place: 'side', of: ['sofa', 'armchair', 'bed', 'desk', 'shelf'], gap: 0.1, align: 'back', face: 'same' },
    trash_bin: { place: 'side', of: ['desk'], gap: 0.05, align: 'front', face: 'same' },
    rug: { place: 'under', of: ['coffee_table', 'dining_table', 'table', 'bed'] },
    plant: { place: 'corner' }, box: { place: 'corner' }, speaker: { place: 'on', of: ['shelf', 'tv_stand', 'desk', 'dresser'], spot: 'back_corner' },
    picture: { place: 'wall_above', of: ['sofa', 'bed', 'desk', 'dresser', 'tv_stand'] },
    clock: { place: 'wall_above', of: ['desk', 'dresser', 'shelf', 'tv_stand'] },
    ceiling_lamp: { place: 'ceiling', of: ['dining_table', 'table', 'coffee_table', 'bed', 'desk'] },
    tv: { place: 'on', of: ['tv_stand', 'dresser'], spot: 'center' },
    monitor: { place: 'on', of: ['desk'], spot: 'back_center' },
    laptop: { place: 'on', of: ['desk', 'dining_table', 'coffee_table'], spot: 'center' },
    keyboard: { place: 'on', of: ['desk'], spot: 'front_center' },
    desk_lamp: { place: 'on', of: ['desk', 'nightstand', 'side_table', 'dresser'], spot: 'back_corner' },
    lamp: { place: 'on', of: ['desk', 'nightstand', 'side_table', 'dresser'], spot: 'back_corner' },
    book: { place: 'on', of: ['shelf', 'nightstand', 'coffee_table', 'desk', 'side_table'], spot: 'any' },
    mug: { place: 'on', of: ['desk', 'coffee_table', 'dining_table', 'table', 'counter', 'side_table'], spot: 'front_corner' },
    plate: { place: 'on', of: ['dining_table', 'table', 'counter'], spot: 'any' },
    bottle: { place: 'on', of: ['counter', 'dining_table', 'table', 'desk'], spot: 'any' },
    vase: { place: 'on', of: ['dining_table', 'table', 'side_table', 'dresser', 'shelf', 'coffee_table'], spot: 'center' },
    plant_small: { place: 'on', of: ['desk', 'shelf', 'side_table', 'nightstand', 'dresser', 'coffee_table'], spot: 'back_corner' },
    candle: { place: 'on', of: ['dining_table', 'coffee_table', 'dresser', 'nightstand'], spot: 'center' },
    phone: { place: 'on', of: ['desk', 'nightstand'], spot: 'front_corner' },
    pillow: { place: 'on', of: ['sofa', 'bed', 'armchair'], spot: 'back_corner' }
};
const DEFAULT_RULE = { place: 'free' };

// Assets of a close kind stand in when the library has none of the exact one.
const FALLBACK = {
    desk_lamp: ['lamp'], floor_lamp: ['lamp'], office_chair: ['chair'], chair: ['office_chair', 'stool'], dining_table: ['table'],
    coffee_table: ['table'], side_table: ['nightstand', 'table'], nightstand: ['side_table'], plant_small: ['plant'], plant: ['plant_small'],
    tv: ['monitor'], monitor: ['tv', 'laptop'], armchair: ['chair', 'sofa'], shelf: ['dresser'], dresser: ['shelf'], vase: ['plant_small', 'bottle'],
    mug: ['bottle'], table: ['dining_table', 'desk'], stool: ['chair']
};

// Rooms by name. optional: decor the user can teach CoDev to leave out by deleting it.
const PRESETS = {
    office: ['desk', 'office_chair', 'monitor', 'keyboard', 'desk_lamp', { category: 'mug', optional: true }, { category: 'plant_small', optional: true },
        'shelf', { category: 'book', count: 3 }, { category: 'plant', optional: true }, { category: 'trash_bin', optional: true }, { category: 'picture', optional: true }],
    bedroom: ['bed', { category: 'nightstand', count: 2 }, 'desk_lamp', { category: 'rug', optional: true }, 'wardrobe', 'dresser',
        { category: 'picture', optional: true }, { category: 'plant', optional: true }, { category: 'book', optional: true }],
    living_room: ['sofa', 'coffee_table', { category: 'rug', optional: true }, 'armchair', 'tv_stand', 'tv', 'floor_lamp', 'side_table',
        { category: 'plant', optional: true }, { category: 'picture', optional: true }, { category: 'book', count: 2, optional: true }, { category: 'vase', optional: true }],
    dining_room: ['dining_table', { category: 'chair', count: 4 }, { category: 'rug', optional: true }, 'ceiling_lamp', { category: 'vase', optional: true },
        { category: 'plate', count: 4, optional: true }, 'dresser', { category: 'plant', optional: true }, { category: 'picture', optional: true }],
    kitchen: ['counter', 'fridge', 'stove', { category: 'stool', count: 2 }, { category: 'bottle', count: 2, optional: true }, { category: 'plate', optional: true }, { category: 'plant_small', optional: true }]
};
PRESETS.study = PRESETS.office;
PRESETS.living = PRESETS.living_room;
PRESETS.dining = PRESETS.dining_room;

function text(value, isError = false) { return { content: [{ type: 'text', text: String(value).slice(0, MAX_OUTPUT * 2) }], ...(isError ? { isError: true } : {}) }; }
const round = (v, n = 3) => +Number(v).toFixed(n);
const deg = r => (r * 180) / Math.PI;
const rad = d => (d * Math.PI) / 180;
function wrapDeg(d) { d = ((d % 360) + 540) % 360 - 180; return round(d === -180 ? 180 : d, 2); }

// A small seeded random generator (mulberry32), so a seed gives the same layout.
function rng(seed) {
    let a = 0;
    for (const ch of String(seed)) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ------------------------------------------------------------------ geometry
// Godot: Y up, yaw rotates about Y; an asset's front is +Z (the glTF convention).
// Local (lx, lz) of a thing with yaw θ -> world offset.
function rotate(lx, lz, yawDeg) {
    const t = rad(yawDeg);
    return [lx * Math.cos(t) + lz * Math.sin(t), -lx * Math.sin(t) + lz * Math.cos(t)];
}
function toLocal(dx, dz, yawDeg) { return rotate(dx, dz, -yawDeg); }
function yawToward(fromX, fromZ, toX, toZ) { return wrapDeg(deg(Math.atan2(toX - fromX, toZ - fromZ))); }

// The axis-aligned box a thing covers on the floor (x0, x1, z0, z1).
function footprint(cx, cz, w, d, yaw) {
    const t = rad(yaw);
    const hx = Math.abs(Math.cos(t)) * w / 2 + Math.abs(Math.sin(t)) * d / 2;
    const hz = Math.abs(Math.sin(t)) * w / 2 + Math.abs(Math.cos(t)) * d / 2;
    return [cx - hx, cx + hx, cz - hz, cz + hz];
}
function overlaps(a, b, pad = 0) { return a[0] < b[1] - pad && a[1] > b[0] + pad && a[2] < b[3] - pad && a[3] > b[2] + pad; }

// The shape of an asset (or a placeholder box) as placement needs it.
function shapeOf(asset, category) {
    if (asset && asset.size) {
        return { size: asset.size, bottom: asset.bottom || 0, center: asset.center || [0, 0], scale: asset.scale || 1, front: asset.front || 0 };
    }
    const size = DEFAULT_SIZE[category] || [0.4, 0.4, 0.4];
    // A CSGBox3D is centered on its origin.
    return { size, bottom: -size[1] / 2, center: [0, 0], scale: 1, front: 0, placeholder: true };
}

// ------------------------------------------------------------------ storage

function storePath(root, name) { return path.join(root, STORE_DIR, name); }
function load(root, name, fallback) {
    try { return JSON.parse(fs.readFileSync(storePath(root, name), 'utf8')); } catch { return fallback; }
}
function save(root, name, value) {
    fs.mkdirSync(path.join(root, STORE_DIR), { recursive: true });
    fs.writeFileSync(storePath(root, name), JSON.stringify(value, null, 1));
}
function emptyPrefs() { return { assets: {}, tags: {}, categories: {}, offsets: {}, gaps: {}, sides: {}, parents: {}, walls: {}, events: [] }; }
function loadPrefs(root) { return { ...emptyPrefs(), ...load(root, 'preferences.json', {}) }; }

function refreshIndex(root) {
    const previous = load(root, 'assets.json', {});
    const index = assetIndex.buildIndex(root, previous);
    if (index.reread || (previous.assets || []).length !== index.assets.length) save(root, 'assets.json', index);
    return index;
}

// ------------------------------------------------------------------ choosing assets

// "walnut 1980s" -> ['walnut', '1980s', 'wood', 'retro']: the words and the tags they mean.
function styleTags(style) { return assetIndex.tagWords(Array.isArray(style) ? style.join(' ') : style || ''); }

function assetScore(asset, wantedTags, prefs, exact) {
    let s = (exact ? 3 : 1) + (asset.confidence || 0);
    for (const t of wantedTags) if (asset.tags && asset.tags[t]) s += 2;
    let taste = 0;
    for (const t of Object.keys(asset.tags || {})) taste += prefs.tags[t] || 0;
    s += Math.max(-3, Math.min(3, taste * 0.5));
    const a = prefs.assets[asset.path];
    if (a) s += Math.max(-4, Math.min(4, a.score || 0));
    return s;
}

function chooseAsset(index, category, { wantedTags, prefs, used, random, explicit }) {
    const models = (index.assets || []).filter(a => a.kind === 'model');
    if (explicit) {
        const res = explicit.startsWith('res://') ? explicit : `res://${explicit.replace(/^\/+/, '')}`;
        return models.find(a => a.path === res) || null;
    }
    const exact = models.filter(a => a.category === category);
    const pool = exact.length ? exact : models.filter(a => (FALLBACK[category] || []).includes(a.category));
    if (!pool.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const a of pool) {
        const s = assetScore(a, wantedTags, prefs, a.category === category) - (used.get(a.path) || 0) * 0.75 + random() * 0.01;
        if (s > bestScore) { bestScore = s; best = a; }
    }
    // Something the user keeps removing or swapping away isn't used again.
    if (best && prefs.assets[best.path] && prefs.assets[best.path].score <= -3) return null;
    return best;
}

// ------------------------------------------------------------------ the planner

function expandItems(items) {
    const out = [];
    for (const raw of items) {
        const item = typeof raw === 'string' ? { category: raw } : { ...raw };
        if (!item.category && item.asset) item.category = '';
        const count = Math.max(1, Math.min(24, Number(item.count) || 1));
        for (let i = 0; i < count; i++) out.push({ ...item, count: undefined, copy: i, copies: count });
    }
    return out;
}

// Parents before what goes on or beside them.
const ORDER = { wall: 0, center: 0, corner: 2, front: 1, side: 1, around: 1, under: 3, on: 4, wall_above: 4, ceiling: 4, free: 3 };

function relationKey(category, parentCategory, place) { return `${category}@${parentCategory || 'room'}:${place}`; }

function mean(list) { return list.reduce((s, v) => s + v, 0) / list.length; }

function plan({ index, prefs, items, room = {}, style = '', seed = 1, placeholders = true, anchors = [] }) {
    const random = rng(seed);
    const [roomW, roomH, roomD] = Array.isArray(room.size) && room.size.length === 3 ? room.size.map(Number) : [6, 3, 5];
    const origin = Array.isArray(room.center) ? room.center.map(Number) : [0, 0, 0];
    const wantedTags = styleTags(style);
    const used = new Map();
    const placed = anchors.map(a => ({ ...a, existing: true }));
    const out = [];
    const skipped = [];
    const learned = [];
    const walls = [
        { name: 'back', yaw: 0, axis: 'x', at: origin[2] - roomD / 2, length: roomW, normal: [0, 1] },
        { name: 'left', yaw: 90, axis: 'z', at: origin[0] - roomW / 2, length: roomD, normal: [1, 0] },
        { name: 'right', yaw: -90, axis: 'z', at: origin[0] + roomW / 2, length: roomD, normal: [-1, 0] },
        { name: 'front', yaw: 180, axis: 'x', at: origin[2] + roomD / 2, length: roomW, normal: [0, -1] }
    ];

    const floorBoxes = () => placed.filter(p => p.floor && !p.flat);
    const inRoom = box => box[0] >= origin[0] - roomW / 2 - 1e-6 && box[1] <= origin[0] + roomW / 2 + 1e-6 && box[2] >= origin[2] - roomD / 2 - 1e-6 && box[3] <= origin[2] + roomD / 2 + 1e-6;
    const fitsFloor = (box, ignore = []) => inRoom(box)
        && !floorBoxes().some(p => !ignore.includes(p) && overlaps(box, p.box, 0.005))
        && !placed.some(p => p.keepOut && !ignore.includes(p) && overlaps(box, p.keepOut, 0.005));

    // A placement from the footprint center; the node's origin is moved by the asset's own offset.
    function make(item, asset, shape, cx, cz, baseY, yaw, extra) {
        const [w, h, d] = shape.size;
        const [ox, oz] = rotate(shape.center[0], shape.center[1], yaw);
        const box = footprint(cx, cz, w, d, yaw);
        return {
            item, asset, shape, category: item.category, size: shape.size,
            position: [round(cx - ox), round(baseY - shape.bottom), round(cz - oz)], cx, cz, yaw: wrapDeg(yaw),
            base: baseY, top: baseY + h, box, ...extra
        };
    }

    function parentFor(item, rule) {
        const want = item.on || item.of || item.near || item.facing;
        if (want) {
            const w = String(want).toLowerCase();
            return placed.find(p => p.name && p.name.toLowerCase() === w) || placed.find(p => p.node && p.node.toLowerCase().endsWith(w))
                || placed.filter(p => p.category === w).sort((a, b) => (a.children || 0) - (b.children || 0))[0] || null;
        }
        // Parents the user taught (by putting this kind of thing there) come first.
        const taught = Object.entries(prefs.parents[item.category] || {}).sort((a, b) => b[1] - a[1]).map(([c]) => c);
        const order = [...new Set([...taught, ...(rule.of || [])])];
        for (const cat of order) {
            const options = placed.filter(p => p.category === cat && (p.size[0] > 0.05));
            if (options.length) return options.sort((a, b) => (a.childCount?.[item.category] || 0) - (b.childCount?.[item.category] || 0) || (a.children || 0) - (b.children || 0))[0];
        }
        return null;
    }

    function learnedOffset(key) {
        const list = prefs.offsets[key];
        if (!list || !list.length) return null;
        return { lx: mean(list.map(o => o.lx)), lz: mean(list.map(o => o.lz)), yaw: mean(list.map(o => o.yaw || 0)), n: list.length };
    }

    function placeOnWall(item, asset, shape, rule) {
        const [w, , d] = shape.size;
        const preferred = Object.entries(prefs.walls[item.category] || {}).sort((a, b) => b[1] - a[1]).map(([n]) => n);
        const start = Math.floor(random() * walls.length);
        const order = [...walls.slice(start), ...walls.slice(0, start)].sort((a, b) => {
            const pa = preferred.indexOf(a.name); const pb = preferred.indexOf(b.name);
            return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || placed.filter(p => p.wall === a.name).length - placed.filter(p => p.wall === b.name).length;
        });
        for (const wall of order) {
            if (w > wall.length - 0.1) continue;
            const span = (wall.length - w) / 2 - 0.05;
            const offsets = [0, ...Array.from({ length: 16 }, (_, i) => ((i % 2 ? 1 : -1) * Math.ceil((i + 1) / 2) * span) / 8)];
            for (const t of offsets) {
                const inset = d / 2 + 0.02;
                const cx = wall.axis === 'x' ? origin[0] + t : wall.at + wall.normal[0] * inset;
                const cz = wall.axis === 'x' ? wall.at + wall.normal[1] * inset : origin[2] + t;
                const p = make(item, asset, shape, cx, cz, origin[1], wall.yaw, { floor: true, wall: wall.name, relation: `against the ${wall.name} wall` });
                if (!fitsFloor(p.box)) continue;
                if (rule.clear) {
                    const [fx, fz] = rotate(0, d / 2 + rule.clear / 2, wall.yaw);
                    p.keepOut = footprint(cx + fx, cz + fz, w, rule.clear, wall.yaw);
                }
                return p;
            }
        }
        return null;
    }

    function placeFloorSpot(item, asset, shape, candidates, yawFor, extra) {
        for (const [cx, cz] of candidates) {
            const yaw = yawFor(cx, cz);
            const p = make(item, asset, shape, cx, cz, origin[1], yaw, { floor: true, ...extra });
            if (fitsFloor(p.box)) return p;
        }
        return null;
    }

    function placeRelative(item, asset, shape, rule, parent) {
        const [w, h, d] = shape.size;
        const [pw, ph, pd] = parent.size;
        const key = relationKey(item.category, parent.category, rule.place);
        const taught = learnedOffset(key);
        const local = (lx, lz) => { const [x, z] = rotate(lx, lz, parent.yaw); return [parent.cx + x, parent.cz + z]; };

        if (rule.place === 'on') {
            const m = 0.03;
            if (w > pw - m || d > pd - m) return null;
            const ax = pw / 2 - w / 2 - m;
            const az = pd / 2 - d / 2 - m;
            const spots = [];
            if (taught) spots.push([taught.lx * ax, taught.lz * az, taught.yaw]);
            const side = (parent.childCount?.[item.category] || 0) % 2 ? 1 : -1;
            const named = {
                back_corner: [[side * ax, -az], [-side * ax, -az]], front_corner: [[-side * ax, az], [side * ax, az]],
                back_center: [[0, -az]], front_center: [[0, az * 0.6], [0, az]], center: [[0, 0]], any: []
            }[rule.spot || 'any'] || [];
            for (const s of named) spots.push([s[0], s[1], 0]);
            for (let i = 0; i < 24; i++) spots.push([(random() * 2 - 1) * ax, (random() * 2 - 1) * az, 0]);
            const siblings = placed.filter(p => p.parent === parent);
            for (const [lx, lz, dy] of spots) {
                const [cx, cz] = local(lx, lz);
                const p = make(item, asset, shape, cx, cz, parent.top, parent.yaw + dy, { parent, relation: `on the ${parent.name || parent.category}`, lx, lz });
                if (!siblings.some(s => overlaps(p.box, s.box, 0.002))) return { ...p, taught: Boolean(taught && lx === taught.lx * ax) };
            }
            return null;
        }
        if (rule.place === 'front') {
            const gap = prefs.gaps[key] && prefs.gaps[key].length ? mean(prefs.gaps[key]) : (rule.gap ?? 0.3);
            const along = taught ? [taught.lx * (pw / 2), 0] : [0];
            for (const lx of [...along, -pw / 4, pw / 4]) {
                const [cx, cz] = local(lx, pd / 2 + gap + d / 2);
                const yaw = rule.face === 'toward' ? parent.yaw + 180 : parent.yaw;
                const p = make(item, asset, shape, cx, cz, origin[1], yaw, { floor: true, parent, relation: `${rule.face === 'toward' ? 'facing' : 'in front of'} the ${parent.name || parent.category}` });
                // The parent's own walkway is where this goes; a negative gap tucks it under the parent.
                if (fitsFloor(p.box, [parent]) && (gap < 0 || !overlaps(p.box, parent.box, 0.005))) return p;
            }
            return null;
        }
        if (rule.place === 'around') {
            const gap = rule.gap ?? -0.1;
            const long = pw >= pd;
            const along = long ? pw : pd;
            const across = long ? pd : pw;
            const perSide = Math.max(1, Math.floor(along / Math.max(0.55, w + 0.1)));
            const slots = [];
            for (let i = 0; i < perSide; i++) {
                const t = (i + 0.5) / perSide * along - along / 2;
                for (const s of [1, -1]) slots.push(long ? [t, s * (across / 2 + gap + d / 2)] : [s * (across / 2 + gap + d / 2), t]);
            }
            for (const s of [1, -1]) slots.push(long ? [s * (along / 2 + gap + d / 2), 0] : [0, s * (along / 2 + gap + d / 2)]);
            for (const [lx, lz] of slots) {
                const [cx, cz] = local(lx, lz);
                const p = make(item, asset, shape, cx, cz, origin[1], yawToward(cx, cz, parent.cx, parent.cz), { floor: true, parent, relation: `at the ${parent.name || parent.category}, facing it` });
                if (fitsFloor(p.box, [parent])) return p;
            }
            return null;
        }
        if (rule.place === 'side') {
            const gap = rule.gap ?? 0.05;
            const taughtSide = prefs.sides[key] && prefs.sides[key].length ? Math.sign(mean(prefs.sides[key])) || 1 : 0;
            const nth = (parent.childCount?.[item.category] || 0);
            const sides = taughtSide ? [taughtSide, -taughtSide] : nth % 2 ? [-1, 1] : [1, -1];
            const lz = rule.align === 'back' ? -(pd / 2 - d / 2) : rule.align === 'front' ? pd / 2 - d / 2 : 0;
            for (const s of sides) {
                const [cx, cz] = local(s * (pw / 2 + gap + w / 2), lz);
                const yaw = rule.face === 'toward' ? yawToward(cx, cz, parent.cx, parent.cz) : parent.yaw;
                const p = make(item, asset, shape, cx, cz, origin[1], yaw, { floor: true, parent, relation: `beside the ${parent.name || parent.category}`, side: s });
                if (fitsFloor(p.box)) return p;
            }
            return null;
        }
        if (rule.place === 'under') {
            return make(item, asset, shape, parent.cx, parent.cz, origin[1], parent.yaw, { floor: true, flat: true, parent, relation: `under the ${parent.name || parent.category}` });
        }
        if (rule.place === 'wall_above') {
            const wall = walls.find(x => x.name === parent.wall);
            const yaw = wall ? wall.yaw : parent.yaw;
            const back = local(0, -pd / 2);
            const inset = d / 2 + 0.01;
            let cx = back[0]; let cz = back[1];
            if (wall) { if (wall.axis === 'x') cz = wall.at + wall.normal[1] * inset; else cx = wall.at + wall.normal[0] * inset; }
            const centerY = Math.max(1.45, parent.top + 0.3 + h / 2);
            const p = make(item, asset, shape, cx, cz, origin[1] + Math.min(centerY, roomH - 0.1 - h / 2) - h / 2, yaw, { parent, relation: `on the wall above the ${parent.name || parent.category}` });
            if (placed.some(o => o.relation && o.relation.startsWith('on the wall') && overlaps(p.box, o.box) && Math.abs(o.base - p.base) < h)) return null;
            return p;
        }
        if (rule.place === 'ceiling') {
            return make(item, asset, shape, parent.cx, parent.cz, origin[1] + roomH - h, parent.yaw, { parent, relation: `hanging over the ${parent.name || parent.category}` });
        }
        return null;
    }

    const list = expandItems(items).map((item, i) => ({ item, i, rule: { ...DEFAULT_RULE, ...(RULES[item.category] || {}), ...(item.place ? { place: item.place } : {}) } }))
        .sort((a, b) => (ORDER[a.rule.place] ?? 3) - (ORDER[b.rule.place] ?? 3) || a.i - b.i);
    const claimed = new Set();
    for (const { item, rule } of list) {
        const label = item.name || item.category || item.asset;
        // A kind of thing the user keeps deleting is left out when it was only decoration.
        const c = prefs.categories[item.category];
        if (item.optional && c && c.removed >= 2 && c.removed > (c.kept || 0) + (c.added || 0)) {
            skipped.push(`${label}: left out, since you removed ${c.removed} of them before`);
            learned.push(`left out ${item.category} (you deleted them)`);
            continue;
        }
        // The scene's own desk is used instead of adding a second one.
        if (!item.add && ['wall', 'center', 'corner', 'free'].includes(rule.place)) {
            const mine = placed.find(p => p.existing && p.category === item.category && !claimed.has(p));
            if (mine) { claimed.add(mine); continue; }
        }
        const asset = item.category ? chooseAsset(index, item.category, { wantedTags, prefs, used, random, explicit: item.asset }) : chooseAsset(index, '', { wantedTags, prefs, used, random, explicit: item.asset });
        if (item.asset && !asset) { skipped.push(`${label}: no asset ${item.asset} in the project`); continue; }
        if (!item.category && asset) item.category = asset.category;
        if (!asset && !placeholders) { skipped.push(`${label}: no ${item.category} in your asset library`); continue; }
        const shape = shapeOf(asset, item.category);
        let p = null;
        if (['on', 'front', 'around', 'side', 'under', 'wall_above', 'ceiling'].includes(rule.place)) {
            const parent = parentFor(item, rule);
            if (!parent) { skipped.push(`${label}: needs a ${(rule.of || ['parent'])[0].replace(/_/g, ' ')} to go ${rule.place === 'on' ? 'on' : 'by'}`); continue; }
            p = placeRelative(item, asset, shape, rule, parent);
            if (!p && rule.place === 'on') {
                // Try the other surfaces the rule allows before giving up.
                for (const cat of rule.of || []) {
                    for (const other of placed.filter(x => x.category === cat && x !== parent)) { p = placeRelative(item, asset, shape, rule, other); if (p) break; }
                    if (p) break;
                }
            }
            if (!p) { skipped.push(`${label}: no free room ${rule.place === 'on' ? 'on' : 'by'} the ${parent.name || parent.category}`); continue; }
            if (p.taught) learned.push(`${item.category} on the ${parent.category}: where you moved it before`);
        } else if (rule.place === 'wall') {
            p = placeOnWall(item, asset, shape, rule);
        } else if (rule.place === 'corner') {
            const [w, , d] = shape.size;
            // Turned 45° to face the room, it covers (w + d) / 2 * cos 45° each way.
            const r = (w + d) * 0.3536 + 0.05;
            const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => [origin[0] + sx * (roomW / 2 - r), origin[2] + sz * (roomD / 2 - r)]);
            corners.sort(() => random() - 0.5);
            p = placeFloorSpot(item, asset, shape, corners, (cx, cz) => yawToward(cx, cz, origin[0], origin[2]), { relation: 'in a corner' });
        } else {
            const spots = rule.place === 'center' ? [[origin[0], origin[2]]] : [];
            for (let i = 0; i < 60; i++) spots.push([origin[0] + (random() - 0.5) * (roomW - shape.size[0]), origin[2] + (random() - 0.5) * (roomD - shape.size[2])]);
            const fixedYaw = rule.place === 'center' ? 0 : Math.round(random() * 3) * 90;
            p = placeFloorSpot(item, asset, shape, spots, () => fixedYaw, { relation: rule.place === 'center' ? 'in the middle of the room' : 'on the floor' });
        }
        if (!p) { skipped.push(`${label}: no free floor space left for it`); continue; }
        if (asset) used.set(asset.path, (used.get(asset.path) || 0) + 1);
        p.name = item.name || pascal(item.category || 'Prop') + (item.copies > 1 ? String(item.copy + 1) : '');
        p.place = rule.place;
        if (p.parent) {
            p.parent.children = (p.parent.children || 0) + 1;
            p.parent.childCount = { ...(p.parent.childCount || {}), [item.category]: (p.parent.childCount?.[item.category] || 0) + 1 };
        }
        placed.push(p);
        out.push(p);
    }
    return { placements: out, skipped, learned: [...new Set(learned)], room: { size: [roomW, roomH, roomD], center: origin } };
}

function pascal(category) { return String(category).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(''); }

// ------------------------------------------------------------------ the scene in the editor

function vec(value) {
    if (Array.isArray(value)) return value.map(Number);
    const m = String(value || '').match(/\(([^)]*)\)/);
    return m ? m[1].split(',').map(Number) : null;
}

// Nodes of the open scene with where they are, from the bridge's scene_tree.
function sceneNodes(tree) {
    return (tree.nodes || []).map(n => {
        const position = vec(n.global_position) || vec(n.position);
        const rotation = vec(n.global_rotation_degrees) || vec(n.rotation_degrees) || [0, 0, 0];
        const scale = vec(n.scale) || [1, 1, 1];
        return { ...n, position, yaw: rotation[1] || 0, scale };
    });
}

// What's in the open scene that placement can build on: models from the index, and what CoDev placed.
function anchorsFrom(nodes, index, log) {
    const byPath = new Map((index.assets || []).map(a => [a.path, a]));
    const logged = new Map((log.placements || []).map(p => [p.node, p]));
    const anchors = [];
    for (const n of nodes) {
        if (!n.position) continue;
        const entry = logged.get(n.path);
        const asset = n.scene ? byPath.get(n.scene) : null;
        if (!entry && !asset) continue;
        const category = entry ? entry.category : asset.category;
        const shape = asset ? shapeOf(asset, category) : { size: entry.size, bottom: entry.bottom, center: entry.center || [0, 0], scale: 1 };
        const s = (n.scale && n.scale[0]) || 1;
        const ratio = asset ? s / (asset.scale || 1) : 1;
        const size = shape.size.map(v => v * ratio);
        const [ox, oz] = rotate(shape.center[0] * ratio, shape.center[1] * ratio, n.yaw);
        const cx = n.position[0] + ox;
        const cz = n.position[2] + oz;
        const base = n.position[1] + shape.bottom * ratio;
        anchors.push({
            node: n.path, name: n.name, category, size, cx, cz, yaw: n.yaw, base, top: base + size[1], floor: base < 0.05 && !(entry && entry.place === 'on'),
            flat: size[1] < 0.05, box: footprint(cx, cz, size[0], size[2], n.yaw), wall: entry && entry.wall, asset: asset ? asset.path : entry && entry.asset
        });
    }
    return anchors;
}

// ------------------------------------------------------------------ learning

function bump(obj, key, field, by = 1) {
    obj[key] = obj[key] || {};
    obj[key][field] = (obj[key][field] || 0) + by;
}
function pushCapped(obj, key, value, cap = 20) {
    obj[key] = [...(obj[key] || []), value].slice(-cap);
}

function tagsOf(index, res) {
    const a = (index.assets || []).find(x => x.path === res);
    return a ? Object.keys(a.tags || {}) : [];
}

// Compares the open scene with what CoDev placed and folds the differences into the preferences.
function learnFromScene({ nodes, index, log, prefs, scenePath }) {
    const now = new Date().toISOString();
    const byNode = new Map(nodes.map(n => [n.path, n]));
    const events = [];
    const keep = [];
    const removed = [];
    const placements = (log.placements || []).filter(p => !p.scene || p.scene === scenePath);
    const others = (log.placements || []).filter(p => p.scene && p.scene !== scenePath);
    const assetsByPath = new Map((index.assets || []).map(a => [a.path, a]));
    const entryShape = e => ({ size: e.size, bottom: e.bottom, center: e.center || [0, 0] });
    const current = e => {
        const n = byNode.get(e.node);
        if (!n || !n.position) return null;
        const [ox, oz] = rotate((e.center || [0, 0])[0], (e.center || [0, 0])[1], n.yaw);
        return { cx: n.position[0] + ox, cz: n.position[2] + oz, y: n.position[1], yaw: n.yaw, base: n.position[1] + (e.bottom || 0) };
    };
    const assetPref = (res, by, field) => {
        if (!res) return;
        prefs.assets[res] = prefs.assets[res] || { score: 0 };
        prefs.assets[res].score = round((prefs.assets[res].score || 0) + by, 2);
        if (field) prefs.assets[res][field] = (prefs.assets[res][field] || 0) + 1;
    };
    const tagPref = (tags, by) => { for (const t of tags) prefs.tags[t] = round((prefs.tags[t] || 0) + by, 2); };

    for (const e of placements) {
        const n = byNode.get(e.node);
        if (!n) { removed.push(e); continue; }
        const now2 = current(e);
        // Swapped: the same node now holds another asset.
        if (e.asset && n.scene && n.scene !== e.asset) {
            assetPref(e.asset, -1.5, 'swappedAway');
            assetPref(n.scene, 2, 'swappedIn');
            const before = tagsOf(index, e.asset);
            const after = tagsOf(index, n.scene);
            tagPref(after.filter(t => !before.includes(t)), 1);
            tagPref(before.filter(t => !after.includes(t)), -1);
            events.push({ at: now, type: 'swapped', category: e.category, from: e.asset, to: n.scene });
            const swappedAsset = assetsByPath.get(n.scene);
            if (swappedAsset) { e.asset = n.scene; Object.assign(e, entryShape(shapeOf(swappedAsset, e.category))); }
        }
        const moved = now2 && (Math.hypot(now2.cx - e.cx, now2.cz - e.cz) > 0.05 || Math.abs(now2.base - e.base) > 0.05 || Math.abs(wrapDeg(now2.yaw - e.yaw)) > 5);
        if (moved) {
            const parent = e.parentNode ? placements.find(p => p.node === e.parentNode) : null;
            const parentNow = parent ? (current(parent) || parent) : null;
            const key = relationKey(e.category, parent ? parent.category : '', e.place);
            if (parent && parentNow && e.place === 'on') {
                const [lx, lz] = toLocal(now2.cx - parentNow.cx, now2.cz - parentNow.cz, parentNow.yaw);
                const ax = Math.max(0.01, parent.size[0] / 2 - e.size[0] / 2 - 0.03);
                const az = Math.max(0.01, parent.size[2] / 2 - e.size[2] / 2 - 0.03);
                pushCapped(prefs.offsets, key, { lx: round(Math.max(-1, Math.min(1, lx / ax))), lz: round(Math.max(-1, Math.min(1, lz / az))), yaw: wrapDeg(now2.yaw - parentNow.yaw) });
            } else if (parent && parentNow && e.place === 'front') {
                const [lx, lz] = toLocal(now2.cx - parentNow.cx, now2.cz - parentNow.cz, parentNow.yaw);
                pushCapped(prefs.gaps, key, round(lz - parent.size[2] / 2 - e.size[2] / 2));
                pushCapped(prefs.offsets, key, { lx: round(Math.max(-1, Math.min(1, lx / (parent.size[0] / 2)))), lz: 0, yaw: 0 });
            } else if (parent && parentNow && e.place === 'side') {
                const [lx] = toLocal(now2.cx - parentNow.cx, now2.cz - parentNow.cz, parentNow.yaw);
                pushCapped(prefs.sides, key, Math.sign(lx) || 1);
            }
            events.push({ at: now, type: 'moved', category: e.category, parent: parent ? parent.category : null, place: e.place, by: round(Math.hypot(now2.cx - e.cx, now2.cz - e.cz), 2) });
            bump(prefs.categories, e.category, 'moved');
            Object.assign(e, { cx: round(now2.cx), cz: round(now2.cz), base: round(now2.base), yaw: now2.yaw, position: n.position });
        } else if (!e.kept) {
            // Left as placed once: a mild yes.
            assetPref(e.asset, 0.25);
            tagPref(tagsOf(index, e.asset), 0.1);
            bump(prefs.categories, e.category, 'kept');
            e.kept = true;
        }
        keep.push(e);
    }

    // New things the user put in the scene: an asset they reached for, and where it went.
    const loggedNodes = new Set(placements.map(p => p.node));
    const added = [];
    for (const n of nodes) {
        if (loggedNodes.has(n.path) || !n.scene || !n.position || !n.path.startsWith(`${CONTAINER}/`)) continue;
        const asset = assetsByPath.get(n.scene);
        if (!asset) continue;
        const shape = shapeOf(asset, asset.category);
        const base = n.position[1] + shape.bottom;
        const [ox, oz] = rotate(shape.center[0], shape.center[1], n.yaw);
        const cx = n.position[0] + ox; const cz = n.position[2] + oz;
        // A swap done by deleting one prop and dropping another in its place.
        const replaced = removed.find(r => r.category === asset.category && Math.hypot(r.cx - cx, r.cz - cz) < 0.6);
        if (replaced) {
            removed.splice(removed.indexOf(replaced), 1);
            assetPref(replaced.asset, -1.5, 'swappedAway');
            assetPref(asset.path, 2, 'swappedIn');
            const before = tagsOf(index, replaced.asset); const after = Object.keys(asset.tags || {});
            tagPref(after.filter(t => !before.includes(t)), 1);
            tagPref(before.filter(t => !after.includes(t)), -1);
            events.push({ at: now, type: 'swapped', category: asset.category, from: replaced.asset, to: asset.path });
        } else {
            assetPref(asset.path, 1, 'added');
            tagPref(Object.keys(asset.tags || {}), 0.3);
            bump(prefs.categories, asset.category, 'added');
        }
        // Standing on something CoDev placed: this kind of thing goes on that kind of surface.
        const surface = [...keep, ...added].find(s => s.size && Math.abs((s.base + s.size[1]) - base) < 0.06
            && Math.abs(toLocal(cx - s.cx, cz - s.cz, s.yaw)[0]) <= s.size[0] / 2 && Math.abs(toLocal(cx - s.cx, cz - s.cz, s.yaw)[1]) <= s.size[2] / 2);
        const entry = {
            scene: scenePath, node: n.path, name: n.name, category: asset.category, asset: asset.path, ...entryShape(shape),
            cx: round(cx), cz: round(cz), base: round(base), yaw: n.yaw, position: n.position, place: surface ? 'on' : (replaced ? replaced.place : 'free'),
            parentNode: surface ? surface.node : replaced ? replaced.parentNode : null, wall: replaced ? replaced.wall : undefined, at: now, byUser: true
        };
        if (surface) {
            prefs.parents[asset.category] = prefs.parents[asset.category] || {};
            prefs.parents[asset.category][surface.category] = (prefs.parents[asset.category][surface.category] || 0) + 1;
            const [lx, lz] = toLocal(cx - surface.cx, cz - surface.cz, surface.yaw);
            const ax = Math.max(0.01, surface.size[0] / 2 - shape.size[0] / 2 - 0.03);
            const az = Math.max(0.01, surface.size[2] / 2 - shape.size[2] / 2 - 0.03);
            pushCapped(prefs.offsets, relationKey(asset.category, surface.category, 'on'), { lx: round(Math.max(-1, Math.min(1, lx / ax))), lz: round(Math.max(-1, Math.min(1, lz / az))), yaw: wrapDeg(n.yaw - surface.yaw) });
            events.push({ at: now, type: 'added_on', category: asset.category, parent: surface.category, asset: asset.path });
        } else if (!replaced) events.push({ at: now, type: 'added', category: asset.category, asset: asset.path });
        added.push(entry);
    }
    for (const e of removed) {
        assetPref(e.asset, -1, 'removed');
        tagPref(tagsOf(index, e.asset), -0.3);
        bump(prefs.categories, e.category, 'removed');
        events.push({ at: now, type: 'removed', category: e.category, asset: e.asset || null });
    }
    prefs.events = [...(prefs.events || []), ...events].slice(-300);
    log.placements = [...others, ...keep, ...added];
    return events;
}

function describeEvents(events) {
    if (!events.length) return 'Nothing changed since CoDev last placed things.';
    const lines = events.map(e => {
        if (e.type === 'moved') return `you moved the ${e.category}${e.parent ? ` (${e.place} the ${e.parent})` : ''}: next time it goes where you put it`;
        if (e.type === 'removed') return `you removed the ${e.category}${e.asset ? ` (${e.asset})` : ''}: used less from now on`;
        if (e.type === 'swapped') return `you swapped the ${e.category} ${e.from} for ${e.to}: preferred next time, with its style`;
        if (e.type === 'added_on') return `you put a ${e.category} on the ${e.parent}: CoDev will put them there too`;
        if (e.type === 'added') return `you added a ${e.category} (${e.asset})`;
        return e.type;
    });
    return `Learned from your edits:\n- ${lines.join('\n- ')}`;
}

function describePrefs(prefs) {
    const out = [];
    const tags = Object.entries(prefs.tags || {}).filter(([, v]) => Math.abs(v) >= 0.5).sort((a, b) => b[1] - a[1]);
    if (tags.length) out.push(`Style: likes ${tags.filter(([, v]) => v > 0).map(([t]) => t).slice(0, 8).join(', ') || 'nothing yet'}; avoids ${tags.filter(([, v]) => v < 0).map(([t]) => t).slice(0, 8).join(', ') || 'nothing yet'}.`);
    const fav = Object.entries(prefs.assets || {}).filter(([, a]) => a.score >= 1.5).sort((a, b) => b[1].score - a[1].score).map(([p]) => p);
    const out2 = Object.entries(prefs.assets || {}).filter(([, a]) => a.score <= -1.5).map(([p]) => p);
    if (fav.length) out.push(`Preferred assets: ${fav.slice(0, 8).join(', ')}.`);
    if (out2.length) out.push(`Avoided assets: ${out2.slice(0, 8).join(', ')}.`);
    const spots = Object.keys(prefs.offsets || {});
    if (spots.length) out.push(`Placements learned from your moves: ${spots.slice(0, 10).map(k => k.replace(/:.*/, '').replace('@', ' on ')).join(', ')}.`);
    const taught = Object.entries(prefs.parents || {}).map(([c, ps]) => `${c} on ${Object.keys(ps).join('/')}`);
    if (taught.length) out.push(`Rules you taught: ${taught.join(', ')}.`);
    const left = Object.entries(prefs.categories || {}).filter(([, c]) => c.removed >= 2 && c.removed > (c.kept || 0) + (c.added || 0)).map(([c]) => c);
    if (left.length) out.push(`Left out unless asked: ${left.join(', ')}.`);
    return out.length ? out.join('\n') : 'Nothing learned yet: move, delete or swap what CoDev places and it adapts.';
}

// ------------------------------------------------------------------ Blender

function blenderScript(placements, room) {
    const items = placements.map(p => ({
        name: p.name, file: p.asset ? p.asset.file : '', size: p.size, position: p.position, yaw: p.yaw, scale: p.shape.scale || 1
    }));
    return `# Made by CoDev's scene_dress. Godot/glTF (x, y up, z) -> Blender (x, -z, z up); yaw about up is the same angle.
import bpy, json, math, os
ITEMS = json.loads(${JSON.stringify(JSON.stringify(items))})
ROOM = ${JSON.stringify(room.size)}
for obj in list(bpy.data.objects):
    if obj.name in ("Cube", "Camera", "Light"):
        bpy.data.objects.remove(obj, do_unlink=True)
root = bpy.data.objects.new("${CONTAINER}", None)
bpy.context.scene.collection.objects.link(root)
for item in ITEMS:
    x, y, z = item["position"]
    holder = bpy.data.objects.new(item["name"], None)
    bpy.context.scene.collection.objects.link(holder)
    holder.parent = root
    if item["file"]:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(CODEV_PROJECT, item["file"]))
        for obj in set(bpy.data.objects) - before:
            if obj.parent is None:
                obj.parent = holder
        holder.scale = (item["scale"],) * 3
    else:
        w, h, d = item["size"]
        bpy.ops.mesh.primitive_cube_add(size=1)
        box = bpy.context.active_object
        box.name = item["name"] + "_placeholder"
        box.scale = (w, d, h)
        box.parent = holder
    holder.location = (x, -z, y)
    holder.rotation_euler = (0, 0, math.radians(item["yaw"]))
`;
}

// ------------------------------------------------------------------ the tools

function createSceneDressing({ getRoot, bridge, log = () => {} }) {
    const root = () => {
        const r = getRoot();
        if (!r || !fs.existsSync(r)) throw new Error('No project folder is set, so there are no assets to dress a scene with.');
        return r;
    };

    async function editorScene() {
        const tree = await bridge('scene_tree', {});
        if (tree.ok === false) throw new Error(`Godot: ${tree.error || 'couldn\'t read the scene.'}`);
        return { scene: tree.scene || '', nodes: sceneNodes(tree), hasGlobals: (tree.nodes || []).some(n => n.global_position !== undefined) };
    }

    // Learns from the open scene when the editor is there; quietly does nothing when it isn't.
    async function learnNow(r, index, { required = false } = {}) {
        let scene;
        try { scene = await editorScene(); } catch (err) { if (required) throw err; return { events: [], scene: null }; }
        const logData = load(r, 'placements.json', { placements: [] });
        const prefs = loadPrefs(r);
        const events = learnFromScene({ nodes: scene.nodes, index, log: logData, prefs, scenePath: scene.scene });
        save(r, 'placements.json', logData);
        save(r, 'preferences.json', prefs);
        return { events, scene, log: logData, prefs };
    }

    async function assets({ action = 'index', query = '', category = '', tags = [], kind = '', limit = 25 } = {}) {
        const r = root();
        const index = refreshIndex(r);
        const models = index.assets.filter(a => a.kind === 'model');
        const textures = index.assets.filter(a => a.kind === 'texture');
        if (action === 'search') {
            const hits = assetIndex.search(index, { query, category, tags, kind, limit: Math.min(Number(limit) || 25, 100) });
            return text(hits.length ? hits.map(assetIndex.summary).join('\n') : `No assets match${query ? ` "${query}"` : ''}${category ? ` in ${category}` : ''}.`);
        }
        const counts = {};
        for (const a of models) counts[a.category] = (counts[a.category] || 0) + 1;
        const lines = [
            `${models.length} model(s) and ${textures.length} texture(s) in ${r} (${index.reread} read just now, the rest unchanged).`,
            models.length ? `By kind: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}.` : 'No .glb or .gltf models yet. Blender can export them (blender_run with an output ending in .glb).',
            ...models.slice(0, Math.min(Number(limit) || 25, 200)).map(assetIndex.summary),
            ...(models.length > limit ? [`...and ${models.length - limit} more (scene_assets action "search" narrows it).`] : []),
            ...(index.errors.length ? [`Couldn't read: ${index.errors.slice(0, 10).join('; ')}`] : [])
        ];
        return text(lines.join('\n'));
    }

    async function dress({ preset = '', items = [], room = {}, style = '', seed, target = 'godot', placeholders = true } = {}) {
        const r = root();
        const index = refreshIndex(r);
        let list = Array.isArray(items) ? items.slice() : [];
        if (preset) {
            const key = String(preset).toLowerCase().replace(/[\s-]+/g, '_');
            if (!PRESETS[key]) return text(`Unknown preset "${preset}". Presets: ${Object.keys(PRESETS).join(', ')}; or pass items.`, true);
            list = [...PRESETS[key], ...list];
        }
        if (!list.length) return text('scene_dress needs a preset (office, bedroom, living_room, dining_room, kitchen) or items, like [{"category": "desk_lamp", "on": "Desk"}].', true);

        // Learn from what the user changed since last time, then build on the scene as it is.
        let learned = { events: [], scene: null };
        const lines = [];
        if (target === 'godot') {
            try { learned = await learnNow(r, index, { required: true }); } catch (err) { return text(err.message, true); }
            if (!learned.scene.scene && !learned.scene.nodes.length) return text('No scene is open in the Godot editor. Open one (godot_editor open_scene) and try again.', true);
            if (!learned.scene.hasGlobals && learned.scene.nodes.length > 1) lines.push('Note: the CoDev Bridge in this project is an older version; godot_install_bridge updates it so nested nodes are measured in world space.');
        }
        const prefs = loadPrefs(r);
        const logData = load(r, 'placements.json', { placements: [] });
        const anchors = learned.scene ? anchorsFrom(learned.scene.nodes, index, logData) : [];
        const result = plan({ index, prefs, items: list, room, style, seed: seed ?? Date.now() % 100000, placeholders: placeholders !== false, anchors });
        if (learned.events.length) lines.push(describeEvents(learned.events));

        if (target === 'godot') {
            const scene = learned.scene;
            if (!scene.nodes.some(n => n.path === CONTAINER)) {
                const made = await bridge('add_node', { parent: '.', type: 'Node3D', name: CONTAINER });
                if (made.ok === false) return text(`Godot: ${made.error}`, true);
            }
            const now = new Date().toISOString();
            const done = [];
            for (const p of result.placements) {
                const properties = { position: p.position, rotation_degrees: [0, p.yaw, 0] };
                let reply;
                if (p.asset) {
                    if ((p.shape.scale || 1) !== 1) properties.scale = [p.shape.scale, p.shape.scale, p.shape.scale];
                    reply = await bridge('instantiate', { path: p.asset.path, parent: CONTAINER, name: p.name, properties });
                } else {
                    reply = await bridge('add_node', { parent: CONTAINER, type: 'CSGBox3D', name: `${p.name}_placeholder`, properties: { ...properties, size: p.size } });
                }
                if (reply.ok === false) { result.skipped.push(`${p.name}: Godot said ${reply.error}`); continue; }
                const nodePath = (reply.node && reply.node.path) || `${CONTAINER}/${p.name}`;
                p.node = nodePath;
                done.push(p);
                logData.placements.push({
                    scene: scene.scene, node: nodePath, name: p.name, category: p.category, asset: p.asset ? p.asset.path : null, placeholder: !p.asset,
                    size: p.size.map(v => round(v)), bottom: round(p.shape.bottom), center: p.shape.center, cx: round(p.cx), cz: round(p.cz), base: round(p.base), yaw: p.yaw,
                    position: p.position, place: p.place, wall: p.wall, parentNode: p.parent ? (p.parent.node || null) : null, at: now
                });
            }
            save(r, 'placements.json', logData);
            prefs.events = [...(prefs.events || []), { at: now, type: 'dressed', count: done.length, preset: preset || null }].slice(-300);
            save(r, 'preferences.json', prefs);
            result.placements = done;
            log(`Dressed ${scene.scene || 'the open scene'} with ${done.length} item(s)`);
        }

        const placeholderCount = result.placements.filter(p => !p.asset).length;
        lines.unshift(`${target === 'godot' ? 'Placed' : 'Planned'} ${result.placements.length} item(s) in a ${result.room.size.join(' x ')} m room${target === 'godot' ? ` under the "${CONTAINER}" node of the open scene (not saved yet: godot_editor save_scene keeps it)` : ''}.`);
        for (const p of result.placements) {
            lines.push(`- ${p.name}: ${p.asset ? p.asset.path : 'gray placeholder box (no such asset in the library)'} ${p.relation}, at [${p.position.join(', ')}], turned ${p.yaw}°${p.asset && p.asset.scale !== 1 ? `, scaled ${p.asset.scale} (it was modeled in ${p.asset.scale === 0.01 ? 'centimeters' : 'millimeters'})` : ''}`);
        }
        if (result.learned.length) lines.push(`Using what it learned: ${result.learned.join('; ')}.`);
        if (result.skipped.length) lines.push(`Skipped:\n- ${result.skipped.join('\n- ')}`);
        if (placeholderCount) lines.push(`${placeholderCount} placeholder(s) stand in for missing assets; put real ones in the project (any .glb) and scene_dress picks them up.`);
        if (target === 'godot') lines.push('Move, delete or swap anything you don\'t like in the editor; CoDev learns from it the next time it dresses a scene (or on scene_learn).');
        if (target === 'blender') {
            lines.push('Blender script (pass it to blender_run with an output such as "scenes/dressed.blend" or "scenes/dressed.glb"):', '```python', blenderScript(result.placements, result.room), '```');
        }
        if (target === 'plan') lines.push('Nothing was changed. target "godot" places it in the open editor; "blender" gives a bpy script for blender_run.');
        return text(lines.join('\n'));
    }

    // Everything standing on a node (by the log and by measurement), deepest first.
    function dependents(nodePath, nodes, index, logData) {
        const anchors = anchorsFrom(nodes, index, logData);
        const target = anchors.find(a => a.node === nodePath);
        const out = [];
        const visit = parentPath => {
            const parent = anchors.find(a => a.node === parentPath);
            for (const a of anchors) {
                if (a.node === parentPath || out.includes(a.node) || a.node === nodePath) continue;
                const entry = (logData.placements || []).find(p => p.node === a.node);
                const byLog = Boolean(entry && entry.parentNode === parentPath && entry.place === 'on');
                const byMeasure = parent && Math.abs(a.base - parent.top) < 0.06
                    && Math.abs(toLocal(a.cx - parent.cx, a.cz - parent.cz, parent.yaw)[0]) <= parent.size[0] / 2 + 0.01
                    && Math.abs(toLocal(a.cx - parent.cx, a.cz - parent.cz, parent.yaw)[1]) <= parent.size[2] / 2 + 0.01;
                if (byLog || byMeasure) { visit(a.node); out.push(a.node); }
            }
        };
        visit(nodePath);
        return { target, list: out };
    }

    async function edit({ action, node, position, rotation_y: rotationY, dry_run: dryRun = false } = {}) {
        if (!['clear', 'remove', 'move'].includes(action)) return text('scene_edit action is clear (take everything off a surface), remove (it and what\'s on it) or move (it and what\'s on it).', true);
        const r = root();
        const index = refreshIndex(r);
        // Learn first, so the user's last edits aren't mistaken for this one.
        const { scene } = await learnNow(r, index, { required: true });
        const logData = load(r, 'placements.json', { placements: [] });
        const real = scene.nodes.find(n => n.path === node) || scene.nodes.find(n => n.name === node) || scene.nodes.find(n => n.path.endsWith(`/${node}`));
        if (!real) return text(`No node "${node}" in the open scene.`, true);
        const { list } = dependents(real.path, scene.nodes, index, logData);
        if (action === 'move') {
            const from = real.position;
            const to = Array.isArray(position) ? position.map(Number) : from;
            const turn = rotationY === undefined ? 0 : wrapDeg(Number(rotationY) - real.yaw);
            const moves = [real.path, ...list].map(p => {
                const n = scene.nodes.find(x => x.path === p);
                const [dx, dz] = rotate(n.position[0] - from[0], n.position[2] - from[2], turn);
                return { node: p, position: [round(to[0] + dx), round(n.position[1] + (to[1] - from[1])), round(to[2] + dz)], yaw: wrapDeg(n.yaw + turn) };
            });
            if (dryRun) return text(`Would move:\n${moves.map(m => `- ${m.node} to [${m.position.join(', ')}], ${m.yaw}°`).join('\n')}`);
            for (const m of moves) {
                // Godot sets local position; CoDev's props sit under a container at the origin.
                await bridge('set_property', { node: m.node, property: 'global_position', value: m.position }).then(rep => rep.ok === false ? bridge('set_property', { node: m.node, property: 'position', value: m.position }) : rep);
                await bridge('set_property', { node: m.node, property: 'rotation_degrees', value: [0, m.yaw, 0] });
                const entry = logData.placements.find(p => p.node === m.node);
                if (entry) {
                    const [ox, oz] = rotate((entry.center || [0, 0])[0], (entry.center || [0, 0])[1], m.yaw);
                    Object.assign(entry, { position: m.position, yaw: m.yaw, cx: round(m.position[0] + ox), cz: round(m.position[2] + oz), base: round(m.position[1] + (entry.bottom || 0)) });
                }
            }
            save(r, 'placements.json', logData);
            return text(`Moved ${real.path}${list.length ? ` and what's on it (${list.join(', ')})` : ''}. godot_editor save_scene keeps it.`);
        }
        const doomed = action === 'remove' ? [...list, real.path] : list;
        if (!doomed.length) return text(`Nothing stands on ${real.path}.`);
        if (dryRun) return text(`Would remove: ${doomed.join(', ')}.`);
        const failed = [];
        for (const p of doomed) {
            const rep = await bridge('remove_node', { node: p });
            if (rep.ok === false) failed.push(`${p} (${rep.error})`);
        }
        // Asked for, not a dislike: these leave the log without counting against them.
        logData.placements = logData.placements.filter(p => !doomed.includes(p.node));
        save(r, 'placements.json', logData);
        return text(`Removed ${doomed.filter(p => !failed.some(f => f.startsWith(p))).join(', ')}${failed.length ? `. Couldn't remove ${failed.join(', ')}` : ''}. godot_editor save_scene keeps it.`, failed.length > 0);
    }

    async function learn({ feedback = [], corrections = [] } = {}) {
        const r = root();
        const previous = load(r, 'assets.json', {});
        const lines = [];
        // Corrections to what an asset is: kept across re-indexing.
        if (Array.isArray(corrections) && corrections.length) {
            previous.overrides = previous.overrides || {};
            for (const c of corrections) {
                const res = String(c.asset || c.path || '').startsWith('res://') ? String(c.asset || c.path) : `res://${String(c.asset || c.path || '').replace(/^\/+/, '')}`;
                const o = previous.overrides[res] || {};
                if (c.category) o.category = String(c.category);
                if (c.scale) o.scale = Number(c.scale);
                if (c.front !== undefined) o.front = Number(c.front);
                if (Array.isArray(c.add_tags)) o.addTags = [...new Set([...(o.addTags || []), ...c.add_tags.map(String)])];
                if (Array.isArray(c.remove_tags)) o.removeTags = [...new Set([...(o.removeTags || []), ...c.remove_tags.map(String)])];
                previous.overrides[res] = o;
                lines.push(`Noted: ${res} is ${[o.category, ...(o.addTags || [])].filter(Boolean).join(', ') || 'corrected'}.`);
            }
            previous.assets = (previous.assets || []).map(a => ({ ...a, mtime: -1 }));
            save(r, 'assets.json', previous);
        }
        const index = refreshIndex(r);
        const result = await learnNow(r, index);
        const prefs = loadPrefs(r);
        if (Array.isArray(feedback) && feedback.length) {
            for (const f of feedback) {
                const sign = /dislike|no|bad|hate|remove|less/i.test(String(f.verdict || '')) ? -1 : 1;
                let res = f.asset ? (String(f.asset).startsWith('res://') ? String(f.asset) : `res://${f.asset}`) : '';
                if (!res && f.node && result.log) res = (result.log.placements.find(p => p.node === f.node || p.name === f.node) || {}).asset || '';
                if (res) {
                    prefs.assets[res] = prefs.assets[res] || { score: 0 };
                    prefs.assets[res].score = round((prefs.assets[res].score || 0) + 2 * sign, 2);
                    for (const t of tagsOf(index, res)) prefs.tags[t] = round((prefs.tags[t] || 0) + 0.5 * sign, 2);
                }
                for (const t of styleTags(f.style || '')) prefs.tags[t] = round((prefs.tags[t] || 0) + 1.5 * sign, 2);
                prefs.events.push({ at: new Date().toISOString(), type: sign > 0 ? 'liked' : 'disliked', asset: res || null, style: f.style || null, note: f.note ? String(f.note).slice(0, 200) : undefined });
            }
            save(r, 'preferences.json', prefs);
            lines.push(`Took in ${feedback.length} piece(s) of feedback.`);
        }
        if (result.scene) lines.push(describeEvents(result.events));
        else lines.push('The Godot editor isn\'t connected, so only the feedback and corrections were taken in.');
        lines.push('', 'What CoDev has learned for this project:', describePrefs(prefs));
        return text(lines.join('\n'));
    }

    const tools = [
        {
            name: 'scene_assets',
            description: 'Scan the project\'s 3D asset library (.glb/.gltf models, .png/.jpg textures) and say what each one is, worked out from the files themselves: its kind (desk, desk_lamp vs floor_lamp, office_chair...), real size in meters (models made in centimeters are spotted and scaled), materials, colors and style (retro, modern, industrial, wood, chrome...). No naming rules or manifests needed. action "index" lists everything (re-reads only changed files); "search" finds assets by words, category or tags. Use it when the user asks what models or textures they have, or before placing a specific one; to furnish a room use scene_dress instead, which picks assets on its own.',
            inputSchema: { type: 'object', properties: {
                action: { type: 'string', enum: ['index', 'search'], description: 'index lists every asset; search finds some (default index).' },
                query: { type: 'string', description: 'search: words like "80s desk lamp" or "dark wood table".' },
                category: { type: 'string', description: 'search: only this kind, like desk_lamp.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'search: style, material or color tags it must have.' },
                kind: { type: 'string', enum: ['model', 'texture'], description: 'Optional: only models or only textures.' },
                limit: { type: 'number', description: 'How many assets to list (default all for index, 20 for search).' }
            } },
            annotations: { readOnlyHint: true }
        },
        {
            name: 'scene_dress',
            description: 'Furnish and arrange a 3D scene from the user\'s own assets with real-world placement rules: desk lamps and monitors stand on the desk\'s top, the office chair is tucked in front of the desk facing it, chairs go around a dining table, nightstands beside the bed\'s head, rugs under tables, pictures on the wall above the sofa. Things never overlap, stay inside the room and leave walkways clear. '
                + 'Assets are chosen to match the style asked for and what the user has shown they like; before each run it learns from what the user moved, deleted or swapped since last time. Kinds missing from the library get gray placeholder boxes (placeholders: false skips them). '
                + 'target "godot" places everything in the open Godot editor under a "Dressing" node (then godot_editor save_scene), building on what the scene already has (an existing desk gets the lamp); "blender" returns a bpy script for blender_run; "plan" only describes it. '
                + `Presets: ${Object.keys(PRESETS).filter(k => !['study', 'living', 'dining'].includes(k)).join(', ')}. Items: categories or {category, on/of (a node name or category), count, asset (res:// path), name, place, optional}. '
                + 'Use it when the user asks to furnish, dress or fill a room or scene; to change one thing already placed use scene_edit instead.`,
            inputSchema: { type: 'object', properties: {
                preset: { type: 'string', description: 'A room to furnish: office, bedroom, living_room, dining_room or kitchen.' },
                items: { type: 'array', items: {}, description: 'Things to place (as well as the preset\'s), e.g. ["desk_lamp", {"category": "book", "count": 3, "on": "shelf"}].' },
                room: { type: 'object', description: 'The room: {size: [width, height, depth] in meters (default [6, 3, 5]), center: [x, y, z] (floor center, default [0, 0, 0])}.' },
                style: { type: 'string', description: 'Style words to prefer, like "80s retro wood" or "modern chrome".' },
                seed: { type: 'number', description: 'The same seed gives the same layout; leave it out for a fresh one.' },
                target: { type: 'string', enum: ['godot', 'blender', 'plan'], description: 'Where it goes: the open Godot editor, a Blender script, or only a plan.' },
                placeholders: { type: 'boolean', description: 'Gray boxes for kinds missing from the library (default true).' }
            } }
        },
        {
            name: 'scene_edit',
            description: 'Edit the open Godot scene the way furniture works: "clear" takes everything off a surface (the desk stays, the lamp, monitor and mug on it go), "remove" removes a node together with everything standing on it, "move" moves a node and carries what\'s on it along (position [x, y, z], rotation_y in degrees). What\'s "on" it comes from what CoDev placed and from measuring the scene. dry_run lists what would change. Use it when the user asks to clear, remove or move furniture in the scene; to add new things use scene_dress instead.',
            inputSchema: { type: 'object', properties: {
                action: { type: 'string', enum: ['clear', 'remove', 'move'], description: 'clear a surface, remove a node, or move it.' },
                node: { type: 'string', description: 'The node\'s path or name, like "Dressing/Desk".' },
                position: { type: 'array', items: { type: 'number' }, description: 'move: the new position [x, y, z] in meters.' },
                rotation_y: { type: 'number', description: 'move: the new turn around the vertical axis, in degrees.' },
                dry_run: { type: 'boolean', description: 'Only list what would change (default false).' }
            }, required: ['action', 'node'] }
        },
        {
            name: 'scene_learn',
            description: 'Learn the user\'s taste for scene dressing. Without arguments it compares the open Godot scene with what CoDev placed (moved, deleted, swapped, newly added props) and says what it learned and what it knows so far. feedback records what the user said ("too cluttered", "more wood", "I like this lamp"): [{asset or node, verdict: like|dislike, style, note}]. corrections fix what an asset is: [{asset, category, add_tags, remove_tags, scale}]. It\'s kept in the project (.codev/scene), so the whole team\'s edits count. Use it when the user says what they like or dislike about a dressed scene, or after they edit one by hand; scene_dress already learns before each run, so don\'t call it just before scene_dress.',
            inputSchema: { type: 'object', properties: {
                feedback: { type: 'array', items: { type: 'object' }, description: 'What the user said: [{asset or node, verdict: like|dislike, style, note}].' },
                corrections: { type: 'array', items: { type: 'object' }, description: 'Fixes to what an asset is: [{asset, category, add_tags, remove_tags, scale}].' }
            } }
        }
    ];

    async function callTool(name, args = {}) {
        try {
            if (name === 'scene_assets') return await assets(args);
            if (name === 'scene_dress') return await dress(args);
            if (name === 'scene_edit') return await edit(args);
            if (name === 'scene_learn') return await learn(args);
            return null;
        } catch (err) {
            return text(err.message || String(err), true);
        }
    }

    return { tools, callTool, names: tools.map(t => t.name) };
}

module.exports = { createSceneDressing, plan, learnFromScene, anchorsFrom, sceneNodes, blenderScript, describePrefs, RULES, PRESETS, DEFAULT_SIZE, emptyPrefs, rotate, toLocal, footprint, overlaps };
