// Agents watching videos in their browsers (browser_watch_video, mobile/www/agent-ui/video-watch.js)
// and seeing the pictures their tools return (index.html sends them to Claude in the
// tool result). A short test video is made with ffmpeg when it's installed; the
// YouTube player is stood in for by a page on www.youtube.com answered by page.route,
// so no network is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const VW = require('../mobile/www/agent-ui/video-watch.js');
const { createBrowserService } = require('../desktop/browser');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage } = require('./helpers/page-driver');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const VTT = `WEBVTT

00:00:00.500 --> 00:00:03.000
First we sand the edges smooth.

00:00:04.000 --> 00:00:07.000
Then the primer goes on in thin coats.

00:00:08.000 --> 00:00:11.500
Last, the teal paint with a soft brush.
`;

function makeClip(dir) {
    const file = path.join(dir, 'clip.webm');
    // A counting picture and a tone, so there is something to see and something to hear.
    const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
        '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', '-b:a', '32k', '-shortest', '-y', file]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return file;
}

// A video answered the way real sites do, with byte ranges, which seeking needs.
function videoReply(clip, range) {
    const body = fs.readFileSync(clip);
    const m = /bytes=(\d+)-(\d*)/.exec(range || '');
    if (!m) return { status: 200, headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length) }, body };
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    return { status: 206, headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': String(end - start + 1) }, body: body.subarray(start, end + 1) };
}

async function startSite(t, clip) {
    const server = http.createServer((req, res) => {
        if (req.url === '/clip.webm') { const r = videoReply(clip, req.headers.range); res.writeHead(r.status, r.headers); return res.end(r.body); }
        if (req.url === '/caps.vtt') { res.writeHead(200, { 'Content-Type': 'text/vtt' }); return res.end(VTT); }
        if (req.url === '/watch') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<!doctype html><title>Painting a helmet</title><h1>How to paint a helmet</h1><video controls width="640" src="/clip.webm"><track kind="captions" srclang="en" src="/caps.vtt" default></video>');
        }
        if (req.url === '/nocaps') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<!doctype html><title>Talking head</title><video width="640" src="/clip.webm"></video>');
        }
        if (req.url === '/embed') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<!doctype html><title>Blog</title><p>My favourite tutorial:</p><iframe src="https://www.youtube.com/embed/abcDEF12345"></iframe>');
        }
        res.writeHead(404); res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}`;
}

// A stand-in for YouTube's watch page: its player API on #movie_player, an ad first
// (with a skip button), and a caption track YouTube serves as json3.
function fakeYouTube(base) {
    return `<!doctype html><title>Helmet paint tutorial - YouTube</title>
