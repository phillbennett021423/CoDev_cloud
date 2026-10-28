// Tripo 3D models (mobile/www/tripo-tools.js and desktop/tripo-relay.js): an agent
// makes a model from a description or a picture, it shows under the reply, opens
// in the 3D viewer, and the per-task and daily credit limits hold. Tripo itself is
// played by page.route on the page's /tripo relay, so no key or network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat } = require('./helpers/page-driver');
const { handleTripoRequest } = require('../desktop/tripo-relay');

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const KEY = 'tsk_test_key_for_codev_tripo_123';

// A .glb holding one triangle.
function makeGlb() {
    const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const gltf = {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
        bufferViews: [{ buffer: 0, byteLength: positions.length }],
        buffers: [{ byteLength: positions.length }]
    };
    let json = Buffer.from(JSON.stringify(gltf));
    json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
    const chunk = (type, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32LE(data.length, 0);
        head.writeUInt32LE(type, 4);
        return Buffer.concat([head, data]);
    };
    const body = Buffer.concat([chunk(0x4E4F534A, json), chunk(0x004E4942, positions)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546C67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + body.length, 8);
    return Buffer.concat([header, body]);
}
const GLB = makeGlb();

async function openPlainPage(t, steps) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-tripo-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const opened = await openPage(launched.browser, url, { steps });
    await opened.page.uncheck('#isSandboxCheckbox');
    return opened;
}

// Plays Tripo behind CoDev's /tripo relay and records what the page asked for.
async function fakeTripo(page, { credits = 20, fail = false } = {}) {
    const calls = [];
    const polls = {};
    await page.route('**/tripo', async route => {
        const message = JSON.parse(route.request().postData());
        calls.push(message);
        let reply;
        if (message.op === 'download') {
            reply = /\.glb$/.test(message.url)
                ? { status: 200, contentType: 'model/gltf-binary', base64: GLB.toString('base64') }
                : { status: 200, contentType: 'image/png', base64: PNG_1PX.toString('base64') };
        } else if (message.key !== KEY) {
            reply = { status: 401, body: { code: 1002, message: 'invalid api key' } };
        } else if (message.op === 'upload') {
            reply = { status: 200, body: { code: 0, data: { file_token: 'file_abc123' } } };
        } else if (message.path === '/account/balance') {
            reply = { status: 200, body: { code: 0, data: { balance: 1234.5, frozen: 0 } } };
        } else if (message.method === 'POST') {
            reply = { status: 200, body: { code: 0, data: { task_id: `task_${calls.length}` } } };
        } else {
            const id = message.path.split('/').pop();
            polls[id] = (polls[id] || 0) + 1;
            const type = calls.find(c => c.method === 'POST' && `task_${calls.indexOf(c) + 1}` === id)?.path || '';
            reply = polls[id] < 2 ? { status: 200, body: { code: 0, data: { task_id: id, status: 'running', progress: 40 } } }
                : fail ? { status: 200, body: { code: 0, data: { task_id: id, status: 'failed', progress: 0, error_message: 'bad prompt' } } }
                : /text-to-image/.test(type)
                ? { status: 200, body: { code: 0, data: { task_id: id, status: 'success', progress: 100, credits_consumed: 5, output: { generated_image_url: 'https://cdn.tripo3d.ai/out/picture.png' } } } }
                : { status: 200, body: { code: 0, data: { task_id: id, status: 'success', progress: 100, credits_consumed: credits,
                    output: { model_url: 'https://cdn.tripo3d.ai/out/model.glb', rendered_image_url: 'https://cdn.tripo3d.ai/out/preview.png' } } } };
        }
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) });
    });
    return calls;
}

