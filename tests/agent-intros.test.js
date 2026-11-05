// Each agent introduces itself the first time its chat opens (mobile/www/agent-ui/agent-intros.js):
// the scripts, the once-per-agent rule, and the real page on a phone-sized screen.
// Run: node --test tests/agent-intros.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Intros = require('../mobile/www/agent-ui/agent-intros.js');
const { memoryStorage } = require('./helpers/tool-catalog');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser } = require('./helpers/page-driver');

const html = fs.readFileSync(path.join(__dirname, '../mobile/www/index.html'), 'utf8');

test('every developer role has an intro with a headline, lines, a closer and three starters', () => {
    const roles = [...html.matchAll(/<option value="(\w+)">/g)].map(m => m[1]).filter(r => /^(general|architect|swarm|self_healing|game_engine|architecture)$/.test(r));
    assert.equal(roles.length, 6);
    for (const role of roles) {
        const s = Intros.SCRIPTS[role];
        assert.ok(s, role);
        assert.match(s.headline, /\{name\}/, `${role} says its own name`);
        assert.ok(s.lines.length >= 2 && s.closer && s.starters.length === 3, role);
        for (const st of s.starters) assert.ok(st.icon && st.label && typeof st.prompt === 'string', role);
    }
});

test('an intro uses the agent\'s name and leaves out desktop-only tools on a phone', () => {
    const agent = { id: 'agent_1', name: 'Nova', devRole: 'architect' };
    const phone = Intros.introFor(agent, { desktop: false });
    const pc = Intros.introFor(agent, { desktop: true });
    assert.equal(phone.headline, "I'm Nova. I don't give advice. I ship.");
    assert.ok(!phone.lines.some(l => /Blender|Godot and/.test(l)));
    assert.ok(pc.lines.some(l => /Blender/.test(l)));
    // No phone intro promises the PC's browser, Godot runs or Blender.
    for (const role of Object.keys(Intros.SCRIPTS)) {
        const text = Intros.plainText(Intros.introFor({ id: 'x', name: 'X', devRole: role }, { desktop: false }));
        assert.doesNotMatch(text, /Blender|my own browser|run Godot itself/, role);
        assert.doesNotMatch(text, /\{name\}/, role);
    }
    // An unknown role falls back to the general intro.
    assert.equal(Intros.introFor({ id: 'y', name: 'Y', devRole: 'nope' }).role, 'general');
});

test('the card escapes names and carries its buttons', () => {
    const intro = Intros.introFor({ id: 'a"1', name: '<b>Bad</b>', devRole: 'swarm' });
    const card = Intros.cardHtml(intro);
    assert.doesNotMatch(card, /<b>Bad<\/b>/);
    assert.match(card, /&lt;b&gt;Bad/);
    assert.equal((card.match(/data-intro-starter=/g) || []).length, 3);
    assert.match(card, /data-intro-action="speak"/);
    assert.match(card, /data-intro-action="replay"/);
});

test('each agent is introduced once per device, and can be forgotten for a replay', () => {
    const storage = memoryStorage();
    const t = Intros.createTracker(storage);
    assert.equal(t.seen('agent_1'), false);
    t.markSeen('agent_1');
    t.markSeen('agent_1');
    assert.equal(t.seen('agent_1'), true);
    assert.deepEqual(JSON.parse(storage.getItem(Intros.SEEN_KEY)), ['agent_1']);
    assert.equal(Intros.createTracker(storage).seen('agent_1'), true);
    t.forget('agent_1');
    assert.equal(t.seen('agent_1'), false);
    storage.setItem(Intros.SEEN_KEY, 'not json');
    assert.equal(Intros.createTracker(storage).seen('agent_1'), false);
});

