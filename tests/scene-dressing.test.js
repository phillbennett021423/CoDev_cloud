// Scene dressing (desktop/gamedev/asset-index.js and scene-dressing.js): reading real
// .glb files and textures into an asset index, the placement rules, applying a layout in
// a stand-in Godot editor, learning from the user's moves, deletes and swaps, clearing
// and moving surfaces with what's on them, and the Blender script.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const assetIndex = require('../desktop/gamedev/asset-index');
const dressing = require('../desktop/gamedev/scene-dressing');
const { createGameDevService } = require('../desktop/gamedev');

function textOf(result) { return result.content.map(c => c.text).join('\n'); }

function png(width, height, rgba) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
    const rows = [];
    for (let y = 0; y < height; y++) {
        // Alternate filters so the decoder's unfiltering is exercised.
        const filter = y % 3;
        const row = Buffer.alloc(width * 4);
        for (let x = 0; x < width; x++) rgba.forEach((v, k) => { row[x * 4 + k] = v; });
        const out = Buffer.alloc(width * 4);
        for (let i = 0; i < out.length; i++) {
            const left = i >= 4 ? row[i - 4] : 0;
            const up = y ? row[i] : 0; // every row is the same color
            out[i] = (row[i] - (filter === 1 ? left : filter === 2 ? up : 0)) & 255;
        }
        rows.push(Buffer.from([filter]), out);
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// A .glb with one box mesh of the given size (bottom at y=0), a material and optionally an embedded PNG.
function glb({ size, nodeName = 'Mesh', material = {}, texture = null, nodeScale = null }) {
    const [w, h, d] = size;
    let bin = Buffer.alloc(96);
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
        nodes: [{ name: nodeName, mesh: 0, ...(nodeScale ? { scale: nodeScale } : {}) }],
        meshes: [{ name: `${nodeName}_mesh`, primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96 }],
        materials: [{ name: material.name || 'Material', pbrMetallicRoughness: { baseColorFactor: [...(material.color || [0.8, 0.8, 0.8]), 1], metallicFactor: material.metallic ?? 0, roughnessFactor: material.roughness ?? 0.8 } }]
    };
    if (texture) {
        const start = bin.length;
        bin = Buffer.concat([bin, texture, Buffer.alloc((4 - (texture.length % 4)) % 4)]);
        json.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: texture.length });
        json.images = [{ bufferView: 1, mimeType: 'image/png' }];
        json.textures = [{ source: 0 }];
        json.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
    }
    json.buffers = [{ byteLength: bin.length }];
    let jsonBuf = Buffer.from(JSON.stringify(json));
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'latin1'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const c0 = Buffer.alloc(8); c0.writeUInt32LE(jsonBuf.length, 0); c0.writeUInt32LE(0x4e4f534a, 4);
    const c1 = Buffer.alloc(8); c1.writeUInt32LE(bin.length, 0); c1.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, c0, jsonBuf, c1, bin]);
}

function library() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-dress-'));
    fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n');
    const put = (rel, buf) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), buf); };
    // Exported in centimeters, named only "SM_Desk_01".
    put('assets/SM_Desk_01.glb', glb({ size: [140, 75, 70], nodeName: 'Desk', material: { name: 'Oak_Wood', color: [0.55, 0.36, 0.2] } }));
    // Two "lamps" told apart by height alone; one retro by name with an orange plastic texture.
    put('assets/lamp_80s.glb', glb({ size: [0.2, 0.45, 0.2], nodeName: 'Lamp', material: { name: 'Plastic' }, texture: png(8, 8, [230, 120, 30, 255]) }));
    put('assets/lamp_tall.glb', glb({ size: [0.4, 1.6, 0.4], nodeName: 'Lamp', material: { name: 'Chrome', color: [0.9, 0.9, 0.9], metallic: 1, roughness: 0.1 } }));
    put('assets/OfficeChair.glb', glb({ size: [0.6, 1.0, 0.6], nodeName: 'Chair' }));
    put('assets/chair_wood.glb', glb({ size: [0.6, 1.0, 0.6], nodeName: 'Office chair', material: { name: 'Walnut' } }));
    put('assets/monitor.glb', glb({ size: [0.55, 0.4, 0.2], nodeName: 'Screen' }));
    put('assets/potted_fern.glb', glb({ size: [0.5, 1.2, 0.5], nodeName: 'Fern' }));
    put('textures/brick_wall_albedo.png', png(4, 4, [170, 60, 50, 255]));
    put('textures/brick_wall_normal.png', png(4, 4, [128, 128, 255, 255]));
    return dir;
}

