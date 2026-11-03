// The cloud 3D worker's CoDev side (desktop/creative/cloud-worker.js) against a
// stand-in GitHub: the job goes up as a draft release with relative paths, the
// workflow is started, the results come back into the project where a local
// Blender would have put them, and the release is deleted. The Python worker's
// path handling is checked too; Blender itself runs in the workflow's self-test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createCloudWorker, toLocal } = require('../desktop/creative/cloud-worker');
const { createCreativeService } = require('../desktop/creative');

function textOf(result) { return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'); }

// A stand-in GitHub. onDispatch(job, files) plays the workflow and returns
// { report, files: { 'out/...': Buffer } } (or null to never answer).
function fakeGitHub({ onDispatch, conclusion = 'success' } = {}) {
    const calls = [];
    const releases = new Map();
    const runs = [];
    let nextId = 100;
    const json = (status, body) => ({ status, ok: status < 300, headers: new Map(), json: async () => body, arrayBuffer: async () => Buffer.from(JSON.stringify(body)) });
    const bytes = buf => ({ status: 200, ok: true, headers: new Map(), arrayBuffer: async () => buf, json: async () => JSON.parse(buf.toString()) });
    async function fetchImpl(url, opts = {}) {
        const method = opts.method || 'GET';
        calls.push({ method, url, auth: opts.headers && opts.headers.Authorization });
        let m;
        if (url.startsWith('https://storage.example/')) return bytes(Buffer.from(decodeURIComponent(url.split('/').pop()), 'base64'));
        if (method === 'POST' && /\/repos\/me\/studio\/releases$/.test(url)) {
            const id = nextId++;
            releases.set(id, { id, ...JSON.parse(opts.body), assets: [] });
            return json(201, { id, upload_url: `https://uploads.github.com/repos/me/studio/releases/${id}/assets{?name,label}` });
        }
        if ((m = url.match(/uploads\.github\.com\/repos\/me\/studio\/releases\/(\d+)\/assets\?name=(.+)$/))) {
            const rel = releases.get(Number(m[1]));
            const asset = { id: nextId++, name: decodeURIComponent(m[2]), data: Buffer.from(opts.body) };
            rel.assets.push(asset);
            return json(201, { id: asset.id, name: asset.name });
        }
        if ((m = url.match(/\/releases\/(\d+)\/assets\?per_page/))) return json(200, releases.get(Number(m[1])).assets.map(a => ({ id: a.id, name: a.name })));
        if ((m = url.match(/\/releases\/assets\/(\d+)$/))) {
            const asset = [...releases.values()].flatMap(r => r.assets).find(a => a.id === Number(m[1]));
            return { status: 302, ok: false, headers: new Map([['location', `https://storage.example/${encodeURIComponent(asset.data.toString('base64'))}`]]) };
        }
        if ((m = url.match(/\/actions\/workflows\/cloud-3d\.yml\/dispatches$/))) {
            const { ref, inputs } = JSON.parse(opts.body);
            const rel = releases.get(Number(inputs.release_id));
            runs.push({ display_title: `3D job ${inputs.job_id}`, status: 'completed', conclusion, html_url: 'https://github.com/me/studio/actions/runs/1', ref });
            const job = JSON.parse(rel.assets.find(a => a.name === 'job.json').data);
            const files = Object.fromEntries(rel.assets.filter(a => a.name.startsWith('in__')).map(a => [`in/${a.name.slice(4)}`, a.data]));
            const out = onDispatch && onDispatch(job, files);
            if (out) {
                const cloudFiles = {};
                let n = 0;
                for (const [rel2, data] of Object.entries(out.files || {})) {
                    const name = `o${++n}_${path.basename(rel2)}`;
                    rel.assets.push({ id: nextId++, name, data });
                    cloudFiles[name] = rel2;
                }
                rel.assets.push({ id: nextId++, name: 'result.json', data: Buffer.from(JSON.stringify({ ...out.report, cloud_files: cloudFiles, cloud_seconds: 42 })) });
            }
            return { status: 204, ok: true, headers: new Map(), json: async () => null };
        }
        if (/\/actions\/workflows\/cloud-3d\.yml\/runs/.test(url)) return json(200, { workflow_runs: runs });
        if (method === 'DELETE' && (m = url.match(/\/releases\/(\d+)$/))) { releases.delete(Number(m[1])); return { status: 204, ok: true, headers: new Map() }; }
        return json(404, { message: 'Not Found' });
    }
    return { fetchImpl, calls, releases, runs };
}

const ENV = { CODEV_CLOUD_TOKEN: 'github_pat_test', CODEV_CLOUD_REPO: 'me/studio', CODEV_COMFYUI_URL: 'http://127.0.0.1:1' };

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-cloud-'));
    fs.mkdirSync(path.join(dir, 'refs'));
    return dir;
}