test('an agent makes a 3D model from a description; it shows under the reply and opens in the 3D viewer', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, [
        [{ name: 'generate_3d_model', arguments: { prompt: 'A low wooden treasure chest with iron bands' } }],
        'Here is your treasure chest.'
    ]);
    const calls = await fakeTripo(page);
    await page.evaluate(key => { tripoKey = key; }, KEY);
    page.on('dialog', dialog => dialog.dismiss());
    await sendPrompt(page, 'Make me a 3D treasure chest');
    await waitForChat(page, /Here is your treasure chest/, 60000);

    const create = calls.find(c => c.method === 'POST');
    assert.equal(create.path, '/generation/text-to-model');
    assert.equal(create.key, KEY);
    assert.equal(create.body.prompt, 'A low wooden treasure chest with iron bands');
    assert.equal(create.body.texture, true);
    assert.equal(create.body.texture_quality, 'standard');
    assert.ok(calls.some(c => c.op === 'download' && c.url.endsWith('model.glb')));

    const toolResult = await page.evaluate(() => window.__modelCalls.at(-1).messages.find(m => m.role === 'tool').content);
    assert.match(toolResult, /Made the 3D model "a-low-wooden-treasure-chest\.glb".*20 credits \(about \$0\.20; 20 of today's 100 used\)/);
    const reply = await page.evaluate(() => chatSessions.find(s => s.id === activeChatId).messages.at(-1));
    assert.equal(reply.attachments.length, 1);
    assert.equal(reply.attachments[0].kind, 'model');
    assert.match(reply.attachments[0].thumb, /^data:image\/jpeg/);
    const usage = await page.evaluate(() => tripoUsageToday());
    assert.equal(usage.credits, 20);
    assert.equal(usage.models, 1);

    await page.click('#chatFeed img.generated');
    await page.waitForSelector('#generatedImageViewer button.btn-primary');
    assert.match(await page.textContent('#generatedImageViewer'), /20 Tripo credits/);
    await page.click('#generatedImageViewer button.btn-primary');
    await page.waitForFunction(() => /triangles|Couldn't/.test(document.getElementById('modelViewerInfo').textContent), null, { timeout: 30000 });
    const info = await page.textContent('#modelViewerInfo');
    assert.match(info, /tripo\/a-low-wooden-treasure-chest\.glb · 1 triangles/);
    assert.deepEqual(errors, []);
});

test('a model from an attached picture uploads it first; limits per task, per day and on quality hold', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    const calls = await fakeTripo(page, { credits: 30 });
    const out = await page.evaluate(async key => {
        tripoKey = key;
        tripoQuality = 'standard';
        tripoModelsPerTask = 2;
        tripoDailyCredits = 100;
        const tools = buildTripoTools();
        const tool = tools.find(t => t.name === 'generate_3d_model');
        const picture = await shrinkDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 64);
        const ctx = { attachedImages: [picture] };
        const fromPicture = await tool.run({ image: 'attached', quality: 'detailed', low_poly: true }, ctx);
        const draft = await tool.run({ prompt: 'A cube', quality: 'draft' }, ctx);
        const perTask = await tool.run({ prompt: 'A third one' }, ctx);
        tripoDailyCredits = 70;
        const daily = await tool.run({ prompt: 'Over the day' }, {});
        tripoKey = '';
        const noKey = buildTripoTools().length;
        return { description: tool.description, fromPicture, draft, perTask, daily, noKey };
    }, KEY);
    const upload = calls.find(c => c.op === 'upload');
    assert.ok(upload && upload.base64.length > 50);
    assert.equal(upload.type, 'image/jpeg');
    const creates = calls.filter(c => c.method === 'POST');
    assert.equal(creates[0].path, '/generation/image-to-model');
    assert.equal(creates[0].body.input, 'file_abc123');
    // Detailed was asked for, but Settings says standard: agents can only go cheaper.
    assert.equal(creates[0].body.texture_quality, 'standard');
    assert.equal(creates[0].body.smart_low_poly, true);
    assert.equal(creates[0].body.face_limit, 5000);
    assert.equal(creates[1].path, '/generation/text-to-model');
    assert.equal(creates[1].body.texture, false);
    assert.match(out.description, /about 20 credits from a description, 30 from a picture/);
    assert.match(out.fromPicture, /Made the 3D model/);
    assert.match(out.draft, /Made the 3D model/);
    assert.match(out.perTask, /2 3D models is the limit for one task/);
    assert.match(out.daily, /would cost about 20 Tripo credits, and 60 of today's 70-credit limit is used/);
    assert.equal(creates.length, 2);
    assert.equal(out.noKey, 0);
    assert.deepEqual(errors, []);
});

test('a failed Tripo task is reported and not counted; a rejected key says where to fix it', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    await fakeTripo(page, { fail: true });
    const out = await page.evaluate(async key => {
        tripoKey = key;
        const tool = buildTripoTools()[0];
        const failed = await tool.run({ prompt: 'A chair' }, {});
        const used = tripoUsageToday().credits;
        tripoKey = 'tsk_wrong_key_for_codev_tests_000';
        const rejected = await tool.run({ prompt: 'A chair' }, {});
        return { failed, used, rejected };
    }, KEY);
    assert.match(out.failed, /task failed: bad prompt\. Failed tasks aren't charged/);
    assert.equal(out.used, 0);
    assert.match(out.rejected, /Tripo rejected the API key.*Settings > Tripo 3D models/);
    assert.deepEqual(errors, []);
});

