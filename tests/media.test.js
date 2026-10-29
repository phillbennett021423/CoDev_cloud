// Video and audio editing (desktop/media and agent-ui/media-studio.js):
//  1. file names and paths can't leave the media folder;
//  2. through the real server.js: uploads, downloads (with Range, for the
//     player), the own-page checks, and the media_* tools over /agent-tools;
//  3. with Docker and a media image (CODEV_MEDIA_IMAGE, or codev-media:local):
//     a real edit runs in a container and the new file comes back.
// Run: npm run test:agents (or node --test tests/media.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createMedia, safeName, kindOf } = require('../desktop/media');
const { createMediaStudio, httpTransport } = require('../mobile/www/agent-ui/media-studio');

const ROOT = path.join(__dirname, '..');
const dockerUp = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).status === 0;
const testImage = process.env.CODEV_MEDIA_IMAGE || 'codev-media:local';
const hasImage = dockerUp && spawnSync('docker', ['image', 'inspect', testImage], { encoding: 'utf8' }).status === 0;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function startServer(scratch, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['server.js'], {
            cwd: ROOT, windowsHide: true,
            env: { ...process.env, PORT: '0', CODEV_DATA_DIR: path.join(scratch, 'data'), XDG_CONFIG_HOME: path.join(scratch, 'config'), APPDATA: path.join(scratch, 'config'), ...env }
        });
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error(`server.js didn't start:\n${output}`)); }, 60000);
        const onData = chunk => {
            output += chunk;
            const m = /running at (http:\/\/localhost:\d+)/.exec(output);
            if (m) { clearTimeout(timer); resolve({ child, url: m[1] }); }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`server.js exited with ${code}:\n${output}`)); });
    });
}

function stopServer(server) {
    return new Promise(resolve => {
        if (!server || server.child.exitCode !== null) return resolve();
        server.child.removeAllListeners('exit');
        server.child.on('exit', () => resolve());
        server.child.kill('SIGINT');
        setTimeout(() => { server.child.kill('SIGKILL'); resolve(); }, 15000).unref();
    });
}

test('file names are cleaned and kinds are known', () => {
    assert.equal(safeName('My Clip!.MP4'), 'My-Clip.mp4');
    assert.equal(safeName('../../etc/passwd'), 'passwd');
    assert.equal(safeName('C:\\Users\\me\\song (live).mp3'), 'song-live.mp3');
    assert.equal(kindOf('a.mov'), 'video');
    assert.equal(kindOf('a.flac'), 'audio');
    assert.equal(kindOf('a.exe'), null);
});

