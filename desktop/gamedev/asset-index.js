// The asset index for scene dressing: what each 3D model and texture in the user's
// project actually is, read from the files themselves rather than from folder rules.
//
// For a .glb/.gltf it reads the real geometry (each mesh's POSITION bounds pushed
// through the node transforms, so the size in meters is right even when the file
// was exported in centimeters), the materials (names, base colors, metal/rough) and
// the average color of embedded PNG textures. For a .png/.jpg texture it reads the
// size and, for PNGs, the average color. From those plus every name in the file
// (file, nodes, meshes, materials) it decides:
//   - category: desk, desk_lamp, floor_lamp, office_chair... Size settles what names
//     can't: a "lamp" 0.45 m tall is a desk lamp, 1.6 m tall a floor lamp.
//   - tags: materials (wood, chrome...), era/style (retro, modern, industrial...),
//     color (red, warm, dark, muted...), each with where it came from.
//   - scale: 0.01 when the model is plainly in centimeters, so it's placed real-size.
// The user can correct any of it (overrides), and corrections survive re-indexing.
// Everything is local and free: no model or service is called.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MODEL_EXT = /\.(glb|gltf)$/i;
const TEXTURE_EXT = /\.(png|jpe?g)$/i;
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'venv', '__pycache__', 'addons']);
const MAX_FILES = 3000;
const MAX_MODEL_BYTES = 200 * 1024 * 1024;
const MAX_TEXTURE_BYTES = 40 * 1024 * 1024;

