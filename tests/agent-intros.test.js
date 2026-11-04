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
    await page.addInitScript(() => { localStorage.setItem('codev_chime', '0'); localStorage.setItem('codev_gemini_key', 'AIza_test_key'); });
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
    assert.equal(await page.evaluate(() => document.getElementById('modalVoice').value), '__kore__');
    assert.match(await page.evaluate(() => document.getElementById('modalVoice').options[0].textContent), /^⭐ Kore \(Gemini's voice\)$/);
    // Turned off in Settings > Voice: Gemini isn't called.
    await page.evaluate(() => { koreVoiceOn = false; });
    await page.evaluate(() => Promise.race([speakText('Hello again.'), new Promise(r => setTimeout(r, 1500))]).then(() => stopSpeaking()));
    assert.equal(calls.length, callsBefore);
    assert.deepEqual(errors, []);
    await page.close();
});

test('without a Gemini key, the phone says Kore needs one and picks its best own voice, never a joke voice', async t => {
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
    await page.addInitScript(() => localStorage.setItem('codev_chime', '0'));
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
    await page.evaluate(() => Promise.race([speakText('Hello.'), new Promise(r => setTimeout(r, 1500))]).then(() => stopSpeaking()));
    assert.equal(geminiCalls, 0);
    assert.match(await page.textContent('#codevToast'), /Kore needs a Gemini key on this device/);
    await page.evaluate(() => { openSettingsModal(); fillVoicePicker(); });
    assert.match(await page.evaluate(() => document.getElementById('modalVoice').options[0].textContent), /needs a Gemini key/);
    assert.match(await page.textContent('#voiceHint'), /Kore needs a Gemini key/);
    assert.deepEqual(errors, []);
    await page.close();
});