test('generate_image can use Tripo, and a Tripo picture becomes a model without uploading it again', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    const calls = await fakeTripo(page);
    const out = await page.evaluate(async key => {
        tripoKey = key;
        imageProvider = 'tripo';
        const ctx = {};
        const tools = await buildMediaTools(ctx);
        const image = await tools.find(t => t.name === 'generate_image').run({ prompt: 'A robot mascot', aspect_ratio: '16:9' }, ctx);
        const name = ctx.generatedImages[0].name;
        const model = await tools.find(t => t.name === 'generate_3d_model').run({ image: name }, ctx);
        return { image, model, usage: tripoUsageToday() };
    }, KEY);
    const creates = calls.filter(c => c.method === 'POST');
    assert.equal(creates[0].path, '/generation/text-to-image');
    assert.equal(creates[0].body.size, '2560x1440');
    assert.match(out.image, /Made the picture .* with Tripo/);
    assert.equal(creates[1].path, '/generation/image-to-model');
    assert.equal(creates[1].body.input, 'task_1');
    assert.ok(!calls.some(c => c.op === 'upload'));
    assert.match(out.model, /Made the 3D model/);
    assert.deepEqual({ credits: out.usage.credits, pictures: out.usage.pictures, models: out.usage.models }, { credits: 25, pictures: 1, models: 1 });
    assert.deepEqual(errors, []);
});

test('Settings saves the Tripo key and limits, and Check shows the balance', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openPlainPage(t, []);
    await fakeTripo(page);
    await page.evaluate(() => openSettingsModal());
    await page.evaluate(() => { document.getElementById('tripoSettings').open = true; });
    await page.fill('#modalTripoKey', 'short');
    await page.click('#modalLaunchBtn');
    await page.waitForFunction(() => /Tripo API key/.test(document.getElementById('settingsError').textContent));
    await page.fill('#modalTripoKey', KEY);
    await page.click('#tripoSettings button:has-text("Check")');
    await page.waitForFunction(() => /Balance: 1234.5 credits \(about \$12\.35\)/.test(document.getElementById('tripoStatus').textContent));
    await page.selectOption('#modalTripoQuality', 'draft');
    await page.fill('#modalTripoPerTask', '1');
    await page.fill('#modalTripoDailyCredits', '40');
    await page.click('#modalLaunchBtn');
    await page.waitForFunction(key => localStorage.getItem('codev_tripo_key') === key, KEY);
    const saved = await page.evaluate(() => ({ quality: tripoQuality, perTask: tripoModelsPerTask, daily: tripoDailyCredits, stored: localStorage.getItem('codev_tripo_daily_credits') }));
    assert.deepEqual(saved, { quality: 'draft', perTask: 1, daily: 40, stored: '40' });
    assert.deepEqual(errors, []);
});

test('the relay sends the key only to Tripo\'s API, and downloads only public https files', async () => {
    const realFetch = global.fetch;
    const seen = [];
    global.fetch = async (url, options = {}) => {
        seen.push({ url: String(url), options });
        if (String(url).endsWith('.glb')) return new Response(GLB, { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
        return new Response(JSON.stringify({ code: 0, data: { task_id: 'task_9' } }), { status: 200 });
    };
    try {
        const created = await handleTripoRequest({ op: 'api', key: KEY, method: 'POST', path: '/generation/text-to-model', body: { prompt: 'A chair' } });
        assert.deepEqual(created, { status: 200, body: { code: 0, data: { task_id: 'task_9' } } });
        assert.equal(seen[0].url, 'https://openapi.tripo3d.com/v3/generation/text-to-model');
        assert.equal(seen[0].options.headers.Authorization, `Bearer ${KEY}`);
        assert.equal(JSON.parse(seen[0].options.body).prompt, 'A chair');

        const uploaded = await handleTripoRequest({ op: 'upload', key: KEY, name: 'p.png', type: 'image/png', base64: PNG_1PX.toString('base64') });
        assert.equal(uploaded.status, 200);
        assert.equal(seen[1].url, 'https://openapi.tripo3d.com/v3/files');
        assert.ok(seen[1].options.body instanceof FormData);

        assert.match((await handleTripoRequest({ op: 'api', key: KEY, method: 'GET', path: '/../../evil' })).error, /not allowed/);
        assert.match((await handleTripoRequest({ op: 'api', method: 'GET', path: '/account/balance' })).error, /No Tripo API key/);
        assert.match((await handleTripoRequest({ op: 'download', url: 'http://cdn.tripo3d.ai/model.glb' })).error, /public https/);
        assert.match((await handleTripoRequest({ op: 'download', url: 'https://127.0.0.1/model.glb' })).error, /public https/);
        const model = await handleTripoRequest({ op: 'download', url: 'https://cdn.tripo3d.ai/model.glb' });
        assert.equal(Buffer.from(model.base64, 'base64').equals(GLB), true);
        assert.equal(seen.length, 3);
        assert.equal(seen[2].options.headers, undefined);
    } finally {
        global.fetch = realFetch;
    }
});