test('assets are understood from the files: real size, kind, units, materials, colors and style', () => {
    const dir = library();
    const index = assetIndex.buildIndex(dir);
    const by = Object.fromEntries(index.assets.map(a => [a.file, a]));
    const desk = by['assets/SM_Desk_01.glb'];
    assert.equal(desk.category, 'desk');
    assert.equal(desk.scale, 0.01, 'a desk 140 units wide is in centimeters');
    assert.deepEqual(desk.size, [1.4, 0.75, 0.7]);
    assert.ok(desk.tags.wood, 'oak material reads as wood');
    assert.equal(by['assets/lamp_80s.glb'].category, 'desk_lamp');
    assert.equal(by['assets/lamp_tall.glb'].category, 'floor_lamp');
    assert.ok(by['assets/lamp_80s.glb'].tags.retro && by['assets/lamp_80s.glb'].tags.orange, JSON.stringify(by['assets/lamp_80s.glb'].tags));
    assert.ok(by['assets/lamp_tall.glb'].tags.chrome);
    assert.equal(by['assets/OfficeChair.glb'].category, 'office_chair');
    assert.equal(by['assets/potted_fern.glb'].category, 'plant');
    assert.ok(by['textures/brick_wall_albedo.png'].tags.stone && by['textures/brick_wall_albedo.png'].tags.red);
    assert.equal(by['textures/brick_wall_normal.png'].map, 'normal');
    assert.equal(by['textures/brick_wall_normal.png'].color, null, 'a normal map\'s color isn\'t the surface color');
    const hits = assetIndex.search(index, { query: 'retro desk lamp' });
    assert.equal(hits[0].file, 'assets/lamp_80s.glb');
    // Only changed files are read again; corrections survive.
    const again = assetIndex.buildIndex(dir, { ...index, overrides: { 'res://assets/potted_fern.glb': { category: 'plant', addTags: ['cozy'] } } });
    assert.equal(again.reread, 0);
    assert.equal(again.assets.find(a => a.file === 'assets/potted_fern.glb').tags.cozy, 'you');
});