test('on a phone, a new user gets the setup guide first, then the open agent\'s intro, once', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-intros-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const page = await launched.browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
        localStorage.setItem('codev_chime', '0');
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#welcomeModal');
    // Not behind the setup guide.
    await page.waitForTimeout(600);
    assert.equal(await page.$('.agent-intro'), null);
    await page.click('#welcomeSkip');
    await page.waitForSelector('.agent-intro');
    assert.match(await page.textContent('.agent-intro .intro-headline'), /I'm Architect\. I don't give advice\. I ship\./);
    assert.equal(await page.textContent('#activeWorkspaceTitle'), 'Architect');
    // Nothing wider than the phone.
    assert.ok(await page.evaluate(() => document.querySelector('.agent-intro').getBoundingClientRect().right <= window.innerWidth));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    // A starter fills the message box.
    await page.waitForTimeout(2600);
    await page.click('.agent-intro [data-intro-starter="0"]');
    assert.match(await page.inputValue('#userInput'), /tell me what you'd fix first/);
    // Replay plays it again in place, without adding a message.
    const count = await page.evaluate(() => chatSessions.find(s => s.id === activeChatId).messages.length);
    await page.click('.agent-intro [data-intro-action="replay"]');
    assert.ok(await page.evaluate(() => document.querySelector('.intro-message').classList.contains('intro-fresh')));
    assert.equal(await page.evaluate(() => chatSessions.find(s => s.id === activeChatId).messages.length), count);
    // The intro isn't sent to the model as part of the conversation.
    assert.deepEqual(await page.evaluate(() => chatHistoryForModel(chatSessions.find(s => s.id === activeChatId))), []);
    // Once only: after a reload Architect doesn't introduce itself again...
    await page.evaluate(() => saveChatsNow());
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => document.querySelectorAll('.agent-intro').length), 1);
    // ...but Swarm does, the first time its chat opens.
    await page.evaluate(() => openAgentChat('agent_3'));
    await page.waitForSelector('.agent-intro');
    assert.match(await page.textContent('.agent-intro .intro-headline'), /I'm Swarm/);
    await page.evaluate(() => openAgentChat('agent_1'));
    await page.evaluate(() => openAgentChat('agent_3'));
    assert.equal(await page.evaluate(() => document.querySelectorAll('.agent-intro').length), 1);
    // 🎬 Replay intro in the agent's settings shows it again.
    await page.evaluate(() => replayAgentIntro('agent_3'));
    assert.equal(await page.evaluate(() => document.querySelectorAll('.agent-intro').length), 2);
    assert.deepEqual(errors, []);
    await page.close();
});

test('Kore is the default read-aloud voice when a Gemini key is saved, and the page falls back without one', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-kore-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const page = await launched.browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => { localStorage.setItem('codev_chime', '0'); localStorage.setItem('codev_gemini_key', 'AIza_test_key'); localStorage.setItem('codev_tts_natural', 'gemini'); });
    const calls = [];
    const mode = { allFail: false };
    await page.route('https://generativelanguage.googleapis.com/**', async route => {
        const req = route.request();
        calls.push({ url: req.url(), body: JSON.parse(req.postData()), key: req.headers()['x-goog-api-key'] });
        if (mode.allFail) return route.fulfill({ status: 404, body: '{"error":{"message":"models/x is not found"}}' });
        // The newest model is retired for this key (404); the next one answers with a WAV file.
        if (calls.length === 1) return route.fulfill({ status: 404, body: '{}' });
        if (/interactions$/.test(req.url())) {
            const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(996)]).toString('base64');
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'i1', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: wav }] }] }) });
        }
        const pcm = Buffer.alloc(4800).toString('base64');
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }] } }] }) });
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => {
        window.__played = [];
        window.playAudioBlob = async blob => { window.__played.push({ type: blob.type, size: blob.size }); };
    });
    await page.evaluate(() => speakText("Hi, I'm Architect."));
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/v1beta\/interactions$/);
    assert.equal(calls[0].body.model, 'gemini-3.8-flash-tts');
    assert.equal(calls[1].body.model, 'gemini-3.8-flash-lite-tts');
    assert.equal(calls[1].key, 'AIza_test_key');
    assert.deepEqual(calls[1].body.generation_config.speech_config, [{ voice: 'Kore' }]);
    assert.deepEqual(calls[1].body.response_format, { type: 'audio' });
    assert.deepEqual(calls[1].body.input[0].content[0], { type: 'text', text: "Hi, I'm Architect." });
    assert.deepEqual(await page.evaluate(() => window.__played), [{ type: 'audio/wav', size: 1000 }]);
    // The older generateContent models still work, with their raw PCM wrapped as WAV.
    await page.evaluate(() => { geminiTtsModelIndex = 3; window.__played = []; return speakText('Older model.'); });
    assert.match(calls[2].url, /gemini-2\.5-flash-preview-tts:generateContent/);
    assert.equal(calls[2].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.deepEqual(await page.evaluate(() => window.__played), [{ type: 'audio/wav', size: 4844 }]);
    // When no model answers, the page says Kore didn't play instead of passing another voice off as Kore.
    mode.allFail = true;
    await page.evaluate(() => { geminiTtsModelIndex = 0; return Promise.race([speakText('Fallback.'), new Promise(r => setTimeout(r, 2500))]).then(() => stopSpeaking()); });
    assert.match(await page.textContent('#codevToast'), /Kore couldn't play \(none of Gemini's speech models answered/);
    mode.allFail = false;
    const callsBefore = calls.length;
    // The tap started (and so unlocked) the reusable audio element iPhones need.
    assert.ok(await page.evaluate(() => speechAudio instanceof HTMLAudioElement));
    // Settings > Voice lists Kore first, picked by default.
    await page.evaluate(() => { openSettingsModal(); document.getElementById('voiceSettings').open = true; fillVoicePicker(); });
    assert.equal(await page.evaluate(() => document.getElementById('modalVoice').value), 'gemini');
    assert.match(await page.evaluate(() => document.querySelector('#modalVoice option[value="gemini"]').textContent), /^Kore by Gemini$/);
    // Turned off in Settings > Voice: Gemini isn't called.
    await page.evaluate(() => { koreVoiceOn = false; });
    await page.evaluate(() => Promise.race([speakText('Hello again.'), new Promise(r => setTimeout(r, 1500))]).then(() => stopSpeaking()));
    assert.equal(calls.length, callsBefore);
    assert.deepEqual(errors, []);
    await page.close();
});

