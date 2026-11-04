// Roblox art and uploads (desktop/gamedev/roblox-assets.js): reading a .glb against
// Roblox's limits, the Blender export (a stand-in Blender here; scripts/roblox-assets-e2e.js
// runs the real one), and uploads through a stand-in Open Cloud, with the ids written into
// the Assets module and a model inserted into a stand-in Studio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createRoblox } = require('../desktop/gamedev/roblox');
const { inspectGlb, luauName, parseCreator } = require('../desktop/gamedev/roblox-assets');
const { compileLuau } = require('../desktop/gamedev/roblox-luau');

const FAKE_STUDIO = path.join(__dirname, 'fixtures', 'fake-roblox-studio.js');
const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

// A .glb with one mesh of `triangles` indexed triangles, optional 8-weight skinning and a PNG.
function makeGlb({ triangles = 12, eightWeights = false, png = null } = {}) {
    const bin = png ? Buffer.concat([png, Buffer.alloc((4 - (png.length % 4)) % 4)]) : Buffer.alloc(0);
    const attributes = { POSITION: 0, ...(eightWeights ? { WEIGHTS_0: 0, WEIGHTS_1: 0 } : {}) };
    const json = {
        asset: { version: '2.0' },
        accessors: [{ count: 3, type: 'VEC3', componentType: 5126 }, { count: triangles * 3, type: 'SCALAR', componentType: 5125 }],
        meshes: [{ name: 'Rock', primitives: [{ attributes, indices: 1 }] }],
        skins: eightWeights ? [{ joints: [0, 1, 2] }] : [],
        bufferViews: png ? [{ buffer: 0, byteOffset: 0, byteLength: png.length }] : [],
        images: png ? [{ name: 'RockTex', bufferView: 0, mimeType: 'image/png' }] : []
    };
    let j = Buffer.from(JSON.stringify(json));
    j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
    const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
    return Buffer.concat([header, chunk(0x4e4f534a, j), chunk(0x004e4942, bin)]);
}

function pngHeader(w, h) {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return b;
}

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-rbx-assets-'));
    fs.writeFileSync(path.join(dir, 'default.project.json'), JSON.stringify({ name: 'G', tree: { $className: 'DataModel', ReplicatedStorage: { Shared: { $path: 'src/shared' } }, ServerScriptService: { Server: { $path: 'src/server' } } } }));
    fs.mkdirSync(path.join(dir, 'src', 'shared'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    return dir;
}

// A stand-in Open Cloud: checks the key and the multipart request, answers with an operation.
async function openCloud() {
    const seen = [];
    let next = 4000; // even ids are models; odd ids are decals in the stand-in Studio
    const ops = new Map();
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
            if (req.headers['x-api-key'] !== 'test-key') return send(401, { message: 'Invalid API Key' });
            if (req.method === 'POST' && req.url === '/assets/v1/assets') {
                const raw = body.toString('latin1');
                const request = JSON.parse(raw.match(/name="request"\r\n\r\n([^\r]*)\r\n/)[1]);
                const file = raw.match(/name="fileContent"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)\r\n/);
                seen.push({ request, filename: file[1], contentType: file[2], bytes: body.length });
                const id = request.assetType === 'Decal' ? next + 1 : next;
                next += 2;
                const op = `op${seen.length}`;
                ops.set(op, { polls: 0, response: { assetId: String(id), assetType: `ASSET_TYPE_${request.assetType.toUpperCase()}`, moderationResult: { moderationState: 'MODERATION_STATE_APPROVED' } } });
                return send(200, { path: `operations/${op}`, done: false });
            }
            const m = req.url.match(/^\/assets\/v1\/operations\/(\w+)$/);
            if (req.method === 'GET' && m && ops.has(m[1])) {
                const op = ops.get(m[1]);
                op.polls++;
                return send(200, op.polls < 2 ? { path: `operations/${m[1]}`, done: false } : { path: `operations/${m[1]}`, done: true, response: op.response });
            }
            send(404, { message: 'not found' });
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const fetchImpl = (url, opts) => fetch(String(url).replace('https://apis.roblox.com', base), opts);
    return { seen, fetchImpl, close: () => new Promise(r => server.close(r)) };
}