// What things are. words: names that mean it. h: usual height in meters [min, max].
// place: how it's placed by default (see scene-dressing.js RULES). surface: things go on it.
const CATEGORIES = {
    desk: { words: ['desk', 'workstation', 'writing desk', 'bureau', 'computer desk'], h: [0.6, 1.1], kind: 'furniture', surface: true },
    dining_table: { words: ['dining table', 'kitchen table', 'diningtable'], h: [0.65, 0.85], kind: 'furniture', surface: true },
    table: { words: ['table'], h: [0.4, 1.1], kind: 'furniture', surface: true },
    coffee_table: { words: ['coffee table', 'coffeetable', 'low table'], h: [0.25, 0.55], kind: 'furniture', surface: true },
    side_table: { words: ['side table', 'end table', 'sidetable', 'endtable'], h: [0.4, 0.75], kind: 'furniture', surface: true },
    nightstand: { words: ['nightstand', 'night stand', 'bedside', 'night table'], h: [0.4, 0.8], kind: 'furniture', surface: true },
    dresser: { words: ['dresser', 'chest of drawers', 'drawers', 'cabinet', 'sideboard', 'credenza'], h: [0.6, 1.4], kind: 'furniture', surface: true },
    counter: { words: ['counter', 'kitchen counter', 'worktop', 'island'], h: [0.8, 1.0], kind: 'furniture', surface: true },
    tv_stand: { words: ['tv stand', 'tvstand', 'media console', 'tv unit', 'tv bench'], h: [0.3, 0.8], kind: 'furniture', surface: true },
    shelf: { words: ['shelf', 'shelves', 'bookshelf', 'bookcase', 'shelving', 'rack'], h: [0.8, 2.6], kind: 'furniture', surface: true },
    wardrobe: { words: ['wardrobe', 'closet', 'armoire', 'locker'], h: [1.5, 2.6], kind: 'furniture' },
    bed: { words: ['bed', 'mattress', 'bunk'], h: [0.3, 1.6], kind: 'furniture' },
    sofa: { words: ['sofa', 'couch', 'settee', 'loveseat', 'sectional'], h: [0.6, 1.1], kind: 'furniture' },
    armchair: { words: ['armchair', 'arm chair', 'lounge chair', 'recliner', 'easy chair'], h: [0.7, 1.2], kind: 'furniture' },
    office_chair: { words: ['office chair', 'desk chair', 'swivel chair', 'gaming chair', 'task chair', 'officechair'], h: [0.8, 1.4], kind: 'furniture' },
    chair: { words: ['chair', 'seat'], h: [0.7, 1.2], kind: 'furniture' },
    stool: { words: ['stool', 'barstool', 'bar stool', 'ottoman', 'pouf'], h: [0.3, 0.9], kind: 'furniture' },
    bench: { words: ['bench'], h: [0.35, 0.6], kind: 'furniture' },
    desk_lamp: { words: ['desk lamp', 'table lamp', 'desklamp', 'tablelamp', 'reading lamp'], h: [0.15, 0.9], kind: 'lighting' },
    floor_lamp: { words: ['floor lamp', 'floorlamp', 'standing lamp', 'torchiere'], h: [1.0, 2.2], kind: 'lighting' },
    ceiling_lamp: { words: ['ceiling lamp', 'pendant', 'chandelier', 'ceiling light'], h: [0.1, 1.5], kind: 'lighting' },
    lamp: { words: ['lamp', 'light', 'lantern', 'sconce'], h: [0.1, 2.2], kind: 'lighting' },
    monitor: { words: ['monitor', 'screen', 'display', 'computer', 'pc', 'imac', 'crt'], h: [0.2, 0.7], kind: 'prop' },
    laptop: { words: ['laptop', 'notebook computer', 'macbook'], h: [0.01, 0.35], kind: 'prop' },
    keyboard: { words: ['keyboard'], h: [0.01, 0.08], kind: 'prop' },
    tv: { words: ['tv', 'television', 'telly'], h: [0.3, 1.4], kind: 'prop' },
    book: { words: ['book', 'books', 'novel', 'magazine', 'binder'], h: [0.01, 0.45], kind: 'prop' },
    mug: { words: ['mug', 'cup', 'coffee', 'teacup', 'glass', 'tumbler'], h: [0.04, 0.2], kind: 'prop' },
    plate: { words: ['plate', 'dish', 'bowl', 'tray'], h: [0.01, 0.15], kind: 'prop' },
    bottle: { words: ['bottle', 'jar', 'flask', 'can'], h: [0.08, 0.4], kind: 'prop' },
    vase: { words: ['vase', 'urn', 'pot'], h: [0.1, 0.8], kind: 'decor' },
    plant: { words: ['plant', 'tree', 'ficus', 'fern', 'monstera', 'cactus', 'succulent', 'bonsai', 'palm', 'flower', 'flowers', 'houseplant'], h: [0.05, 2.5], kind: 'decor' },
    clock: { words: ['clock'], h: [0.1, 2.2], kind: 'decor' },
    picture: { words: ['picture', 'painting', 'poster', 'frame', 'artwork', 'canvas', 'photo', 'mirror'], h: [0.15, 1.5], kind: 'decor', wall: true },
    rug: { words: ['rug', 'carpet', 'mat', 'runner'], h: [0, 0.05], kind: 'decor' },
    curtain: { words: ['curtain', 'curtains', 'drape', 'blinds'], h: [1, 3], kind: 'decor', wall: true },
    trash_bin: { words: ['trash', 'bin', 'wastebasket', 'garbage', 'rubbish', 'trashcan'], h: [0.2, 0.8], kind: 'prop' },
    pillow: { words: ['pillow', 'cushion'], h: [0.05, 0.5], kind: 'decor' },
    box: { words: ['box', 'crate', 'carton', 'chest', 'barrel', 'case'], h: [0.1, 1.2], kind: 'prop' },
    phone: { words: ['phone', 'telephone', 'smartphone'], h: [0.01, 0.25], kind: 'prop' },
    candle: { words: ['candle', 'candles', 'candlestick'], h: [0.03, 0.4], kind: 'decor' },
    speaker: { words: ['speaker', 'radio', 'stereo', 'boombox', 'turntable', 'record player'], h: [0.1, 1.2], kind: 'prop' },
    fridge: { words: ['fridge', 'refrigerator'], h: [1.2, 2.2], kind: 'furniture' },
    stove: { words: ['stove', 'oven', 'range', 'cooker'], h: [0.8, 1.2], kind: 'furniture' },
    sink: { words: ['sink', 'basin'], h: [0.1, 1.1], kind: 'furniture' },
    door: { words: ['door', 'doorway'], h: [1.8, 2.6], kind: 'structure' },
    window: { words: ['window'], h: [0.5, 2.5], kind: 'structure' }
};

