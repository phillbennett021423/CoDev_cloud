// The expert coach (mobile/www/agent-ui/expert-coach.js): every agent works like a seasoned
// pro in the user's field, at the user's level, and either teaches the user to do the work
// or does it for them. These tests check the playbooks, the profile, the per-message
// "teach me" / "just do it" switch, the prompt block and the tools, then that the real
// page hands the model the block, the field's tools and the two coach tools.
// Run: node --test tests/expert-coach.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Expert = require('../mobile/www/agent-ui/expert-coach.js');
const Guide = require('../mobile/www/agent-ui/tool-guide.js');
const { memoryStorage } = require('./helpers/tool-catalog');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat } = require('./helpers/page-driver');

test('every playbook is complete, and its tools are tools CoDev has', () => {
    const routed = new Set(Guide.ROUTES.flatMap(r => r.tools));
    const ids = new Set();
    assert.ok(Expert.PROFESSIONS.length >= 30, `only ${Expert.PROFESSIONS.length} playbooks`);
    for (const p of Expert.PROFESSIONS) {
        assert.ok(!ids.has(p.id), `${p.id} twice`);
        ids.add(p.id);
        for (const key of ['work', 'standards', 'pitfalls', 'terms', 'aliases']) assert.ok(p[key] && p[key].length >= 2, `${p.name} needs ${key}`);
        for (const level of ['new', 'some', 'pro']) assert.ok(p.learn[level] && p.learn[level].length, `${p.name} needs a ${level} learning path`);
        for (const [tool, why] of p.tools) {
            assert.ok(routed.has(tool), `${p.name} names ${tool}, which isn't a CoDev tool`);
            assert.ok(why && why.length > 3, `${p.name}: say what ${tool} is for`);
        }
    }
});

test('every playbook tool that is not on every version says what turns it on', () => {
    const everywhere = new Set(['run_code', 'web_search', 'notes_write', 'delegate_tasks', 'wide_research']);
    for (const p of Expert.PROFESSIONS) {
        for (const [tool] of p.tools) {
            assert.ok(everywhere.has(tool) || Expert.NEEDS[tool], `${p.name}: ${tool} needs a NEEDS entry saying what turns it on`);
        }
    }
    for (const [tool, need] of Object.entries(Expert.NEEDS)) {
        assert.ok(need.what && need.needs, `${tool} needs what and needs`);
        assert.doesNotMatch(need.what + need.needs, /\b[a-z]+_[a-z_]+\b/, `${tool}: describe it in words, not tool names`);
    }
});