test('a .glb is read for triangles, bone weights and texture size without Blender', () => {
    const info = inspectGlb(makeGlb({ triangles: 25000, eightWeights: true, png: pngHeader(2048, 1024) }));
    assert.deepEqual(info.meshes, [{ name: 'Rock', triangles: 25000, maxInfluences: 8 }]);
    assert.deepEqual(info.images, [{ name: 'RockTex', width: 2048, height: 1024 }]);
    assert.equal(info.joints, 3);
    assert.throws(() => inspectGlb(Buffer.from('not a glb at all')), /Not a \.glb/);
    assert.equal(luauName('coin pickup.fbx'), 'CoinPickup');
    assert.equal(luauName('3d-sword_v2.glb'), 'Asset3dSwordV2');
    assert.deepEqual(parseCreator('group:42'), { groupId: '42' });
    assert.equal(parseCreator('42'), null);
});

test('roblox_asset_check flags what breaks Roblox\'s limits and passes what fits', async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'assets', 'big.glb'), makeGlb({ triangles: 25000, eightWeights: true, png: pngHeader(2048, 2048) }));
    fs.writeFileSync(path.join(dir, 'assets', 'ok.glb'), makeGlb({ triangles: 900 }));
    const roblox = createRoblox({ getProjectDir: () => dir, env: {} });
    const big = await roblox.callTool('roblox_asset_check', { file: 'assets/big.glb' });
    assert.equal(big.isError, true);
    assert.match(textOf(big), /2 problem\(s\)[\s\S]*25,000 triangles \(Roblox allows 20,000 per mesh\)[\s\S]*more than 4 bone weights[\s\S]*2048x2048/);
    const ok = await roblox.callTool('roblox_asset_check', { file: 'assets/ok.glb' });
    assert.equal(ok.isError, undefined);
    assert.match(textOf(ok), /^Ready for Roblox\.[\s\S]*✓ mesh Rock: 900 triangles/);
    assert.match(textOf(await roblox.callTool('roblox_asset_check', { file: '../etc/passwd' })), /No file/);
});

test('roblox_export_model runs the Roblox export script in Blender with the budget and reports the result', async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'assets', 'statue.glb'), makeGlb({ triangles: 50000 }));
    let ran = null;
    const runBlender = async (script, extra) => {
        ran = { script, extra };
        fs.mkdirSync(path.dirname(extra.CODEV_OUTPUT), { recursive: true });
        fs.writeFileSync(extra.CODEV_OUTPUT, 'fbx');
        return { code: 0, output: `CODEV_REPORT ${JSON.stringify({ meshes: [{ name: 'Statue', before: 50000, after: 9800, weights_limited: false }], textures: [{ name: 'Stone', from: [4096, 4096], to: [1024, 1024] }], warnings: [], armatures: 0, animations: 0 })}` };
    };
    const roblox = createRoblox({ getProjectDir: () => dir, env: {}, runBlender });
    const r = await roblox.callTool('roblox_export_model', { input: 'assets/statue.glb', max_triangles: 10000 });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /Saved assets\/roblox\/statue\.fbx[\s\S]*Statue: 50,000 -> 9,800 triangles[\s\S]*Stone: 4096x4096 -> 1024x1024/);
    assert.equal(ran.extra.CODEV_MAX_TRIS, '10000');
    assert.equal(ran.extra.CODEV_TEX, '1024');
    assert.match(ran.script, /vertex_group_limit_total\(group_select_mode="ALL", limit=4\)/);
    // The budget can't go over Roblox's limit, and nothing outside the project is read.
    await roblox.callTool('roblox_export_model', { input: 'assets/statue.glb', max_triangles: 90000 });
    assert.equal(ran.extra.CODEV_MAX_TRIS, '20000');
    assert.match(textOf(await roblox.callTool('roblox_export_model', { input: '/etc/hosts' })), /No file/);
    const none = createRoblox({ getProjectDir: () => dir, env: {}, runBlender: async () => null });
    assert.match(textOf(await none.callTool('roblox_export_model', { input: 'assets/statue.glb' })), /blender\.org/);
});