test('uploads stay in the media folder and only media is accepted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-media-'));
    try {
        const media = createMedia({ dataDir: dir });
        const saved = await media.saveUpload({}, '../escape.mp4', Buffer.from('x'));
        assert.equal(saved.name, 'uploads/escape.mp4');
        assert.ok(fs.existsSync(path.join(dir, 'media', 'uploads', 'escape.mp4')));
        const again = await media.saveUpload({}, 'escape.mp4', Buffer.from('y'));
        assert.equal(again.name, 'uploads/escape-2.mp4');
        await assert.rejects(media.saveUpload({}, 'run.exe', Buffer.from('x')), /only videos, audio and pictures/);
        assert.throws(() => media.openFile({}, '../../secret.txt'), /isn't in the media folder/);
        assert.throws(() => media.openFile({}, '.jobs/x.json'), /isn't in the media folder/);
        assert.deepEqual(media.listFiles({}).map(f => f.name).sort(), ['uploads/escape-2.mp4', 'uploads/escape.mp4']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('on a server, each user has a folder and the host decides who may edit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-media-'));
    try {
        const media = createMedia({ dataDir: dir, resolveUser: ctx => ctx.user, authorize: ctx => (ctx.plan === 'max' ? null : 'Video editing is part of the Max plan.') });
        await media.saveUpload({ user: 'ann' }, 'a.mp4', Buffer.from('x'));
        assert.ok(fs.existsSync(path.join(dir, 'media', 'users', 'ann', 'uploads', 'a.mp4')));
        assert.equal(media.listFiles({ user: 'bob' }).length, 0);
        const refused = await media.callTool('media_edit', { input: 'a.mp4', steps: [{ op: 'mute' }] }, { user: 'ann', plan: 'pro' });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, /Max plan/);
        if (dockerUp) assert.ok(!(await media.listTools()).some(t => t.name === 'media_import'), 'no "user\'s computer" tools on a server');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('server.js: upload, play with Range, download, and the own-page checks', async t => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-media-server-'));
    let server;
    try {
        server = await startServer(scratch);
        const base = server.url;
        const body = Buffer.from('0123456789'.repeat(100));
        // Another website can't upload.
        let res = await fetch(`${base}/agent/media/upload?name=clip.mp4`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/octet-stream' }, body });
        assert.equal(res.status, 403);
        res = await fetch(`${base}/agent/media/upload?name=my%20clip.mp4`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/octet-stream' }, body });
        assert.equal(res.status, 200);
        const saved = await res.json();
        assert.equal(saved.name, 'uploads/my-clip.mp4');
        assert.equal(saved.size, 1000);

        res = await fetch(`${base}/agent/media/download?name=${encodeURIComponent(saved.name)}`, { headers: { Range: 'bytes=10-19' } });
        assert.equal(res.status, 206);
        assert.equal(res.headers.get('content-range'), 'bytes 10-19/1000');
        assert.equal(await res.text(), '0123456789');
        res = await fetch(`${base}/agent/media/download?name=${encodeURIComponent(saved.name)}&download=1`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-disposition'), /attachment/);
        assert.equal((await res.arrayBuffer()).byteLength, 1000);
        res = await fetch(`${base}/agent/media/download?name=..%2F..%2Fpackage.json`);
        assert.equal(res.status, 404);

        res = await fetch(`${base}/agent/media/files`);
        assert.deepEqual((await res.json()).map(f => f.name), ['uploads/my-clip.mp4']);

        // The page's client, over the same routes.
        const studio = createMediaStudio({ transport: httpTransport({ baseUrl: base, fetch: (url, opts = {}) => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Origin: base } }) }) });
        const status = await studio.status(true);
        assert.equal(typeof status.available, 'boolean');
        if (!dockerUp) return t.skip('Docker isn\'t running, so the media tools aren\'t offered');
        const ctx = { agentId: 'a1' };
        const tools = await studio.buildTools(ctx);
        assert.ok(tools.some(tool => tool.name === 'media_edit'));
        const listing = await tools.find(tool => tool.name === 'media_files').run({}, ctx);
        assert.match(listing, /uploads\/my-clip\.mp4/);
    } finally {
        await stopServer(server);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test('a real edit in the media container', { skip: !hasImage || !hasFfmpeg ? `needs Docker, ffmpeg and the ${testImage} image` : false }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-media-'));
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    try {
        spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(src, 'clip.mp4')]);
        spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=2', path.join(src, 'song.mp3')]);
        const media = createMedia({ dataDir: dir, image: testImage });
        await media.saveUpload({}, 'clip.mp4', fs.readFileSync(path.join(src, 'clip.mp4')));
        await media.saveUpload({}, 'song.mp3', fs.readFileSync(path.join(src, 'song.mp3')));
        const result = await media.callTool('media_edit', { input: 'clip.mp4', steps: [{ op: 'reframe', aspect: '9:16' }, { op: 'add_music', file: 'song.mp3', volume: 0.15 }, { op: 'trim', start: 1, end: 3 }], output_name: 'reel' });
        assert.equal(result.isError, false, result.content[0].text);
        assert.deepEqual(result._meta['codev/mediaFiles'].map(f => f.name), ['outputs/reel.mp4']);
        assert.match(result.content[0].text, /1080x1920/);
        const bad = await media.callTool('media_edit', { input: 'clip.mp4', steps: [{ op: 'explode' }] });
        assert.equal(bad.isError, true);
        assert.match(bad.content[0].text, /unknown op/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