test('a missing tool is named by what it does and how to turn it on, never by its name', async () => {
    const ex = Expert.createExpertise({ storage: memoryStorage() });
    ex.save({ profession: 'video editor' });
    const note = ex.toolNote([{ name: 'create_document' }], 'cut my wedding film');
    assert.match(note, /Video editor and filmmaker: create_document for shot lists/);
    assert.match(note, /Not set up here yet for Video editor and filmmaker work: video and audio editing \(needs CoDev on the user's computer via the Windows app or start-codev.bat with Docker/);
    assert.doesNotMatch(note, /media_edit|media_transcribe/);
    const playbook = ex.buildTools().find(t => t.name === 'expert_playbook');
    const here = await playbook.run({ profession: 'video editor' }, { toolNames: ['create_document'] });
    assert.match(here, /CoDev tools you have for this: create_document/);
    assert.match(here, /Not set up here yet[^\n]*video and audio editing/);
    assert.match(await playbook.run({ profession: 'video editor' }), /media_edit \(cutting[^)]*\) \[needs CoDev on/);
});

test('a profession name finds its playbook, the longest alias first', () => {
    assert.equal(Expert.findProfession('realtor').id, 'realestate');
    assert.equal(Expert.findProfession('I am a real estate investor').id, 'realestate');
    assert.equal(Expert.findProfession('Electricians').id, 'trades');
    assert.equal(Expert.findProfession('HVAC technician').id, 'trades');
    assert.equal(Expert.findProfession('ER nurse').id, 'health');
    assert.equal(Expert.findProfession('YouTuber').id, 'creator');
    assert.equal(Expert.findProfession('insurance broker').id, 'insurance');
    assert.equal(Expert.findProfession('beekeeper'), null);
    assert.equal(Expert.findProfession(''), null);
});

test('a request names a field only with a clear word, so code about props stays code', () => {
    assert.deepEqual(Expert.detectProfessions('Write a listing description like a realtor would').map(p => p.id), ['realestate']);
    assert.deepEqual(Expert.detectProfessions('Fix the props passed to this React component'), []);
    assert.deepEqual(Expert.detectProfessions('help with my homework'), []);
    assert.ok(Expert.detectProfessions('electrician and plumber and nurse').length <= 2);
});

test('"teach me" and "just do it" switch the help mode for one message', () => {
    assert.equal(Expert.modeFromMessage('Teach me how to price a listing'), 'teach');
    assert.equal(Expert.modeFromMessage('Walk me through a CMA'), 'teach');
    assert.equal(Expert.modeFromMessage('How do I wire a 3-way switch?'), 'teach');
    assert.equal(Expert.modeFromMessage('Just do it, write the whole thing'), 'do');
    assert.equal(Expert.modeFromMessage('Do it for me please'), 'do');
    assert.equal(Expert.modeFromMessage('show me how... actually just do it'), 'do');
    assert.equal(Expert.modeFromMessage('Make a budget for my bakery'), null);
});

test('the profile saves, cleans and falls back to safe values', () => {
    const storage = memoryStorage();
    const changes = [];
    const ex = Expert.createExpertise({ storage, onChange: p => changes.push(p) });
    assert.deepEqual(ex.profile(), { profession: '', level: '', mode: 'auto' });
    ex.save({ profession: '  Real estate\nagent ', level: 'new', mode: 'teach' });
    assert.deepEqual(ex.profile(), { profession: 'Real estate agent', level: 'new', mode: 'teach' });
    ex.save({ level: 'wizard', mode: 'nope' });
    assert.deepEqual(ex.profile(), { profession: 'Real estate agent', level: '', mode: 'auto' });
    assert.equal(changes.length, 2);
    ex.save({ mode: 'auto' });
    assert.equal(changes.length, 2, 'no change, no callback');
});

test('the prompt block brings the field, the level and the help mode', () => {
    const ex = Expert.createExpertise({ storage: memoryStorage() });
    ex.save({ profession: 'realtor', level: 'new', mode: 'do' });
    const block = ex.promptBlock('Price my listing at 12 Oak St');
    assert.match(block, /^\[Expertise\]/);
    assert.match(block, /Real estate agent playbook: core work:.*CMA/);
    assert.match(block, /Caution: Contracts and disclosures/);
    assert.match(block, /\[User level\] The user is new to this field/);
    assert.match(block, /\[Help mode: Do it for me\]/);
    // The message wins over the saved default.
    assert.match(ex.promptBlock('Teach me how to price it'), /\[Help mode: Teach me, asked for in this message\] The user wants to learn/);
    // The block never names a tool the agent might not have, apart from the coach's own.
    const named = (block.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || []).filter(w => w !== 'set_expertise');
    assert.deepEqual(named, []);
});

test('a field without a playbook still gets the expert method', () => {
    const ex = Expert.createExpertise({ storage: memoryStorage() });
    ex.save({ profession: 'beekeeper', level: 'pro' });
    const block = ex.promptBlock('Plan my spring hive inspections');
    assert.match(block, /No built-in playbook for "beekeeper"[\s\S]*web_search/);
    assert.match(block, /\[User level\] The user is an experienced professional/);
    assert.match(block, /\[Help mode: Agent decides\]/);
    // Nothing set: the agent works out the field and may save it.
    assert.match(Expert.createExpertise({ storage: memoryStorage() }).promptBlock('hi'), /Work out which field[\s\S]*set_expertise/);
});

test('the field-tools note names only the tools the agent has', () => {
    const ex = Expert.createExpertise({ storage: memoryStorage() });
    ex.save({ profession: 'bookkeeper' });
    const note = ex.toolNote([{ name: 'create_spreadsheet' }, { name: 'run_code' }, { name: 'expert_playbook' }], 'reconcile March');
    assert.match(note, /^\[Field tools\][\s\S]*Bookkeeper and accountant: create_spreadsheet for ledgers[\s\S]*run_code for exact totals/);
    assert.doesNotMatch(note, /query_table|web_search|set_expertise/);
    assert.match(note, /expert_playbook/);
    assert.equal(Expert.createExpertise({ storage: memoryStorage() }).toolNote([], 'hi'), '');
});

test('expert_playbook and set_expertise do what they say and are documented', async () => {
    const storage = memoryStorage();
    const ex = Expert.createExpertise({ storage });
    const tools = Object.fromEntries(ex.buildTools().map(t => [t.name, t]));
    for (const t of Object.values(tools)) assert.deepEqual(Guide.checkToolDocs(t), [], t.name);
    assert.match(await tools.expert_playbook.run({}), /Built-in playbooks \(\d+\): Software developer/);
    const electrician = await tools.expert_playbook.run({ profession: 'electrician', level: 'new' });
    assert.match(electrician, /# Skilled trades and contractor playbook[\s\S]*New to it \(learning\): Safety training/);
    assert.doesNotMatch(electrician, /Experienced pro:/);
    assert.match(electrician, /Safety: Electrical, gas/);
    assert.match(await tools.expert_playbook.run({ profession: 'falconer' }), /No built-in playbook for "falconer"/);
    assert.match(await tools.set_expertise.run({}), /^Error/);
    assert.match(await tools.set_expertise.run({ profession: 'wedding photographer', level: 'some' }), /Saved\. Profession: wedding photographer \(playbook: Photographer\)\. Level: Some experience\. Help mode: Agent decides/);
    assert.match(await tools.set_expertise.run({ mode: 'teach' }), /Help mode: Teach me/);
    assert.equal(ex.profile().profession, 'wedding photographer');
});

test('the page gives the model the expertise block, the field tools and the coach tools', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-expert-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: ['Step 1: pull three sold comps.'] });
    await page.uncheck('#isSandboxCheckbox');
    // Settings > 🎓 Your field & level saves as soon as a field changes.
    await page.evaluate(() => { document.getElementById('settingsModal').style.display = 'flex'; document.getElementById('expertSettings').open = true; });
    await page.fill('#expertProfession', 'realtor');
    await page.press('#expertProfession', 'Tab');
    await page.selectOption('#expertLevel', 'new');
    assert.match(await page.textContent('#expertStatus'), /Real estate agent playbook/);
    await page.evaluate(() => { document.getElementById('settingsModal').style.display = 'none'; });
    // The button by Send moves to the next mode (Agent decides, then Teach me) and sets the default.
    assert.equal(await page.textContent('#helpModeBtn'), '🤖');
    await page.click('#helpModeBtn');
    assert.equal(await page.textContent('#helpModeBtn'), '🎓');
    assert.equal(await page.evaluate(() => localStorage.getItem('codev_expert_mode')), 'teach');
    assert.equal(await page.inputValue('#expertMode'), 'teach');
    await sendPrompt(page, 'Help me price my first listing.');
    await waitForChat(page, /pull three sold comps/);
    const [call] = await page.evaluate(() => window.__modelCalls);
    assert.match(call.system, /\[Expertise\][\s\S]*The user's profession: realtor[\s\S]*Real estate agent playbook/);
    assert.match(call.system, /\[User level\] The user is new to this field/);
    assert.match(call.system, /\[Help mode: Teach me\]/);
    assert.match(call.system, /\[Field tools\][\s\S]*Real estate agent: [^\n]*web_search for market data/);
    // On Groq's free tier the file tools wait for a request that asks for a file: the agent is told so, in words.
    assert.match(call.system, /Not set up here yet for Real estate agent work: making Excel, PowerPoint and Word files \(needs Claude or OpenRouter/);
    assert.ok(call.tools.includes('expert_playbook') && call.tools.includes('set_expertise'));
    assert.deepEqual(errors, []);
    await page.close();
});