test('settings: off, missing, ready; auto uses the cloud only when Blender is missing', () => {
    assert.equal(createCloudWorker({ env: {} }).configured(), false);
    assert.match(createCloudWorker({ env: {} }).describe(), /not set up.*CODEV_CLOUD_TOKEN/);
    assert.equal(createCloudWorker({ env: { ...ENV, CODEV_CLOUD_3D: 'off' } }).configured(), false);
    const w = createCloudWorker({ env: { ...ENV, CODEV_CLOUD_REPO: 'https://github.com/me/studio.git' } });
    assert.equal(w.configured(), true);
    assert.match(w.describe(), /ready on me\/studio/);
});

test('paths from the worker map back into the project and never outside it', () => {
    const job = { output: '/p/art/models/hat.glb', out_dir: '/p/art/reviews/hat' };
    const inputs = { '/p/refs/hat.glb': 'in/0_hat.glb' };
    assert.equal(toLocal('out/output/hat.glb', job, inputs), '/p/art/models/hat.glb');
    assert.equal(toLocal('out/dir/hat_front.png', job, inputs), path.join('/p/art/reviews/hat', 'hat_front.png'));
    assert.equal(toLocal('in/0_hat.glb', job, inputs), '/p/refs/hat.glb');
    assert.equal(toLocal('out/dir/../../../etc/passwd', job, inputs), '');
});

test('art_mesh runs a review on the cloud worker when Blender is not on this computer', async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'refs', 'hat.glb'), 'glb-bytes');
    let seen;
    const gh = fakeGitHub({
        onDispatch(job, files) {
            seen = { job, files };
            const views = Object.fromEntries(['front', 'back', 'left', 'right', 'top', 'below', 'face', 'game'].map(v => [v, `out/dir/hat_${v}.png`]));
            return {
                report: { ok: true, op: 'review', triangles: 900, views, engine: 'CYCLES', mesh_checks: { open_edges_visible: 0, flipped_visible: 0, hidden_tris: 0, total_tris: 900 }, image_checks: {} },
                files: Object.fromEntries(Object.values(views).map(f => [f, Buffer.from('png')]))
            };
        }
    });
    const svc = createCreativeService({ getProjectDir: () => dir, env: ENV, fetchImpl: gh.fetchImpl, findBlender: () => '',
        cloud: createCloudWorker({ env: ENV, fetchImpl: gh.fetchImpl, sleep: async () => {}, pollMs: 0 }) });
    const res = await svc.callTool('art_mesh', { op: 'review', input: 'refs/hat.glb', name: 'hat', no_preview: true });
    const out = textOf(res);
    assert.ok(!res.isError, out);
    assert.match(out, /Ran on the cloud 3D worker in 42s/);
    assert.match(out, /from 8 angle\(s\)/);
    // The job that went up has only relative paths and the CPU renderer is the worker's call.
    assert.equal(seen.job.op, 'review');
    assert.equal(seen.job.input, 'in/0_hat.glb');
    assert.equal(seen.job.out_dir, 'out/dir');
    assert.equal(seen.job.result, 'out/result.json');
    assert.ok(!JSON.stringify(seen.job).includes(dir), 'no local paths leave the computer');
    assert.equal(seen.files['in/0_hat.glb'].toString(), 'glb-bytes');
    // The renders landed where local Blender would have put them.
    assert.equal(res.structuredContent.views.front, 'art/reviews/hat/hat_front.png');
    assert.ok(fs.existsSync(path.join(dir, 'art/reviews/hat/hat_game.png')));
    // The token went to GitHub only, never to the storage redirect; the release is gone.
    assert.ok(gh.calls.filter(c => c.url.startsWith('https://storage.example/')).every(c => !c.auth));
    assert.equal(gh.releases.size, 0);
    assert.equal(gh.runs[0].ref, 'main');
});