test('with Kore by Gemini picked and no Gemini key, the phone asks for one and picks its best own voice, never a joke voice', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-kore-nokey-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const page = await launched.browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => { localStorage.setItem('codev_chime', '0'); localStorage.setItem('codev_tts_natural', 'gemini'); });
    let geminiCalls = 0;
    await page.route('https://generativelanguage.googleapis.com/**', route => { geminiCalls++; return route.abort(); });
    await page.goto(url, { waitUntil: 'load' });
    // iPhone's voice list: the joke voices come first, the good ones later.
    const rank = await page.evaluate(() => [
        { name: 'Bells', lang: 'en-US' }, { name: 'Zarvox', lang: 'en-US' }, { name: 'Fred', lang: 'en-US' },
        { name: 'Samantha', lang: 'en-US' }, { name: 'Ava (Premium)', lang: 'en-US' }
    ].map(v => rankWebVoice(v)));
    assert.ok(rank[0] < rank[3] && rank[1] < rank[3] && rank[2] < rank[3], 'Samantha beats the joke voices');
    assert.ok(rank[3] < rank[4], 'a Premium voice beats Samantha');
    // Tapping 🔊 asks for a Gemini key right there instead of reading in another voice.
    await page.evaluate(() => speakText('Hello.'));
    await page.waitForSelector('#koreKeyModal');
    assert.match(await page.textContent('#koreKeyModal'), /needs a Gemini API key on this device/);
    assert.ok(await page.evaluate(() => document.querySelector('#koreKeyModal .modal').getBoundingClientRect().right <= window.innerWidth));
    await page.fill('#koreKeyInput', 'not-a-key');
    await page.click('#koreKeySave');
    assert.match(await page.textContent('#koreKeyStatus'), /start with AIza/);
    // "Use this device's voice" reads without Kore and doesn't ask again this visit.
    await page.click('#koreKeySkip');
    assert.equal(await page.$('#koreKeyModal'), null);
    await page.evaluate(() => Promise.race([speakText('Again.'), new Promise(r => setTimeout(r, 1000))]).then(() => stopSpeaking()));
    assert.equal(await page.$('#koreKeyModal'), null);
    assert.equal(geminiCalls, 0);
    // A key saved in the prompt is kept and Kore is tried at once.
    await page.evaluate(() => { koreKeyDeclined = false; speakText('With a key.'); });
    await page.fill('#koreKeyInput', ' AIzaSyTestKeyForKore_1234567890 ');
    await page.click('#koreKeySave');
    await page.waitForFunction(() => localStorage.getItem('codev_gemini_key') === 'AIzaSyTestKeyForKore_1234567890');
    await page.waitForTimeout(500);
    assert.ok(geminiCalls > 0);
    await page.evaluate(() => { stopSpeaking(); localStorage.removeItem('codev_gemini_key'); geminiKey = ''; });
    await page.evaluate(() => { openSettingsModal(); fillVoicePicker(); });
    assert.match(await page.evaluate(() => document.querySelector('#modalVoice option[value="gemini"]').textContent), /needs a Gemini key/);
    assert.match(await page.textContent('#voiceHint'), /Kore needs a Gemini key/);
    assert.deepEqual(errors, []);
    await page.close();
});