// Words in names that say the style or era.
const STYLE_WORDS = {
    retro: ['retro', '80s', '1980s', '70s', '1970s', '60s', '1960s', '90s', 'eighties', 'seventies', 'vaporwave', 'synthwave', 'mcm', 'midcentury', 'mid century', 'atomic'],
    vintage: ['vintage', 'antique', 'old', 'classic', 'victorian', 'baroque', 'art deco', 'deco', 'colonial', 'ornate', 'aged', 'worn'],
    modern: ['modern', 'contemporary', 'sleek', 'minimal', 'minimalist', 'scandi', 'scandinavian', 'nordic', 'ikea', 'bauhaus'],
    industrial: ['industrial', 'loft', 'factory', 'pipe', 'rusty', 'rust', 'steampunk', 'warehouse', 'workshop'],
    rustic: ['rustic', 'farmhouse', 'cabin', 'log', 'reclaimed', 'country', 'barn'],
    scifi: ['scifi', 'sci fi', 'futuristic', 'cyber', 'cyberpunk', 'neon', 'space', 'hologram', 'tech'],
    fantasy: ['fantasy', 'medieval', 'gothic', 'dungeon', 'castle', 'tavern', 'elven', 'dwarven', 'magic'],
    office: ['office', 'corporate', 'cubicle'],
    cozy: ['cozy', 'cosy', 'soft', 'plush', 'fluffy'],
    damaged: ['broken', 'damaged', 'destroyed', 'ruined', 'dirty', 'abandoned', 'cracked']
};

const MATERIAL_WORDS = {
    wood: ['wood', 'wooden', 'oak', 'walnut', 'pine', 'birch', 'maple', 'teak', 'mahogany', 'cherry', 'plywood', 'timber', 'bamboo'],
    metal: ['metal', 'steel', 'iron', 'aluminium', 'aluminum', 'tin'],
    chrome: ['chrome', 'chromed', 'polished', 'stainless'],
    brass: ['brass', 'bronze', 'copper', 'gold', 'golden'],
    glass: ['glass', 'crystal', 'acrylic', 'transparent'],
    plastic: ['plastic', 'pvc', 'vinyl', 'formica', 'laminate'],
    fabric: ['fabric', 'cloth', 'velvet', 'linen', 'cotton', 'wool', 'upholstery', 'textile', 'felt', 'tweed', 'corduroy'],
    leather: ['leather', 'suede'],
    stone: ['stone', 'marble', 'granite', 'concrete', 'brick', 'terrazzo', 'slate', 'ceramic', 'porcelain', 'tile'],
    paper: ['paper', 'cardboard']
};

// Named colors for "what color is it", in linear-ish sRGB 0..1.
const COLOR_NAMES = [
    ['black', [0.05, 0.05, 0.05]], ['white', [0.95, 0.95, 0.95]], ['gray', [0.5, 0.5, 0.5]],
    ['red', [0.75, 0.12, 0.12]], ['orange', [0.9, 0.5, 0.12]], ['yellow', [0.92, 0.85, 0.2]],
    ['green', [0.2, 0.6, 0.25]], ['teal', [0.1, 0.55, 0.55]], ['blue', [0.15, 0.3, 0.75]],
    ['purple', [0.5, 0.2, 0.65]], ['pink', [0.92, 0.5, 0.65]], ['brown', [0.45, 0.28, 0.15]],
    ['beige', [0.85, 0.77, 0.62]], ['cream', [0.95, 0.92, 0.82]]
];

// ------------------------------------------------------------------ names

// "SM_DeskLamp_80s-01.glb" -> ['sm', 'desk', 'lamp', '80s', '01']
function tokens(textValue) {
    return String(textValue || '')
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z])(\d)/gi, (m, a, b) => (/\d0s$/.test(m) ? m : `${a} ${b}`))
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

// Whether a phrase ("desk lamp") appears in the token list, as whole words.
function hasPhrase(list, phrase) {
    const words = phrase.split(' ');
    const joined = phrase.replace(/ /g, '');
    for (let i = 0; i < list.length; i++) {
        if (list[i] === joined) return true;
        if (words.every((w, j) => list[i + j] === w || list[i + j] === `${w}s`)) return true;
        if (words.length === 1 && list[i] === `${words[0]}s`) return true;
    }
    return false;
}

// ------------------------------------------------------------------ color

function srgbLin(c) { return c; }

function nearestColor(rgb) {
    let best = 'gray';
    let bestD = Infinity;
    for (const [name, c] of COLOR_NAMES) {
        const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
        if (d < bestD) { bestD = d; best = name; }
    }
    return best;
}

// Tags describing a color: its name, light/dark, warm/cool, muted/vivid.
function colorTags(rgb) {
    const [r, g, b] = rgb.map(srgbLin);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 2;
    const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1) || 1);
    const out = [nearestColor(rgb)];
    if (light < 0.25) out.push('dark'); else if (light > 0.72) out.push('light');
    if (sat < 0.18) out.push('muted'); else if (sat > 0.55 && light > 0.2 && light < 0.85) out.push('vivid');
    if (sat >= 0.12) {
        if (r > b + 0.06) out.push('warm'); else if (b > r + 0.06) out.push('cool');
    }
    return [...new Set(out)];
}