test('the rules: lamp and monitor on the desk top, chair facing the desk, nothing overlapping, all in the room', () => {
    const dir = library();
    const index = assetIndex.buildIndex(dir);
    const result = dressing.plan({ index, prefs: dressing.emptyPrefs(), items: dressing.PRESETS.office, seed: 7, room: { size: [5, 3, 4] } });
    const by = Object.fromEntries(result.placements.map(p => [p.category, p]));
    const desk = by.desk;
    assert.ok(desk && desk.wall, 'the desk is against a wall');
    assert.equal(desk.asset.file, 'assets/SM_Desk_01.glb');
    for (const cat of ['desk_lamp', 'monitor', 'keyboard']) {
        const p = by[cat];
        assert.ok(p, `${cat} placed`);
        assert.equal(p.parent, desk);
        assert.ok(Math.abs(p.base - 0.75) < 1e-6, `${cat} stands on the desk top (base ${p.base})`);
        const [lx, lz] = dressing.toLocal(p.cx - desk.cx, p.cz - desk.cz, desk.yaw);
        assert.ok(Math.abs(lx) <= 0.7 && Math.abs(lz) <= 0.35, `${cat} is within the desk's top`);
    }
    // The lamp goes at the back of the desk, the keyboard at the front.
    assert.ok(dressing.toLocal(by.desk_lamp.cx - desk.cx, by.desk_lamp.cz - desk.cz, desk.yaw)[1] < 0);
    assert.ok(dressing.toLocal(by.keyboard.cx - desk.cx, by.keyboard.cz - desk.cz, desk.yaw)[1] > 0);
    assert.equal(by.desk_lamp.asset.file, 'assets/lamp_80s.glb', 'a desk lamp, not the floor lamp');
    const chair = by.office_chair;
    assert.equal(Math.abs(dressing.toLocal(0, 0, 0)[0]), 0);
    assert.ok(Math.abs(((chair.yaw - desk.yaw + 540) % 360) - 180 - 180) % 360 < 1e-6 || Math.abs(Math.abs(chair.yaw - desk.yaw) - 180) < 1e-6, `chair faces the desk (${chair.yaw} vs ${desk.yaw})`);
    assert.ok(dressing.toLocal(chair.cx - desk.cx, chair.cz - desk.cz, desk.yaw)[1] > 0, 'chair is in front of the desk');
    const floor = result.placements.filter(p => p.floor && !p.flat);
    for (const p of floor) {
        assert.ok(p.box[0] >= -2.5 - 1e-6 && p.box[1] <= 2.5 + 1e-6 && p.box[2] >= -2 - 1e-6 && p.box[3] <= 2 + 1e-6, `${p.name} inside the room`);
        for (const q of floor) if (p !== q && !(q.parent === p || p.parent === q)) assert.ok(!dressing.overlaps(p.box, q.box, 0.005), `${p.name} and ${q.name} overlap`);
    }
    // Missing kinds become placeholders; the same seed gives the same layout.
    assert.ok(result.placements.find(p => p.category === 'shelf' && !p.asset));
    const same = dressing.plan({ index, prefs: dressing.emptyPrefs(), items: dressing.PRESETS.office, seed: 7, room: { size: [5, 3, 4] } });
    assert.deepEqual(same.placements.map(p => p.position), result.placements.map(p => p.position));
    // Style picks between assets of the same kind.
    const wood = dressing.plan({ index, prefs: dressing.emptyPrefs(), items: ['desk', 'office_chair'], style: 'walnut', seed: 1 });
    assert.equal(wood.placements.find(p => p.category === 'office_chair').asset.file, 'assets/chair_wood.glb');
    // Around a dining table, every chair faces the table.
    const dining = dressing.plan({ index: { assets: [] }, prefs: dressing.emptyPrefs(), items: ['dining_table', { category: 'chair', count: 4 }], seed: 3 });
    const table = dining.placements.find(p => p.category === 'dining_table');
    const chairs = dining.placements.filter(p => p.category === 'chair');
    assert.equal(chairs.length, 4);
    for (const c of chairs) {
        const toward = Math.atan2(table.cx - c.cx, table.cz - c.cz) * 180 / Math.PI;
        assert.ok(Math.abs(((toward - c.yaw + 540) % 360) - 180) < 1, 'chair faces the table');
    }
});

// A stand-in Godot editor that keeps a scene in memory and answers the bridge's commands.
async function fakeEditor(dir) {
    const nodes = new Map([['.', { name: 'Main', type: 'Node3D', path: '.' }]]);
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const { action, args } = JSON.parse(body);
            calls.push({ action, args });
            let reply = { ok: true };
            const add = (parent, name, extra) => {
                const p = parent === '.' ? name : `${parent}/${name}`;
                let final = p; let i = 2;
                while (nodes.has(final)) final = `${p}${i++}`;
                const pr = args.properties || {};
                const node = { name: final.split('/').pop(), path: final, global_position: pr.position || [0, 0, 0], global_rotation_degrees: pr.rotation_degrees || [0, 0, 0], scale: pr.scale || [1, 1, 1], ...extra };
                nodes.set(final, node);
                return node;
            };
            if (action === 'scene_tree') reply = { ok: true, scene: 'res://main.tscn', nodes: [...nodes.values()] };
            else if (action === 'add_node') reply = { ok: true, node: add(args.parent || '.', args.name, { type: args.type }) };
            else if (action === 'instantiate') reply = { ok: true, node: add(args.parent || '.', args.name, { type: 'Node3D', scene: args.path }) };
            else if (action === 'remove_node') reply = nodes.delete(args.node) ? { ok: true } : { ok: false, error: 'no node' };
            else if (action === 'set_property') {
                const n = nodes.get(args.node);
                if (!n) reply = { ok: false, error: 'no node' };
                else if (args.property === 'global_position' || args.property === 'position') n.global_position = args.value;
                else if (args.property === 'rotation_degrees') n.global_rotation_degrees = args.value;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reply));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    fs.mkdirSync(path.join(dir, 'addons', 'codev_bridge'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'addons', 'codev_bridge', 'plugin.cfg'), '[plugin]\n');
    fs.writeFileSync(path.join(dir, '.codev_bridge.json'), JSON.stringify({ port: server.address().port, token: 't' }));
    return { nodes, calls, close: () => server.close() };
}