test('the default voice is natural Kore made on the device: no key, no Gemini call, and the download is shown', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-natural-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const page = await launched.browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    // A stand-in for the Kokoro worker: reports the model download, then answers each piece with a WAV.
    await page.addInitScript(() => {
        localStorage.setItem('codev_chime', '0');
        localStorage.setItem('codev_groq_key', 'gsk_test_key_for_agent_tests');
        localStorage.setItem('codev_backend', 'groq');
        window.__workerJobs = [];
        window.__workerUrls = [];
        window.Worker = class {
            constructor(url, opts) { window.__workerUrls.push({ url: String(url), type: opts && opts.type }); }
            postMessage(msg) {
                if (msg.type !== 'speak') return;
                window.__workerJobs.push({ text: msg.text, voice: msg.voice });
                setTimeout(() => this.onmessage({ data: { type: 'progress', loaded: 45 * 1048576, total: 90 * 1048576, file: 'model_quantized.onnx' } }), 5);
                setTimeout(() => this.onmessage({ data: { type: 'audio', id: msg.id, wav: new Uint8Array(1044).buffer } }), window.__workerDelay || 20);
            }
            terminate() { window.__workerTerminated = (window.__workerTerminated || 0) + 1; }
        };
    });
    let geminiCalls = 0;
    await page.route('https://generativelanguage.googleapis.com/**', route => { geminiCalls++; return route.abort(); });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => { window.__played = []; window.playAudioBlob = async blob => { window.__played.push({ type: blob.type, size: blob.size }); }; });
    const long = 'This is the first sentence of the answer, read in the natural Kore voice. ' + 'It keeps going with more words so it needs more than one piece. '.repeat(8);
    await page.evaluate(text => speakText(text), long);
    const jobs = await page.evaluate(() => window.__workerJobs);
    assert.ok(jobs.length >= 2, 'long text is read in pieces');
    assert.ok(jobs.every(j => j.voice === 'af_kore'));
    assert.ok(jobs[0].text.length <= 140, 'the first piece is short so the voice starts quickly');
    assert.equal(jobs[0].text, 'This is the first sentence of the answer, read in the natural Kore voice.');
    assert.deepEqual(await page.evaluate(() => window.__workerUrls), [{ url: new URL('agent-ui/kokoro-worker.js', url).href, type: 'module' }]);
    assert.equal((await page.evaluate(() => window.__played)).length, jobs.length);
    assert.ok((await page.evaluate(() => window.__played)).every(p => p.type === 'audio/wav'));
    // The download note goes away once Kore starts talking.
    assert.match(await page.textContent('#codevToast'), /Getting the natural voice ready \(only the first time\): 45 of 90 MB/);
    assert.equal(await page.evaluate(() => document.getElementById('codevToast').classList.contains('show')), false);
    // Later loads (from this device, after a restart) say "Loading", not "downloading".
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_natural_voice_saved')), '1');
    // Stopping mid-way throws the busy worker away instead of finishing words nobody hears.
    await page.evaluate(text => { window.__workerDelay = 1000; speakText(text); }, long);
    await page.waitForTimeout(100);
    await page.evaluate(() => stopSpeaking());
    assert.equal(await page.evaluate(() => window.__workerTerminated), 1, 'stop replaces the busy worker');
    assert.equal(geminiCalls, 0);
    assert.equal(await page.$('#koreKeyModal'), null);
    // Settings: the natural voices come first, Kore picked.
    await page.evaluate(() => { openSettingsModal(); fillVoicePicker(); });
    assert.equal(await page.evaluate(() => document.getElementById('modalVoice').value), 'natural:af_kore');
    assert.match(await page.evaluate(() => document.getElementById('modalVoice').options[0].textContent), /^⭐ Kore · /);
    assert.match(await page.textContent('#voiceHint'), /made on this device: no key/);
    // Picking another natural voice and saving keeps it.
    await page.evaluate(async () => { document.getElementById('modalVoice').value = 'natural:am_michael'; await saveSettings(); });
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_tts_natural')), 'am_michael');
    assert.deepEqual(errors, []);
    await page.close();
});