test('art_mesh cleanup in the cloud saves the .glb in the models folder; failures say why', async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'refs', 'blade.glb'), 'glb');
    const gh = fakeGitHub({
        onDispatch(job) {
            assert.equal(job.output, 'out/output/weapon_plasma_blade_lod0.glb');
            assert.equal(job.target_tris, 5000);
            return { report: { ok: true, op: 'cleanup', output: job.output, before_triangles: 80000, triangles: 4990 }, files: { [job.output]: Buffer.from('small') } };
        }
    });
    const cloud = createCloudWorker({ env: ENV, fetchImpl: gh.fetchImpl, sleep: async () => {}, pollMs: 0 });
    const svc = createCreativeService({ getProjectDir: () => dir, env: ENV, fetchImpl: gh.fetchImpl, findBlender: () => '/usr/bin/blender-not-used', cloud });
    const res = await svc.callTool('art_mesh', { op: 'cleanup', input: 'refs/blade.glb', category: 'weapon', name: 'Plasma Blade', where: 'cloud' });
    assert.ok(!res.isError, textOf(res));
    assert.match(textOf(res), /Triangles: 80000 → 4990/);
    assert.equal(res.structuredContent.output, 'art/models/weapon_plasma_blade_lod0.glb');
    assert.equal(fs.readFileSync(path.join(dir, 'art/models/weapon_plasma_blade_lod0.glb'), 'utf8'), 'small');

    const failing = fakeGitHub({ onDispatch: () => ({ report: { ok: false, op: 'uv', error: 'no mesh in the input', cloud_run: 'https://github.com/me/studio/actions/runs/9' } }) });
    const svc2 = createCreativeService({ getProjectDir: () => dir, env: ENV, findBlender: () => '', cloud: createCloudWorker({ env: ENV, fetchImpl: failing.fetchImpl, sleep: async () => {}, pollMs: 0 }) });
    const bad = await svc2.callTool('art_mesh', { op: 'uv', input: 'refs/blade.glb' });
    assert.ok(bad.isError);
    assert.match(textOf(bad), /failed in the cloud: no mesh in the input[\s\S]*actions\/runs\/9/);

    // A run that dies before writing a result is reported with its link instead of waiting forever.
    const dead = fakeGitHub({ onDispatch: () => null, conclusion: 'failure' });
    const svc3 = createCreativeService({ getProjectDir: () => dir, env: ENV, findBlender: () => '', cloud: createCloudWorker({ env: ENV, fetchImpl: dead.fetchImpl, sleep: async () => {}, pollMs: 0 }) });
    const gone = await svc3.callTool('art_mesh', { op: 'inspect', input: 'refs/blade.glb' });
    assert.match(textOf(gone), /ended \(failure\) without a result: https:\/\/github.com\/me\/studio\/actions\/runs\/1/);
    assert.equal(dead.releases.size, 0);
});

test('without Blender or the cloud worker, art_mesh says how to get either', async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'refs', 'a.glb'), 'glb');
    const svc = createCreativeService({ getProjectDir: () => dir, env: { CODEV_COMFYUI_URL: 'http://127.0.0.1:1' }, findBlender: () => '' });
    const res = await svc.callTool('art_mesh', { op: 'inspect', input: 'refs/a.glb' });
    assert.ok(res.isError);
    assert.match(textOf(res), /blender\.org[\s\S]*CODEV_CLOUD_REPO and CODEV_CLOUD_TOKEN/);
    assert.match(textOf(await svc.callTool('art_mesh', { op: 'inspect', input: 'refs/a.glb', where: 'cloud' })), /not set up/);
});

test('the Python worker turns job paths absolute and the report back to relative', { skip: process.platform === 'win32' }, () => {
    const code = [
        'import sys, json; sys.path.insert(0, "desktop/creative/bpy"); import cloud_worker as w',
        'job = {"input": "in/0_a.glb", "maps": {"albedo": "in/1_b.png"}, "out_dir": "out/dir", "name": "inside", "views": ["front"]}',
        'a = w.absolute(job, "/runner/work")',
        'r = w.relative({"views": {"front": "/runner/work/out/dir/x.png"}, "n": 3}, "/runner/work")',
        'print(json.dumps([a, r]))'
    ].join('\n');
    const [abs, rel] = JSON.parse(execFileSync('python3', ['-c', code], { cwd: path.join(__dirname, '..') }).toString());
    assert.equal(abs.input, '/runner/work/in/0_a.glb');
    assert.equal(abs.maps.albedo, '/runner/work/in/1_b.png');
    assert.equal(abs.name, 'inside');
    assert.deepEqual(rel, { views: { front: 'out/dir/x.png' }, n: 3 });
});