<h1 class="ytd-watch-metadata">Helmet paint tutorial</h1>
<div id="movie_player" class="html5-video-player ad-showing" style="width:640px;height:480px"><video src="/clip.webm" style="width:640px;height:480px"></video>
<button class="ytp-skip-ad-button" onclick="document.getElementById('movie_player').classList.remove('ad-showing')">Skip</button></div>
<div id="description-inline-expander">0:00 Sanding\n0:04 Primer\n0:08 Paint</div>
<script>
const p = document.getElementById('movie_player');
const v = p.querySelector('video');
p.getDuration = () => v.duration || 0;
p.seekTo = t => { v.currentTime = t; };
p.pauseVideo = () => v.pause();
p.playVideo = () => v.play().catch(() => {});
p.mute = () => { v.muted = true; };
p.getPlayerResponse = () => ({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [
  { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr', languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } },
  { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en', languageCode: 'en', name: { simpleText: 'English' } }
] } } });
</script>`;
}

const JSON3 = JSON.stringify({ events: [
    { tStartMs: 500, segs: [{ utf8: 'Sand the edges ' }, { utf8: 'smooth.' }] },
    { tStartMs: 4200, segs: [{ utf8: 'Prime in thin coats.' }] },
    { tStartMs: 8100, segs: [{ utf8: 'Teal paint, soft brush.' }] }
] });

test('times are read, written and spread across the video', () => {
    assert.equal(VW.parseTime('1:23'), 83);
    assert.equal(VW.parseTime('1:02:03'), 3723);
    assert.equal(VW.parseTime('90'), 90);
    assert.equal(VW.parseTime('1m30s'), 90);
    assert.ok(Number.isNaN(VW.parseTime('soon')));
    assert.equal(VW.formatTime(83), '1:23');
    assert.equal(VW.formatTime(3723), '1:02:03');
    assert.deepEqual(VW.planTimes(80, { frames: 4 }), [10, 30, 50, 70]);
    assert.deepEqual(VW.planTimes(600, { start: '1:00', end: '2:00', frames: 3 }), [70, 90, 110]);
    assert.deepEqual(VW.planTimes(600, { at: ['0:42', '0:10', 'bad', '0:42'] }), [10, 42]);
    assert.deepEqual(VW.planTimes(60, { start: 0, end: 20, every: 10 }), [0, 10, 20]);
    assert.equal(VW.planTimes(3600, { frames: 500 }).length, VW.MAX_FRAMES);
    assert.deepEqual(VW.planTimes(60, { frames: 0 }), []);
    assert.deepEqual(VW.parseCaptions(JSON3).map(l => l.t), [0.5, 4.2, 8.1]);
    assert.match(VW.transcriptText(VW.parseCaptions(JSON3), 1000), /^\[0:00\] Sand the edges smooth\./);
});

test('an agent watches a video in its browser: frames it can see, plus what is said', async t => {
    if (!hasFfmpeg) return t.skip('ffmpeg is not installed, so there is no test video');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-video-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const base = await startSite(t, makeClip(dir));
    const service = createBrowserService({ dataDir: path.join(dir, 'data'), profileRoot: path.join(dir, 'profiles'), passphrase: 'test', keepSignIns: false, log: () => {} });
    t.after(() => service.close());
    const ctx = service.context({ 'codev/agentId': 'watcher' });
    assert.ok(service.tools.some(tool => tool.name === 'browser_watch_video'));

    // Not open yet: told to open the page first.
    const early = await service.callTool('browser_watch_video', {}, ctx);
    assert.equal(early.isError, true);
    assert.match(early.content[0].text, /browser_navigate first/);

    await service.callTool('browser_navigate', { url: `${base}/watch` }, ctx);
    const watched = await service.callTool('browser_watch_video', { frames: 4 }, ctx);
    assert.equal(watched.isError, false, JSON.stringify(watched.content.filter(c => c.type === 'text')));
    const images = watched.content.filter(c => c.type === 'image');
    assert.equal(images.length, 4);
    for (const img of images) {
        assert.equal(img.mimeType, 'image/jpeg');
        assert.ok(Buffer.from(img.data, 'base64').length > 1000, 'a real picture');
    }
    const at = watched.structuredContent.frames.map(f => f.at);
    assert.ok(at.every((x, i) => !i || x > at[i - 1] + 2), `frames spread across the clip: ${at}`);
    assert.ok(at[0] < 3 && at[3] > 9, `${at}`);
    const all = watched.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    assert.match(all, /Watched "Painting a helmet"/);
    assert.match(all, /Words: the video's caption track/);
    assert.match(all, /Frame 1 at 0:0\d.*Said around then: "First we sand the edges smooth\."/);
    assert.match(all, /\[Transcript\]\n\[0:0\d\] First we sand/);
    // Each frame differs (the test video counts frames), so they are really from different moments.
    assert.equal(new Set(images.map(i => i.data)).size, 4);

    // A closer look at one stretch, and at exact moments.
    const close = await service.callTool('browser_watch_video', { start: '0:04', end: '0:07', frames: 3, transcript: false }, ctx);
    assert.deepEqual(close.structuredContent.frames.map(f => f.at), [4.5, 5.5, 6.5]);
    assert.doesNotMatch(close.content.map(c => c.text || '').join('\n'), /\[Transcript/);
    const exact = await service.callTool('browser_watch_video', { at: ['0:09', '0:01'], transcript: false }, ctx);
    assert.deepEqual(exact.structuredContent.frames.map(f => f.at), [1, 9]);

    // A page that embeds a video points the agent at the video's own page.
    await service.callTool('browser_navigate', { url: `${base}/embed` }, ctx);
    const embedded = await service.callTool('browser_watch_video', {}, ctx);
    assert.equal(embedded.isError, true);
    assert.match(embedded.content[0].text, /https:\/\/www\.youtube\.com\/watch\?v=abcDEF12345/);
});

test('on YouTube it waits out the ad, uses the player, and reads the real caption track', async t => {
    if (!hasFfmpeg) return t.skip('ffmpeg is not installed, so there is no test video');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    await launched.browser.close();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-video-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const clip = makeClip(dir);
    const base = await startSite(t, clip);
    const service = createBrowserService({ dataDir: path.join(dir, 'data'), profileRoot: path.join(dir, 'profiles'), passphrase: 'test', keepSignIns: false, log: () => {} });
    t.after(() => service.close());
    const ctx = service.context({ 'codev/agentId': 'yt' });
    const { context } = await service.manager.get('yt');
    const asked = [];
    await context.route('https://www.youtube.com/**', route => {
        const url = route.request().url();
        if (url.includes('/api/timedtext')) { asked.push(url); return route.fulfill({ contentType: 'application/json', body: JSON3 }); }
        if (url.endsWith('/clip.webm')) { const r = videoReply(clip, route.request().headers().range); return route.fulfill({ status: r.status, headers: r.headers, body: r.body }); }
        return route.fulfill({ contentType: 'text/html', body: fakeYouTube(base) });
    });
    await service.callTool('browser_navigate', { url: 'https://www.youtube.com/watch?v=abc' }, ctx);
    const watched = await service.callTool('browser_watch_video', { frames: 3 }, ctx);
    assert.equal(watched.isError, false, JSON.stringify(watched.content.filter(c => c.type === 'text')));
    assert.equal(watched.content.filter(c => c.type === 'image').length, 3);
    const all = watched.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    assert.match(all, /An ad played first/);
    assert.match(all, /Words: YouTube captions: English\b(?! \(automatic\))/, 'the author\'s captions are picked over the automatic ones');
    assert.match(all, /also on the video: English \(auto-generated\) \(automatic\), English/);
    assert.match(all, /\[Video description\]\n0:00 Sanding/);
    assert.match(all, /Teal paint, soft brush\./);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /lang=en&fmt=json3$/);
});

test("the phone's way (no async in the page) works with the shared watcher", async t => {
    if (!hasFfmpeg) return t.skip('ffmpeg is not installed, so there is no test video');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-video-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const base = await startSite(t, makeClip(dir));
    const page = await launched.browser.newPage();
    await page.goto(`${base}/watch`);
    let captured = 0;
    // As phone-browser.js does: the script is run and its JSON text parsed, nothing awaited.
    const adapter = {
        evaluate: async (source, arg) => JSON.parse(await page.evaluate(`JSON.stringify((${source})(${JSON.stringify(arg)}))`)),
        capture: async () => { captured++; return { data: (await page.screenshot({ type: 'jpeg' })).toString('base64'), mimeType: 'image/jpeg' }; },
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        now: () => Date.now()
    };
    const watched = await VW.watchVideo(adapter, { frames: 2 });
    assert.equal(watched.frames.length, 2);
    assert.ok(watched.frames.every(f => f.exact && Math.abs(f.actual - f.t) < 0.5), JSON.stringify(watched.frames.map(f => [f.t, f.actual])));
    assert.equal(captured, 0, 'frames are drawn from the video itself, not screenshots');
    assert.equal(watched.lines.length, 3);
    const result = VW.toolResult(watched, {});
    assert.equal(result.content.filter(c => c.type === 'image').length, 2);
});

test("Claude sees the pictures a tool returns; other providers don't get them in the request", async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-video-page-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, {});
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DwnwEJMDGgAQBEHQIBWnTFEgAAAABJRU5ErkJggg==';
    const out = await page.evaluate(async png => {
        const seen = await toolImagesForModel([{ type: 'text', text: 'Frame 1' }, { type: 'image', data: png, mimeType: 'image/png' }]);
        const request = toAnthropicRequest({ messages: [
            { role: 'user', content: 'watch it' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'browser_watch_video', arguments: '{}' } }] },
            { role: 'tool', tool_call_id: 'c1', name: 'browser_watch_video', content: 'Frame 1\n[picture 1: attached for you to look at]', images: seen }
        ] });
        const msgs = [{ role: 'tool', content: 'x', images: seen }];
        for (let i = 0; i < 60; i++) msgs.push({ role: 'tool', content: `step ${i}`, images: [seen[0]] });
        trimToolImages(msgs);
        return { seen, result: request.messages[2].content[0], kept: msgs.reduce((n, m) => n + (m.images ? m.images.length : 0), 0), dropped: msgs[1].content };
    }, png);
    assert.equal(out.seen.length, 1);
    assert.match(out.seen[0], /^data:image\/jpeg;base64,/, 'PNGs are sent as JPEG');
    assert.equal(out.result.type, 'tool_result');
    assert.equal(out.result.content[0].type, 'text');
    assert.deepEqual(out.result.content[1], { type: 'text', text: 'Picture 1:' });
    assert.equal(out.result.content[2].type, 'image');
    assert.equal(out.result.content[2].source.media_type, 'image/jpeg');
    assert.equal(out.kept, 48);
    assert.match(out.dropped, /pictures from this step were dropped/);
    assert.deepEqual(errors, []);
});

test('a video with no captions is listened to: its sound recorded in the browser, its speech written out by Whisper', async t => {
    if (!hasFfmpeg) return t.skip('ffmpeg is not installed, so there is no test video');
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-video-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const base = await startSite(t, makeClip(dir));
    const service = createBrowserService({ dataDir: path.join(dir, 'data'), profileRoot: path.join(dir, 'profiles'), passphrase: 'test', keepSignIns: false, log: () => {} });
    t.after(() => service.close());
    const ctx = service.context({ 'codev/agentId': 'listener' });
    await service.callTool('browser_navigate', { url: `${base}/nocaps` }, ctx);
    const watched = await service.callTool('browser_watch_video', { frames: 2, start: '0:02', max_listen_seconds: 3 }, ctx);
    assert.equal(watched.isError, false, JSON.stringify(watched.content.filter(c => c.type === 'text')));
    const all = watched.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    assert.match(all, /Words: no captions, so the sound from 0:02 to 0:0[45] was recorded/);
    assert.match(all, /Listened to 0:02-0:05 .*call again with start 0:05/);
    const audio = watched.structuredContent.audio;
    assert.ok(audio && audio.data.length > 1000, 'the sound was recorded');
    assert.equal(audio.mimeType, 'audio/webm');
    assert.equal(audio.start, 2);
    assert.ok(audio.heard > 0.5, `the tone was heard (${audio.heard})`);
    // Captions there: no listening unless asked; listen false never.
    await service.callTool('browser_navigate', { url: `${base}/watch` }, ctx);
    const captioned = await service.callTool('browser_watch_video', { frames: 1 }, ctx);
    assert.equal(captioned.structuredContent.audio, undefined);
    await service.callTool('browser_navigate', { url: `${base}/nocaps` }, ctx);
    const quiet = await service.callTool('browser_watch_video', { frames: 1, listen: false }, ctx);
    assert.equal(quiet.structuredContent.audio, undefined);

    // The page writes the speech out with Groq Whisper, times counted from where listening began.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-video-page-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, {});
    const sent = [];
    await page.route('https://api.groq.com/openai/v1/audio/transcriptions', route => {
        sent.push(route.request().postDataBuffer().toString('latin1'));
        route.fulfill({ contentType: 'application/json', body: JSON.stringify({ text: 'hello there', segments: [{ start: 0.4, text: ' Hello there.' }, { start: 61, text: ' Second part.' }] }) });
    });
    const out = await page.evaluate(async audio => {
        groqKey = '';
        const before = await transcribeVideoSound(audio);
        groqKey = 'gsk_test';
        return { before, after: await transcribeVideoSound(audio) };
    }, audio);
    assert.match(out.before, /needs a free Groq key/);
    assert.match(out.after, /\[What is said in the video, from its sound \(Groq Whisper, speech only\)/);
    assert.match(out.after, /\[0:02\] Hello there\.\n\[1:03\] Second part\./);
    assert.match(sent[0], /name="response_format"\r\n\r\nverbose_json/);
    assert.match(sent[0], /filename="video-sound\.webm"/);
    assert.deepEqual(errors, []);
});