test('the Kokoro worker module and the vendored bundle are in place', () => {
    const worker = fs.readFileSync(path.join(__dirname, '../mobile/www/agent-ui/kokoro-worker.js'), 'utf8');
    assert.match(worker, /import\("\.\.\/vendor\/kokoro\/kokoro\.web\.js"\)/);
    assert.match(worker, /dtype: "q8"/);
    const bundle = fs.readFileSync(path.join(__dirname, '../mobile/www/vendor/kokoro/kokoro.web.js'), 'utf8');
    assert.match(bundle, /af_kore:\{name:"Kore"/);
    const Natural = require('../mobile/www/agent-ui/natural-voice.js');
    assert.equal(Natural.VOICES[0].id, 'af_kore');
    assert.ok(Natural.VOICES.every(v => bundle.includes(`${v.id}:{name`)), 'every offered voice exists in Kokoro');
});

test('the natural voice engine cancels, restarts a worker that goes quiet, and checks the download', async () => {
    const Natural = require('../mobile/www/agent-ui/natural-voice.js');
    const workers = [];
    const makeWorker = () => {
        const w = { sent: [], terminated: false, postMessage(m) { this.sent.push(m); }, terminate() { this.terminated = true; } };
        workers.push(w);
        return w;
    };
    const engine = Natural.create({ makeWorker, stallMs: 50 });
    const keepAlive = setInterval(() => {}, 10); // the engine's own watchdog doesn't hold Node open
    // A worker that never answers is restarted and the piece fails instead of hanging.
    await assert.rejects(engine.speak('Hello.', 'af_kore'), /stopped responding/);
    assert.ok(workers[0].terminated);
    // An answer resolves its piece as a WAV and marks the model as loaded.
    const c = engine.speak('Three.', 'af_heart');
    workers[1].onmessage({ data: { type: 'audio', id: 2, wav: new ArrayBuffer(8) } });
    assert.equal((await c).type, 'audio/wav');
    assert.equal(engine.loaded(), true);
    // Nothing waiting: cancel leaves the worker alone.
    engine.cancel();
    assert.equal(workers.length, 2);
    // Cancel while busy rejects what's waiting, replaces the worker and warms the new one.
    const a = engine.speak('One.', 'af_heart');
    const b = engine.speak('Two.', 'nope');
    assert.equal(workers[1].sent.at(-1).voice, 'af_kore', 'an unknown voice becomes Kore');
    engine.cancel();
    await assert.rejects(a, err => err.stopped === true);
    await assert.rejects(b, /stopped/);
    assert.ok(workers[1].terminated);
    assert.deepEqual(workers[2].sent, [{ type: 'warm', voice: 'af_kore' }]);
    // A loaded worker is never cut off by the watchdog: a slow phone just takes its time.
    const slow = engine.speak('Slow piece.', 'af_kore');
    workers[2].onmessage({ data: { type: 'ready' } });
    let settled = false;
    slow.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(settled, false, 'still waiting, not failed');
    assert.equal(workers[2].terminated, false);
    workers[2].onmessage({ data: { type: 'audio', id: 5, wav: new ArrayBuffer(8) } });
    assert.equal((await slow).type, 'audio/wav');
    // downloaded() looks for the model in the browser's cache.
    const fakeCaches = has => ({ open: async () => ({ match: async url => has && url === Natural.MODEL_URL ? {} : undefined }) });
    assert.equal(await Natural.downloaded(fakeCaches(true)), true);
    assert.equal(await Natural.downloaded(fakeCaches(false)), false);
    assert.equal(await Natural.downloaded(null), false);
    clearInterval(keepAlive);
});

test('once Kore has spoken, a later piece that fails is tried again, and never handed to the robotic voice', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const backend = createMockBackend({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'codev-partial-')) });
    const url = await backend.listen();
    t.after(() => backend.close());
    const page = await launched.browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.addInitScript(() => {
        localStorage.setItem('codev_chime', '0');
        window.__jobs = [];
        window.__failTimes = {};
        window.__robot = 0;
        // Fails a piece containing "Glitch" as many times as __failTimes says.
        window.Worker = class {
            postMessage(msg) {
                if (msg.type !== 'speak') return;
                window.__jobs.push(msg.text);
                const left = Object.keys(window.__failTimes).find(k => msg.text.includes(k) && window.__failTimes[k] > 0);
                if (left) { window.__failTimes[left]--; return setTimeout(() => this.onmessage({ data: { type: 'error', id: msg.id, message: 'out of memory' } }), 5); }
                setTimeout(() => this.onmessage({ data: { type: 'audio', id: msg.id, wav: new Uint8Array(1044).buffer } }), 5);
            }
            terminate() {}
        };
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => {
        window.__played = [];
        window.playAudioBlob = async blob => { window.__played.push(blob.size); };
        speechSynthesis.speak = () => { window.__robot++; };
    });
    const text = 'First sentence is fine. Glitch happens in this one. And the last sentence.';
    // One failure: tried again, and the whole answer reads in Kore.
    await page.evaluate(text => { window.__failTimes = { Glitch: 1 }; return speakText(text); }, text);
    assert.equal(await page.evaluate(() => window.__played.length), 2, 'both pieces play: the first sentence, then the rest');
    assert.equal(await page.evaluate(() => window.__robot), 0);
    // Two failures: the reading stops with a note; the robotic voice never takes over.
    await page.evaluate(text => { window.__played = []; window.__failTimes = { Glitch: 2 }; return speakText(text); }, text);
    assert.equal(await page.evaluate(() => window.__played.length), 1);
    assert.equal(await page.evaluate(() => window.__robot), 0);
    assert.match(await page.textContent('#codevToast'), /Kore stopped partway \(out of memory\)/);
    assert.deepEqual(errors, []);
    await page.close();
});

