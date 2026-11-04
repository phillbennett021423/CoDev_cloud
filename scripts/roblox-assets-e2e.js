#!/usr/bin/env node
// End-to-end check of Roblox art: real Blender makes a heavy rigged model (an 81,000
// triangle sphere with 6 bone weights per vertex and a 2048 texture), roblox_asset_check
// rejects it, roblox_export_model fits it to Roblox's limits, the check passes, and
// roblox_upload sends it to Open Cloud and inserts it into the place.
//
//   node scripts/roblox-assets-e2e.js          stand-in Open Cloud and stand-in Studio
//   node scripts/roblox-assets-e2e.js --real   your real Open Cloud key (CODEV_ROBLOX_API_KEY and
//                                              CODEV_ROBLOX_CREATOR in .env) and Roblox Studio
//
// Needs Blender: on the PATH, in its usual folder, or CODEV_BLENDER_PATH.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { loadEnvFile } = require('../env');

const real = process.argv.includes('--real');
loadEnvFile();

const MAKE_MODEL = `
import bpy
for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.mesh.primitive_uv_sphere_add(segments=256, ring_count=160, radius=1)
orb = bpy.context.active_object
orb.name = "Orb"
bpy.ops.object.armature_add()
arm = bpy.context.active_object
for i in range(6):
    g = orb.vertex_groups.new(name="Bone" if i == 0 else "Extra%d" % i)
    g.add([v.index for v in orb.data.vertices], 0.2, "REPLACE")
orb.parent = arm
orb.modifiers.new("Arm", "ARMATURE").object = arm
img = bpy.data.images.new("BigTex", 2048, 2048)
mat = bpy.data.materials.new("OrbMat")
mat.use_nodes = True
tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
tex.image = img
mat.node_tree.links.new(tex.outputs["Color"], mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
orb.data.materials.append(mat)
img.pack()
bpy.ops.export_scene.gltf(filepath=CODEV_OUTPUT, export_format="GLB")
`;

function show(step, result) {
    const body = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    console.log(`\n=== ${step}${result.isError ? '  (reported a problem)' : ''}`);
    console.log(body.split('\n').map(l => `  ${l}`).join('\n'));
    return body;
}

function expect(ok, what) {
    if (!ok) { console.error(`\nFAILED: ${what}`); process.exitCode = 1; throw new Error(what); }
    console.log(`  ✓ ${what}`);
}

// The stand-in Open Cloud answers like the real one: an operation, then the asset.
function standInCloud() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (req.method === 'POST') res.end(JSON.stringify({ path: 'operations/e2e', done: false }));
                else res.end(JSON.stringify({ path: 'operations/e2e', done: true, response: { assetId: '7000', moderationResult: { moderationState: 'MODERATION_STATE_APPROVED' } } }));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
    });
}

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-roblox-art-'));
    const env = { ...process.env };
    let cloud = null;
    if (!real) {
        cloud = await standInCloud();
        Object.assign(env, { CODEV_ROBLOX_API_KEY: 'stand-in', CODEV_ROBLOX_CREATOR: 'user:1', CODEV_ROBLOX_MCP: process.execPath, CODEV_ROBLOX_MCP_ARGS: JSON.stringify([path.join(__dirname, '..', 'tests', 'fixtures', 'fake-roblox-studio.js')]) });
    }
    const fetchImpl = cloud ? (url, opts) => fetch(String(url).replace('https://apis.roblox.com', cloud.base), opts) : globalThis.fetch;
    const { createGameDevService, findBlender } = require('../desktop/gamedev');
    if (!findBlender(env)) { console.error('Blender isn\'t installed where CoDev can find it; set CODEV_BLENDER_PATH.'); process.exitCode = 1; return; }
    const service = createGameDevService({ getProjectDir: () => dir, env, fetchImpl });
    const call = (name, args) => service.callTool(name, args);
    try {
        console.log(`Roblox art end-to-end check with real Blender (${findBlender(env)}), ${real ? 'real Open Cloud and Studio' : 'stand-in Open Cloud and Studio'}\nProject folder: ${dir}`);
        show('roblox_init_project', await call('roblox_init_project', { name: 'Orb Test' }));
        let out = show('blender_run (make a heavy model)', await call('blender_run', { script: MAKE_MODEL, output: 'assets/models/orb.glb', timeout_seconds: 600 }));
        expect(fs.existsSync(path.join(dir, 'assets/models/orb.glb')), 'Blender made the heavy test model');
        out = show('roblox_asset_check (before)', await call('roblox_asset_check', { file: 'assets/models/orb.glb' }));
        expect(/81,408 triangles \(Roblox allows 20,000/.test(out), 'the check rejects 81,408 triangles');
        out = show('roblox_export_model', await call('roblox_export_model', { input: 'assets/models/orb.glb', output: 'assets/roblox/orb.glb', max_triangles: 8000 }));
        expect(/81,408 -> [0-7],?\d{3} triangles, bone weights limited to 4 per vertex/.test(out), 'decimated under the 8,000 budget with 4 bone weights per vertex');
        expect(/2048x2048 -> 1024x1024/.test(out), 'the texture was shrunk to 1024');
        out = show('roblox_asset_check (after)', await call('roblox_asset_check', { file: 'assets/roblox/orb.glb' }));
        expect(/^Ready for Roblox/.test(out), 'the exported model fits Roblox\'s limits');
        out = show('roblox_upload', await call('roblox_upload', { file: 'assets/roblox/orb.glb', name: 'Orb', insert: true, height_studs: 6 }));
        expect(/Uploaded assets\/roblox\/orb\.glb to Roblox as Model \d+/.test(out), 'uploaded through Open Cloud');
        expect(/Inserted into the Workspace as Orb: [\d.]+ x 6\.00 x/.test(out), 'inserted into the place and scaled to 6 studs tall');
        const assets = fs.readFileSync(path.join(dir, 'src/shared/Assets.luau'), 'utf8');
        expect(/Orb = "rbxassetid:\/\/\d+"/.test(assets), 'the id is in src/shared/Assets.luau for scripts');
        out = show('roblox_check', await call('roblox_check'));
        expect(/No problems/.test(out), 'the Assets module compiles with the rest of the game');
        console.log('\nAll checks passed.');
    } finally {
        await service.close();
        if (cloud) cloud.server.close();
    }
}

main().catch(err => { if (!process.exitCode) { console.error(err.stack || err); process.exitCode = 1; } });