test('roblox_upload needs the user\'s key and creator, and refuses what Roblox would reject', async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'assets', 'big.glb'), makeGlb({ triangles: 30000 }));
    fs.writeFileSync(path.join(dir, 'assets', 'walk.fbx'), 'fbx');
    const noKey = createRoblox({ getProjectDir: () => dir, env: {} });
    assert.match(textOf(await noKey.callTool('roblox_upload', { file: 'assets/big.glb' })), /Creator Dashboard > Open Cloud > API Keys/);
    const roblox = createRoblox({ getProjectDir: () => dir, env: { CODEV_ROBLOX_API_KEY: 'test-key', CODEV_ROBLOX_CREATOR: 'user:77' }, fetchImpl: () => { throw new Error('should not upload'); } });
    assert.match(textOf(await roblox.callTool('roblox_upload', { file: 'assets/big.glb' })), /Not uploaded: the model breaks Roblox's limits/);
    assert.match(textOf(await roblox.callTool('roblox_upload', { file: 'assets/walk.fbx', type: 'animation' })), /only as \.rbxm or \.rbxmx/);
    assert.equal(roblox.tools.find(t => t.name === 'roblox_upload')._meta['codev/alwaysAsk'], true);
});

test('uploads go to Open Cloud, wait for the operation, and land in the Assets module and the open place', async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'assets', 'coin.glb'), makeGlb({ triangles: 500 }));
    fs.writeFileSync(path.join(dir, 'assets', 'coin_icon.png'), pngHeader(256, 256));
    fs.writeFileSync(path.join(dir, 'assets', 'pickup.ogg'), 'OggS fake');
    const cloud = await openCloud();
    const roblox = createRoblox({
        getProjectDir: () => dir,
        env: { ...process.env, CODEV_ROBLOX_API_KEY: 'test-key', CODEV_ROBLOX_CREATOR: 'group:9001', CODEV_ROBLOX_MCP: process.execPath, CODEV_ROBLOX_MCP_ARGS: JSON.stringify([FAKE_STUDIO]) },
        fetchImpl: cloud.fetchImpl
    });
    try {
        const model = await roblox.callTool('roblox_upload', { file: 'assets/coin.glb', name: 'Gold Coin', insert: true, height_studs: 2 });
        assert.equal(model.isError, undefined, textOf(model));
        assert.match(textOf(model), /as Model 4000 \(moderation: approved\)/);
        assert.match(textOf(model), /Inserted into the Workspace as GoldCoin: 0\.80 x 2\.00 x 0\.80 studs/);
        const image = await roblox.callTool('roblox_upload', { file: 'assets/coin_icon.png' });
        assert.match(textOf(image), /as Decal 4003/);
        const sound = await roblox.callTool('roblox_upload', { file: 'assets/pickup.ogg', name: 'PickupSound' });
        assert.match(textOf(sound), /as Audio 4004/);

        assert.deepEqual(cloud.seen.map(s => [s.request.assetType, s.contentType, s.request.creationContext.creator]), [
            ['Model', 'model/gltf-binary', { groupId: '9001' }], ['Decal', 'image/png', { groupId: '9001' }], ['Audio', 'audio/ogg', { groupId: '9001' }]
        ]);
        const registry = JSON.parse(fs.readFileSync(path.join(dir, 'assets', 'roblox', 'assets.json'), 'utf8'));
        assert.equal(registry.GoldCoin.id, 4000);
        assert.equal(registry.CoinIcon.id, 4003);
        assert.equal(registry.CoinIcon.imageId, 4002); // looked up in Studio: scripts need the image, not the decal
        const lua = fs.readFileSync(path.join(dir, 'src', 'shared', 'Assets.luau'), 'utf8');
        assert.match(lua, /CoinIcon = "rbxassetid:\/\/4002",/);
        assert.match(lua, /GoldCoin = "rbxassetid:\/\/4000",/);
        assert.match(lua, /Ids = \{[\s\S]*PickupSound = 4004,/);
        assert.equal((await compileLuau(lua, 'Assets')).ok, true);
        // The module is a normal project script, so it syncs and checks like the rest.
        assert.match(textOf(await roblox.callTool('roblox_check')), /✓ src\/shared\/Assets\.luau/);

        const bad = createRoblox({ getProjectDir: () => dir, env: { CODEV_ROBLOX_API_KEY: 'wrong', CODEV_ROBLOX_CREATOR: 'user:1' }, fetchImpl: cloud.fetchImpl });
        const refused = await bad.callTool('roblox_upload', { file: 'assets/pickup.ogg' });
        assert.equal(refused.isError, true);
        assert.match(textOf(refused), /answered 401: Invalid API Key\. Check that the key has the Assets API/);
    } finally {
        await roblox.close();
        await cloud.close();
    }
});