test('in the Godot editor: placed, learned from moves, deletes and swaps, and surfaces cleared with what is on them', async () => {
    const dir = library();
    const editor = await fakeEditor(dir);
    const service = createGameDevService({ getProjectDir: () => dir, env: { PATH: '' } });
    try {
        const listed = service.tools.map(t => t.name);
        for (const name of ['scene_assets', 'scene_dress', 'scene_edit', 'scene_learn']) assert.ok(listed.includes(name));
        assert.match(textOf(await service.callTool('scene_assets', {})), /7 model\(s\) and 2 texture\(s\)[\s\S]*SM_Desk_01\.glb: desk .*in centimeters/);

        const first = textOf(await service.callTool('scene_dress', { items: ['desk', 'office_chair', 'desk_lamp', 'monitor', { category: 'plant', optional: true }], seed: 4, room: { size: [5, 3, 4] } }));
        assert.match(first, /Placed 5 item\(s\)/);
        assert.match(first, /DeskLamp: res:\/\/assets\/lamp_80s\.glb on the Desk/);
        assert.ok(editor.nodes.has('Dressing'));
        const desk = editor.nodes.get('Dressing/Desk');
        assert.deepEqual(desk.scale, [0.01, 0.01, 0.01]);
        assert.equal(desk.scene, 'res://assets/SM_Desk_01.glb');
        const lamp = editor.nodes.get('Dressing/DeskLamp');
        assert.ok(Math.abs(lamp.global_position[1] - 0.75) < 1e-6, 'the lamp\'s bottom is on the desk top');

        // The user moves the lamp to the desk's front-left, deletes the plant and swaps the chair.
        const dy = desk.global_rotation_degrees[1];
        const [ox, oz] = dressing.rotate(0.55, 0.2, dy);
        lamp.global_position = [desk.global_position[0] + ox, 0.75, desk.global_position[2] + oz];
        editor.nodes.delete('Dressing/Plant');
        const chairBefore = editor.nodes.get('Dressing/OfficeChair').scene;
        const other = chairBefore === 'res://assets/OfficeChair.glb' ? 'res://assets/chair_wood.glb' : 'res://assets/OfficeChair.glb';
        editor.nodes.get('Dressing/OfficeChair').scene = other;

        const learned = textOf(await service.callTool('scene_learn', {}));
        assert.match(learned, /you moved the desk_lamp \(on the desk\)/);
        assert.match(learned, /you removed the plant/);
        assert.match(learned, /you swapped the office_chair/);
        const prefs = JSON.parse(fs.readFileSync(path.join(dir, '.codev', 'scene', 'preferences.json'), 'utf8'));
        assert.ok(prefs.assets[other].score > 0 && prefs.assets[chairBefore].score < 0);
        const offset = prefs.offsets['desk_lamp@desk:on'][0];
        assert.ok(offset.lx > 0.5 && offset.lz > 0.5, JSON.stringify(offset));

        // Next time: the lamp goes where the user put it, and the swapped-in chair is chosen.
        const next = dressing.plan({ index: assetIndex.buildIndex(dir), prefs, items: ['desk', 'office_chair', 'desk_lamp'], seed: 9 });
        const nd = next.placements.find(p => p.category === 'desk');
        const nl = next.placements.find(p => p.category === 'desk_lamp');
        const [lx, lz] = dressing.toLocal(nl.cx - nd.cx, nl.cz - nd.cz, nd.yaw);
        assert.ok(lx > 0.3 && lz > 0.1, `learned spot used (${lx}, ${lz})`);
        assert.equal(next.placements.find(p => p.category === 'office_chair').asset.path, other);
        assert.ok(next.learned.some(l => /where you moved it/.test(l)));

        // A second deleted plant: optional plants are left out after that.
        await service.callTool('scene_dress', { items: [{ category: 'plant', optional: true }], seed: 5, room: { size: [5, 3, 4] } });
        const plant = [...editor.nodes.keys()].find(k => /Plant/.test(k));
        assert.ok(plant);
        editor.nodes.delete(plant);
        const third = textOf(await service.callTool('scene_dress', { items: [{ category: 'plant', optional: true }], seed: 6 }));
        assert.match(third, /plant: left out, since you removed 2 of them before/);

        // The scene's desk is built on rather than duplicated, and a mug goes on it.
        const more = textOf(await service.callTool('scene_dress', { items: ['desk', { category: 'mug' }], seed: 2 }));
        assert.match(more, /Mug: gray placeholder box .*on the Desk/);
        assert.ok(!editor.nodes.has('Dressing/Desk2'));

        // Moving the desk carries everything on it; clearing it removes them and keeps the desk.
        const before = editor.nodes.get('Dressing/DeskLamp').global_position.slice();
        const deskAt = editor.nodes.get('Dressing/Desk').global_position.slice();
        assert.match(textOf(await service.callTool('scene_edit', { action: 'move', node: 'Desk', position: [deskAt[0] + 0.5, deskAt[1], deskAt[2]] })), /and what's on it/);
        assert.ok(Math.abs(editor.nodes.get('Dressing/DeskLamp').global_position[0] - (before[0] + 0.5)) < 1e-6);
        const dry = textOf(await service.callTool('scene_edit', { action: 'clear', node: 'Dressing/Desk', dry_run: true }));
        assert.match(dry, /Would remove: .*DeskLamp/);
        assert.match(dry, /Monitor/);
        assert.doesNotMatch(dry, /OfficeChair/);
        await service.callTool('scene_edit', { action: 'clear', node: 'Dressing/Desk' });
        assert.ok(editor.nodes.has('Dressing/Desk') && !editor.nodes.has('Dressing/DeskLamp') && !editor.nodes.has('Dressing/Monitor'));
        // Asked-for removals aren't counted as dislikes.
        const after = JSON.parse(fs.readFileSync(path.join(dir, '.codev', 'scene', 'preferences.json'), 'utf8'));
        assert.equal(after.categories.monitor && after.categories.monitor.removed, undefined);

        // Feedback in words and corrections.
        const fb = textOf(await service.callTool('scene_learn', { feedback: [{ style: 'industrial', verdict: 'like' }], corrections: [{ asset: 'assets/potted_fern.glb', category: 'plant', add_tags: ['tropical'] }] }));
        assert.match(fb, /Noted: res:\/\/assets\/potted_fern\.glb is plant, tropical/);
        assert.match(fb, /likes .*industrial/);
    } finally { editor.close(); }
});

test('without the editor: a plan, and a Blender script that imports and places the assets', async () => {
    const dir = library();
    const service = createGameDevService({ getProjectDir: () => dir, env: { PATH: '' } });
    const planned = textOf(await service.callTool('scene_dress', { preset: 'office', target: 'plan', seed: 1 }));
    assert.match(planned, /Planned \d+ item\(s\)/);
    assert.match(planned, /Nothing was changed/);
    const blender = textOf(await service.callTool('scene_dress', { items: ['desk', 'desk_lamp'], target: 'blender', seed: 1 }));
    assert.match(blender, /bpy\.ops\.import_scene\.gltf/);
    assert.match(blender, /assets\/SM_Desk_01\.glb/);
    assert.match(blender, /holder\.location = \(x, -z, y\)/);
    const failed = await service.callTool('scene_dress', { items: ['desk'] });
    assert.ok(failed.isError);
    assert.match(textOf(failed), /CoDev Bridge plugin isn't in this Godot project/);
    assert.match(textOf(await service.callTool('scene_dress', { preset: 'spaceship' })), /Unknown preset/);
});