function hex(rgb) { return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join(''); }

// ------------------------------------------------------------------ images

// The average color of an 8-bit PNG (any color type, not interlaced) and its size.
// Big images are sampled every few rows and columns; every row is still unfiltered,
// since each row's filter depends on the row before.
function pngInfo(buffer) {
    if (buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
    let offset = 8;
    let width = 0; let height = 0; let depth = 0; let type = 0; let interlace = 0;
    let palette = null;
    const idat = [];
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const kind = buffer.toString('latin1', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
        else if (kind === 'PLTE') palette = data;
        else if (kind === 'IDAT') idat.push(data);
        else if (kind === 'IEND') break;
        offset += 12 + length;
    }
    const info = { width, height };
    if (depth !== 8 || interlace || !idat.length || width * height > 64e6) return info;
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    if (!channels || (type === 3 && !palette)) return info;
    let raw;
    try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return info; }
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return info;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
    let prev = Buffer.alloc(stride);
    let row = Buffer.alloc(stride);
    const sum = [0, 0, 0];
    let count = 0;
    let alphaSum = 0;
    for (let y = 0; y < height; y++) {
        const start = y * (stride + 1);
        const filter = raw[start];
        for (let x = 0; x < stride; x++) {
            const value = raw[start + 1 + x];
            const left = x >= channels ? row[x - channels] : 0;
            const up = prev[x];
            const upLeft = x >= channels ? prev[x - channels] : 0;
            let out = value;
            if (filter === 1) out = value + left;
            else if (filter === 2) out = value + up;
            else if (filter === 3) out = value + ((left + up) >> 1);
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft);
                out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
            }
            row[x] = out & 255;
        }
        if (y % step === 0) {
            for (let x = 0; x < width; x += step) {
                const i = x * channels;
                let r; let g; let b; let a = 255;
                if (type === 0) { r = g = b = row[i]; }
                else if (type === 4) { r = g = b = row[i]; a = row[i + 1]; }
                else if (type === 3) { const p = row[i] * 3; r = palette[p]; g = palette[p + 1]; b = palette[p + 2]; }
                else { r = row[i]; g = row[i + 1]; b = row[i + 2]; if (type === 6) a = row[i + 3]; }
                if (a < 16) continue;
                sum[0] += r; sum[1] += g; sum[2] += b; alphaSum += a; count++;
            }
        }
        [prev, row] = [row, prev];
    }
    if (count) {
        info.color = sum.map(v => v / count / 255);
        info.alpha = alphaSum / count / 255;
    }
    return info;
}

// The size of a JPEG from its first frame header (colors would need a full decoder).
function jpegInfo(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
    }
    return null;
}

// ------------------------------------------------------------------ glTF

function readGltf(file) {
    const buffer = fs.readFileSync(file);
    if (buffer.length >= 20 && buffer.toString('latin1', 0, 4) === 'glTF') {
        let offset = 12;
        let json = null;
        let bin = null;
        while (offset + 8 <= buffer.length) {
            const length = buffer.readUInt32LE(offset);
            const type = buffer.readUInt32LE(offset + 4);
            const chunk = buffer.subarray(offset + 8, offset + 8 + length);
            if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8').replace(/[\u0000\s]+$/, ''));
            else if (type === 0x004e4942) bin = chunk;
            offset += 8 + length;
        }
        if (!json) throw new Error('no JSON chunk');
        return { json, buffers: [bin] };
    }
    const json = JSON.parse(buffer.toString('utf8'));
    const buffers = (json.buffers || []).map(b => {
        const uri = String(b.uri || '');
        if (uri.startsWith('data:')) return Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
        const target = path.resolve(path.dirname(file), decodeURIComponent(uri));
        try { return target.startsWith(path.dirname(file)) ? fs.readFileSync(target) : null; } catch { return null; }
    });
    return { json, buffers };
}

function bufferViewBytes(gltf, index) {
    const view = (gltf.json.bufferViews || [])[index];
    if (!view) return null;
    const buffer = gltf.buffers[view.buffer || 0];
    if (!buffer) return null;
    return buffer.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
}