test('in the Windows app Kore is made natively, and the worker takes over only if that engine cannot run', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const backend = createMockBackend({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'codev-native-')) });
    const url = await backend.listen();
    t.after(() => backend.close());
    for (const broken of [false, true]) {
        const page = await launched.browser.newPage();
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        await page.addInitScript(broken => {
            localStorage.setItem('codev_chime', '0');
            window.__native = [];
            window.__workers = 0;
            window.Worker = class {
                constructor() { window.__workers++; }
                postMessage(msg) { if (msg.type === 'speak') setTimeout(() => this.onmessage({ data: { type: 'audio', id: msg.id, wav: new Uint8Array(1044).buffer } }), 5); }
                terminate() {}
            };
            window.codevDesktop = {
                naturalVoice: async req => {
                    window.__native.push(req.op + (req.voice ? ':' + req.voice : ''));
                    if (req.op === 'downloaded') return { ok: true, downloaded: false };
                    if (req.op !== 'speak') return { ok: true };
                    if (broken) return { ok: false, unavailable: true, message: "Cannot find module 'onnxruntime-node'" };
                    window.__progress && window.__progress({ loaded: 155 * 1048576, total: 310 * 1048576, file: 'onnx/model.onnx' });
                    return { ok: true, wav: new Uint8Array(2044) };
                },
                onNaturalVoiceProgress: cb => { window.__progress = cb; return () => {}; }
            };
        }, broken);
        await page.goto(url, { waitUntil: 'load' });
        await page.evaluate(() => { window.__played = []; window.playAudioBlob = async blob => { window.__played.push(blob.size); }; });
        await page.evaluate(() => speakText('Hello from the desktop. This is the second sentence.'));
        const native = await page.evaluate(() => window.__native.filter(op => op.startsWith('speak')));
        assert.equal(native.length, 2, 'both pieces go to the native engine first');
        assert.ok(native.every(op => op === 'speak:af_kore'));
        assert.equal(await page.evaluate(() => window.__workers), broken ? 1 : 0);
        assert.deepEqual(await page.evaluate(() => window.__played), broken ? [1044, 1044] : [2044, 2044]);
        if (!broken) assert.match(await page.textContent('#codevToast'), /155 of 310 MB/);
        assert.deepEqual(errors, []);
        await page.close();
    }
});