// 4x4 column-major matrices, as glTF stores them.
function identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = s;
    }
    return out;
}
function trs(node) {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale || [1, 1, 1];
    return [
        (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
        (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
        (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1
    ];
}
function apply(m, p) {
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

// The model's bounds in its own space (glTF: meters, +Y up, front +Z), through every node.
function gltfBounds(json) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const nodes = json.nodes || [];
    const scene = (json.scenes || [])[json.scene || 0];
    const roots = scene ? scene.nodes || [] : nodes.map((_, i) => i);
    const seen = new Set();
    const visit = (index, parent) => {
        const node = nodes[index];
        if (!node || seen.has(index)) return;
        seen.add(index);
        const m = multiply(parent, trs(node));
        const mesh = node.mesh !== undefined ? (json.meshes || [])[node.mesh] : null;
        for (const prim of (mesh && mesh.primitives) || []) {
            const acc = (json.accessors || [])[prim.attributes && prim.attributes.POSITION];
            if (!acc || !Array.isArray(acc.min) || !Array.isArray(acc.max)) continue;
            for (let i = 0; i < 8; i++) {
                const p = apply(m, [i & 1 ? acc.max[0] : acc.min[0], i & 2 ? acc.max[1] : acc.min[1], i & 4 ? acc.max[2] : acc.min[2]]);
                for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
            }
        }
        for (const child of node.children || []) visit(child, m);
    };
    for (const r of roots) visit(r, identity());
    if (!Number.isFinite(min[0])) return null;
    return { min, max, size: max.map((v, k) => v - min[k]) };
}

function describeGltf(file) {
    const gltf = readGltf(file);
    const { json } = gltf;
    const names = [];
    for (const list of [json.nodes, json.meshes, json.scenes]) for (const item of list || []) if (item && item.name) names.push(item.name);
    const materials = (json.materials || []).map(m => {
        const pbr = m.pbrMetallicRoughness || {};
        return { name: m.name || '', color: Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor.slice(0, 3) : null, metallic: pbr.metallicFactor ?? 1, roughness: pbr.roughnessFactor ?? 1, texture: pbr.baseColorTexture ? pbr.baseColorTexture.index : null };
    });
    // Colors of embedded PNG base color textures, tinted by the factor.
    for (const m of materials) {
        if (m.texture === null || m.texture === undefined) continue;
        const tex = (json.textures || [])[m.texture];
        const image = tex && (json.images || [])[tex.source];
        let bytes = null;
        if (image && image.bufferView !== undefined) bytes = bufferViewBytes(gltf, image.bufferView);
        else if (image && /^data:image\/png;base64,/.test(image.uri || '')) bytes = Buffer.from(image.uri.split(',')[1], 'base64');
        else if (image && image.uri && /\.png$/i.test(image.uri)) {
            const target = path.resolve(path.dirname(file), decodeURIComponent(image.uri));
            if (target.startsWith(path.dirname(file))) try { bytes = fs.readFileSync(target); } catch { /* missing texture */ }
        }
        const info = bytes ? pngInfo(bytes) : null;
        if (info && info.color) m.textureColor = info.color.map((v, k) => v * (m.color ? m.color[k] : 1));
    }
    let triangles = 0;
    for (const mesh of json.meshes || []) for (const prim of mesh.primitives || []) {
        const acc = prim.indices !== undefined ? (json.accessors || [])[prim.indices] : (json.accessors || [])[prim.attributes && prim.attributes.POSITION];
        if (acc && acc.count) triangles += Math.floor(acc.count / 3);
    }
    return { names, materials, bounds: gltfBounds(json), triangles, animations: (json.animations || []).length };
}

// ------------------------------------------------------------------ classifying

function scoreCategories(nameTokens, otherTokens, height) {
    const scores = {};
    const phrases = {};
    for (const [cat, def] of Object.entries(CATEGORIES)) {
        let s = 0;
        for (const w of def.words) {
            const weight = w.includes(' ') ? 1.5 : 1;
            const hit = hasPhrase(nameTokens, w) ? 3 * weight : hasPhrase(otherTokens, w) ? 1.5 * weight : 0;
            if (hit > s) { s = hit; phrases[cat] = w; }
        }
        if (!s) continue;
        if (height !== null && height !== undefined) {
            const [lo, hi] = def.h;
            if (height >= lo && height <= hi) s += 1.5;
            else {
                const off = height < lo ? (lo - height) / Math.max(lo, 0.05) : (height - hi) / hi;
                s -= Math.min(4, 1 + off * 3);
            }
        }
        scores[cat] = s;
    }
    // A more specific name anywhere in the file refines a generic one: a "chair" whose
    // mesh is called "Office chair" is an office chair.
    for (const [cat, phrase] of Object.entries(phrases)) {
        if (!phrase.includes(' ') || scores[cat] <= 0) continue;
        const last = phrase.split(' ').pop();
        for (const [other, p] of Object.entries(phrases)) {
            if (other !== cat && !p.includes(' ') && (p === last || `${p}s` === last) && scores[other] >= scores[cat]) scores[cat] = scores[other] + 0.5;
        }
    }
    return scores;
}

// Lamps, chairs and tables named only generically get their kind from their size.
function refine(category, size) {
    if (!size) return category;
    const [w, h, d] = size;
    const foot = Math.max(w, d);
    if (category === 'lamp') return h >= 1.0 ? 'floor_lamp' : h <= 0.9 ? 'desk_lamp' : 'lamp';
    if (category === 'table') {
        if (h <= 0.55 && foot >= 0.6) return 'coffee_table';
        if (h <= 0.75 && foot < 0.6) return 'side_table';
        if (foot >= 1.4 && h >= 0.65) return 'dining_table';
    }
    if (category === 'chair' && Math.min(w, d) >= 0.75 && h < 1.1) return 'armchair';
    if (category === 'plant' && h < 0.5) return 'plant_small';
    return category;
}
CATEGORIES.plant_small = { words: [], h: [0.05, 0.5], kind: 'decor' };

// A model in centimeters (or millimeters) shows itself by its size: a 140-"meter" desk.
function unitScale(category, size) {
    if (!size) return 1;
    const tallest = Math.max(...size);
    const def = CATEGORIES[category];
    const limit = def ? Math.max(def.h[1], 1) * 6 : 12;
    if (tallest > limit * 100) return 0.001;
    if (tallest > limit && tallest / 100 <= limit) return 0.01;
    return 1;
}

function classify({ file, names = [], materials = [], size = null, kind = 'model' }) {
    const nameTokens = tokens(path.basename(file));
    const folderTokens = tokens(path.dirname(file).split(/[\\/]/).slice(-2).join(' '));
    const otherTokens = [...names.flatMap(tokens), ...folderTokens];
    const materialTokens = materials.flatMap(m => tokens(m.name));
    const all = [...nameTokens, ...otherTokens, ...materialTokens];
    const tags = {};
    const tag = (t, source) => { if (!tags[t]) tags[t] = source; };

    let category = kind === 'texture' ? 'texture' : 'unknown';
    let confidence = 0;
    let scale = 1;
    let realSize = size;
    if (kind === 'model') {
        // First pass without size to guess units; then score with the real height.
        const loose = scoreCategories(nameTokens, otherTokens, null);
        const guess = Object.entries(loose).sort((a, b) => b[1] - a[1])[0];
        scale = unitScale(guess ? guess[0] : null, size);
        realSize = size ? size.map(v => +(v * scale).toFixed(4)) : null;
        const scores = scoreCategories(nameTokens, otherTokens, realSize ? realSize[1] : null);
        const best = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        if (best.length && best[0][1] > 0) {
            category = refine(best[0][0], realSize);
            confidence = Math.min(1, best[0][1] / 6);
        } else if (realSize) {
            // No name to go on: say what the size suggests, with low confidence.
            const [w, h, d] = realSize;
            category = h < 0.5 && Math.max(w, d) < 0.5 ? 'small_prop' : h > 1.6 ? 'tall_object' : Math.max(w, d) > 1.2 ? 'large_object' : 'medium_object';
            confidence = 0.1;
        }
    }

    for (const [style, words] of Object.entries(STYLE_WORDS)) {
        if (words.some(w => hasPhrase(all, w))) tag(style, 'name');
    }
    for (const [mat, words] of Object.entries(MATERIAL_WORDS)) {
        if (words.some(w => hasPhrase(materialTokens, w))) tag(mat, 'material');
        else if (words.some(w => hasPhrase([...nameTokens, ...otherTokens], w))) tag(mat, 'name');
    }
    // What the surfaces look like: shiny metal, the colors weighted toward textures.
    const colors = materials.map(m => m.textureColor || m.color).filter(Boolean);
    let average = null;
    if (colors.length) {
        average = [0, 1, 2].map(k => colors.reduce((s, c) => s + c[k], 0) / colors.length);
        for (const t of colorTags(average)) tag(t, 'color');
    }
    if (materials.some(m => m.metallic >= 0.8 && m.roughness <= 0.3)) tag('chrome', tags.chrome || 'shiny metal');
    else if (materials.some(m => m.metallic >= 0.7)) tag('metal', tags.metal || 'metallic material');
    // Style read from materials when the names don't say it.
    const has = t => Boolean(tags[t]);
    if (!has('modern') && !has('retro') && !has('vintage') && !has('industrial') && !has('rustic')) {
        if (has('chrome') && (has('glass') || has('white') || has('black'))) tag('modern', 'chrome with glass/white/black');
        else if (has('metal') && (has('stone') || has('dark') || has('gray'))) tag('industrial', 'dark metal');
        else if (has('brass') && (has('wood') || has('dark'))) tag('vintage', 'brass and wood');
        else if (has('wood') && has('muted') && !has('vivid')) tag('rustic', 'plain wood');
        else if ((has('orange') || has('brown') || has('yellow') || has('teal')) && has('plastic')) tag('retro', 'colored plastic');
    }
    return { category, confidence: +confidence.toFixed(2), scale, size: realSize, color: average ? hex(average) : null, tags };
}

// ------------------------------------------------------------------ the index

function walk(root, out = []) {
    const queue = [root];
    while (queue.length && out.length < MAX_FILES) {
        const dir = queue.shift();
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) queue.push(full);
            else if (MODEL_EXT.test(e.name) || TEXTURE_EXT.test(e.name)) out.push(full);
            if (out.length >= MAX_FILES) break;
        }
    }
    return out;
}

function resPath(root, file) { return 'res://' + path.relative(root, file).split(path.sep).join('/'); }

function describeFile(root, file) {
    const stat = fs.statSync(file);
    const rel = resPath(root, file);
    const base = { path: rel, file: path.relative(root, file).split(path.sep).join('/'), bytes: stat.size, mtime: Math.round(stat.mtimeMs) };
    if (MODEL_EXT.test(file)) {
        if (stat.size > MAX_MODEL_BYTES) return { ...base, kind: 'model', category: 'unknown', tags: {}, error: 'too big to read' };
        const info = describeGltf(file);
        const size = info.bounds ? info.bounds.size.map(v => +v.toFixed(4)) : null;
        const c = classify({ file: rel, names: info.names, materials: info.materials, size, kind: 'model' });
        return {
            ...base, kind: 'model', ...c, rawSize: size,
            // Where the model's own origin sits in its bounds, in meters after scale (to put its bottom on a surface).
            bottom: info.bounds ? +(info.bounds.min[1] * c.scale).toFixed(4) : 0,
            center: info.bounds ? [0, 2].map(k => +(((info.bounds.min[k] + info.bounds.max[k]) / 2) * c.scale).toFixed(4)) : [0, 0],
            materials: info.materials.map(m => m.name).filter(Boolean).slice(0, 12),
            names: [...new Set(info.names)].slice(0, 12), triangles: info.triangles, animations: info.animations
        };
    }
    if (stat.size > MAX_TEXTURE_BYTES) return { ...base, kind: 'texture', category: 'texture', tags: {} };
    const bytes = fs.readFileSync(file);
    const info = (/\.png$/i.test(file) ? pngInfo(bytes) : jpegInfo(bytes)) || {};
    const c = classify({ file: rel, materials: info.color ? [{ name: path.basename(file), color: info.color, metallic: 0, roughness: 1 }] : [], kind: 'texture' });
    // Textures: what surface they're for ("wood", "brick") comes from the name; the map type too.
    const t = tokens(path.basename(file));
    const map = ['normal', 'roughness', 'metallic', 'metalness', 'ao', 'occlusion', 'height', 'displacement', 'emission', 'opacity', 'albedo', 'diffuse', 'basecolor', 'color', 'nrm', 'rough', 'disp']
        .find(w => t.includes(w)) || '';
    if (map && !['albedo', 'diffuse', 'basecolor', 'color'].includes(map)) {
        // A normal or roughness map's color says nothing about how the surface looks.
        for (const key of Object.keys(c.tags)) if (c.tags[key] === 'color') delete c.tags[key];
        c.color = null;
    }
    return { ...base, kind: 'texture', category: 'texture', map: map || 'color', width: info.width || 0, height: info.height || 0, color: c.color, tags: c.tags };
}

// Re-reads only files that changed since the last index; keeps the user's corrections.
function buildIndex(root, previous = {}) {
    const old = new Map((previous.assets || []).map(a => [a.path, a]));
    const overrides = previous.overrides || {};
    const assets = [];
    const errors = [];
    let reread = 0;
    for (const file of walk(root)) {
        const rel = resPath(root, file);
        let stat;
        try { stat = fs.statSync(file); } catch { continue; }
        const prior = old.get(rel);
        let entry = prior && prior.mtime === Math.round(stat.mtimeMs) && prior.bytes === stat.size && !prior.error ? prior : null;
        if (!entry) {
            try { entry = describeFile(root, file); reread++; } catch (err) { errors.push(`${rel}: ${err.message}`); continue; }
        }
        assets.push(withOverrides(entry, overrides[rel]));
    }
    return { root, at: new Date().toISOString(), assets, overrides, reread, errors };
}

function withOverrides(entry, override) {
    if (!override) return entry;
    const out = { ...entry, tags: { ...entry.tags } };
    if (override.category) { out.category = override.category; out.confidence = 1; }
    if (override.scale) {
        const ratio = override.scale / (entry.scale || 1);
        out.scale = override.scale;
        if (entry.size) out.size = entry.size.map(v => +(v * ratio).toFixed(4));
        if (entry.center) out.center = entry.center.map(v => +(v * ratio).toFixed(4));
        if (entry.bottom) out.bottom = +(entry.bottom * ratio).toFixed(4);
    }
    if (override.front !== undefined) out.front = override.front;
    for (const t of override.addTags || []) out.tags[t] = 'you';
    for (const t of override.removeTags || []) delete out.tags[t];
    out.corrected = true;
    return out;
}

// Assets matching words, a category and tags, best first.
function search(index, { query = '', category = '', tags = [], kind = '', limit = 20 } = {}) {
    const q = tokens(query);
    const wanted = (Array.isArray(tags) ? tags : [tags]).map(t => String(t).toLowerCase()).filter(Boolean);
    const results = [];
    for (const a of index.assets || []) {
        if (kind && a.kind !== kind) continue;
        if (category && a.category !== category && !(CATEGORIES[category] && a.category.startsWith(category))) continue;
        let score = category ? 2 : 0;
        const words = [...tokens(a.file), a.category, ...a.category.split('_'), ...Object.keys(a.tags || {}), ...(a.names || []).flatMap(tokens), ...(a.materials || []).flatMap(tokens)];
        for (const w of q) {
            if (a.category === w || a.category.split('_').includes(w)) score += 3;
            else if (a.tags && a.tags[w]) score += 2;
            else if (words.includes(w) || words.includes(w.replace(/s$/, ''))) score += 1;
        }
        for (const t of wanted) score += a.tags && a.tags[t] ? 2 : -1;
        if (q.length && score <= (category ? 2 : 0)) continue;
        if (wanted.length && !wanted.some(t => a.tags && a.tags[t])) continue;
        results.push({ asset: a, score });
    }
    return results.sort((x, y) => y.score - x.score || x.asset.path.localeCompare(y.asset.path)).slice(0, limit).map(r => r.asset);
}

// Words and the tags they stand for, as the index names them ("walnut" is wood, "80s" retro).
function tagWords(value) {
    const list = tokens(value);
    const out = new Set(list);
    for (const groups of [STYLE_WORDS, MATERIAL_WORDS]) {
        for (const [tag, words] of Object.entries(groups)) if (words.some(w => hasPhrase(list, w))) out.add(tag);
    }
    for (const [name] of COLOR_NAMES) if (list.includes(name)) out.add(name);
    return [...out];
}

function summary(a) {
    const size = a.size ? `${a.size.map(v => v.toFixed(2)).join(' x ')} m` : a.width ? `${a.width}x${a.height}px` : '';
    const tagList = Object.keys(a.tags || {}).join(', ');
    return `${a.path}: ${a.category}${a.confidence !== undefined && a.kind === 'model' ? ` (${Math.round(a.confidence * 100)}%)` : ''}${size ? `, ${size}` : ''}${a.scale && a.scale !== 1 ? `, in ${a.scale === 0.01 ? 'centimeters' : 'millimeters'} (scaled ${a.scale})` : ''}${a.map && a.map !== 'color' ? `, ${a.map} map` : ''}${tagList ? `; ${tagList}` : ''}${a.color ? `; color ${a.color}` : ''}${a.corrected ? ' [corrected by you]' : ''}`;
}

module.exports = { CATEGORIES, tokens, tagWords, hasPhrase, colorTags, pngInfo, jpegInfo, readGltf, describeGltf, gltfBounds, classify, buildIndex, withOverrides, search, summary };
