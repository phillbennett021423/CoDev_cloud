// Story Studio (mobile/www/agent-ui/story-studio.js): game projects and their story
// bibles, the agents' studio_* tools, the Godot exports, and one run in the real page
// where a user makes a character, talks to them, builds a scene and an agent saves
// to the bible. The model is a stand-in, so no key is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Studio = require('../mobile/www/agent-ui/story-studio.js');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat } = require('./helpers/page-driver');

function memoryStorage() {
    const data = {};
    return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
}

function sampleStore() {
    const storage = memoryStorage();
    const store = Studio.createStudioStore(storage);
    store.createProject({ name: 'Skyfall', pitch: 'A rooftop parkour brawler in a drowned city.' });
    store.saveEntry('', { kind: 'character', name: 'Mara Vex', summary: 'A courier who can slow time.', fields: { speaking_style: 'Clipped, sarcastic.', powers: 'Slows time for 3 seconds.' } });
    store.saveEntry('', { kind: 'character', name: 'Old Tomas', summary: 'Mara\'s mentor.' });
    store.saveEntry('', { kind: 'location', name: 'The Spire', summary: 'The last dry tower.' });
    return { store, storage };
}

test('projects keep separate bibles, survive a reload and update only the fields given', () => {
    const { store, storage } = sampleStore();
    assert.equal(store.createProject({ name: 'skyfall' }).error, 'There\'s already a project named "skyfall".');
    const other = store.createProject({ name: 'Moon Farm', engine: 'Unity' }).project;
    store.saveEntry(other.id, { kind: 'npc', name: 'Pip' });
    assert.equal(store.project('Moon Farm').entries[0].kind, 'character', 'npc is a character');
    assert.equal(store.project('Skyfall').entries.length, 3);

    const again = Studio.createStudioStore(storage);
    assert.equal(again.projects().length, 2);
    const updated = again.saveEntry('Skyfall', { name: 'mara vex', fields: { goals: 'Find her brother.' } });
    assert.equal(updated.created, false);
    assert.equal(updated.entry.fields.powers, 'Slows time for 3 seconds.');
    assert.equal(updated.entry.fields.goals, 'Find her brother.');
    assert.equal(again.saveEntry('Skyfall', { name: 'Nobody' }).error.startsWith('Pick a kind'), true);
});

test('the prompt block and tools are only for story tasks, and the index puts named entries first', () => {
    const { store } = sampleStore();
    assert.equal(Studio.isStudioTask(store, 'fix the null error in player.gd'), false);
    assert.equal(Studio.isStudioTask(store, 'add a godot scene for the menu'), false);
    assert.equal(Studio.isStudioTask(store, 'write a backstory for my villain'), true);
    assert.equal(Studio.isStudioTask(store, 'what would Old Tomas say here?'), true);
    assert.equal(Studio.studioPromptBlock(store, 'fix the build'), '');
    const block = Studio.studioPromptBlock(store, 'make The Spire scarier');
    assert.match(block, /^\[Story Studio\] The user's game project "Skyfall"/);
    assert.match(block.split('\n')[1], /The Spire/);
});

test('agents read, save, create projects and export through the studio tools', async () => {
    const { store } = sampleStore();
    const written = {};
    const tools = Object.fromEntries(Studio.buildStudioTools(store, { writeFile: async (p, c) => { written[p] = c; return `Saved ${p}`; }, confirm: async () => true }).map(t => [t.name, t]));
    assert.deepEqual(Object.keys(tools), ['studio_read', 'studio_save', 'studio_remove', 'studio_export']);
    assert.match(await tools.studio_read.run({}), /Character: Mara Vex/);
    assert.match(await tools.studio_read.run({ name: 'Mara Vex' }), /How they talk: Clipped, sarcastic\./);
    assert.match(await tools.studio_read.run({ query: 'mentor' }), /Old Tomas/);

    assert.match(await tools.studio_save.run({ kind: 'ability', name: 'Time Skip', fields: { owner: 'Mara Vex', effect: 'Freezes enemies.' } }), /Added ability "Time Skip" in "Skyfall"/);
    assert.match(await tools.studio_save.run({ project: 'Neon Saints', kind: 'faction', name: 'The Choir' }), /in "Neon Saints"/);
    assert.ok(store.project('Neon Saints'), 'a new project is made for a new name');
    assert.equal(store.active().name, 'Skyfall', 'without switching the project the user has open');
    assert.match(await tools.studio_save.run({ project: 'Skyfall', kind: 'scene', name: 'Rooftop', fields: { location: 'The Spire', characters: 'Mara Vex, Old Tomas', goal: 'Tomas wants her to quit.' },
        lines: [{ type: 'direction', text: 'Rain.' }, { speaker: 'Old Tomas', text: 'Quit while you can.' }, { speaker: 'Mara Vex', text: 'Not a chance.', emotion: 'defiant' }] }), /Added scene/);

    assert.match(await tools.studio_export.run({ project: 'Skyfall' }), /Exported "Skyfall"/);
    assert.deepEqual(Object.keys(written).sort(), ['game_data/game_data.gd', 'game_data/scenes/rooftop.json', 'game_data/story_bible.json', 'game_data/story_bible.md']);
    const bible = JSON.parse(written['game_data/story_bible.json']);
    assert.equal(bible.entries_by_kind.characters[0].id, 'mara_vex');
    assert.equal(bible.entries_by_kind.abilities[0].effect, 'Freezes enemies.');
    const cutscene = JSON.parse(written['game_data/scenes/rooftop.json']);
    assert.equal(cutscene.start, 'n1');
    assert.deepEqual(cutscene.characters, [{ name: 'Mara Vex', id: 'mara_vex' }, { name: 'Old Tomas', id: 'old_tomas' }]);
    assert.deepEqual(cutscene.beats.map(b => [b.id, b.type, b.speaker_id || null, b.next]), [['n1', 'direction', null, 'n2'], ['n2', 'line', 'old_tomas', 'n3'], ['n3', 'line', 'mara_vex', '']]);

    const gd = written['game_data/game_data.gd'];
    assert.match(gd, /^extends RefCounted$/m);
    assert.match(gd, /^const CHARACTERS := \{/m);
    assert.match(gd, /^static func scene_beats\(scene_id: String\) -> Array:$/m);
    // The constants are JSON, which GDScript reads as dictionary literals.
    const chars = gd.match(/^const CHARACTERS := (\{[\s\S]*?^\})/m)[1];
    assert.equal(JSON.parse(chars).old_tomas.summary, 'Mara\'s mentor.');

    assert.match(await tools.studio_remove.run({ name: 'Old Tomas' }), /Deleted/);
    assert.equal(store.findEntry(store.project('Skyfall'), 'Old Tomas'), null);
});

test('scene turns: the prompt carries the cast, place, notes and the line to redo; replies parse loosely', () => {
    const { store } = sampleStore();
    const p = store.project('Skyfall');
    const scene = store.saveEntry('', { kind: 'scene', name: 'Bridge', fields: { location: 'The Spire roof', characters: 'Mara Vex, Old Tomas', goal: 'Escape.' }, lines: [] }).entry;
    const system = Studio.sceneDirectorPrompt(p, scene);
    assert.match(system, /Character: Mara Vex[\s\S]*Character: Old Tomas/);
    assert.match(system, /\[Place\]\nPlace: The Spire/);
    const msg = Studio.sceneTurnMessage({ lines: [{ speaker: 'Mara Vex', text: 'Move!' }] }, { speaker: 'Old Tomas', direction: 'He hesitates', avoid: 'No.' });
    assert.match(msg, /Mara Vex: Move!/);
    assert.match(msg, /\[Director's note\] He hesitates/);
    assert.match(msg, /Rewrite this line a different way: "No\."/);
    assert.match(msg, /spoken by Old Tomas/);

    const cast = [{ name: 'Mara Vex' }, { name: 'Old Tomas' }];
    assert.deepEqual(Studio.parseSceneLines('Sure! {"speaker": "mara vex", "text": "Go.", "emotion": "tense"}', cast), [{ speaker: 'Mara Vex', text: 'Go.', emotion: 'tense' }]);
    assert.equal(Studio.parseSceneLines('[{"speaker":"Old Tomas","text":"A"},{"speaker":"Mara Vex","text":"B"}]', cast).length, 2);
    assert.deepEqual(Studio.parseSceneLines('**Old Tomas:** Wait.\nSomething else', cast), [{ speaker: 'Old Tomas', text: 'Wait.' }]);
});

test('a locked character can\'t be changed or deleted, by the user\'s edits or an agent, until it\'s unlocked', async () => {
    const { store } = sampleStore();
    const p = store.project('Skyfall');
    const mara = store.findEntry(p, 'Mara Vex');
    assert.equal(store.saveEntry('', { id: mara.id, locked: true }).entry.locked, true);
    assert.equal(store.saveEntry('', { name: 'Mara Vex', summary: 'Changed' }).locked, true);
    const tools = Object.fromEntries(Studio.buildStudioTools(store, { confirm: async () => true }).map(t => [t.name, t]));
    assert.match(await tools.studio_save.run({ name: 'Mara Vex', fields: { powers: 'Flight' }, locked: false }), /locked "Mara Vex"[\s\S]*suggest it/);
    assert.match(await tools.studio_remove.run({ name: 'Mara Vex' }), /locked/);
    assert.match(await tools.studio_read.run({ name: 'Mara Vex' }), /\(locked: the user keeps it exactly as it is\)/);
    assert.equal(store.findEntry(p, 'Mara Vex').fields.powers, 'Slows time for 3 seconds.');
    assert.equal(store.saveEntry('', { id: mara.id, locked: false, summary: 'Now changed' }).entry.summary, 'Now changed');
});

test('a project exported as JSON imports back on another device', () => {
    const { store } = sampleStore();
    const json = Studio.toJson(store.project('Skyfall'));
    const fresh = Studio.createStudioStore(memoryStorage());
    const done = fresh.importProject(json);
    assert.equal(done.project.name, 'Skyfall');
    const mara = fresh.findEntry(done.project, 'Mara Vex');
    assert.equal(mara.fields.speaking_style, 'Clipped, sarcastic.');
    assert.equal(fresh.importProject('not json').error.includes('isn\'t JSON'), true);
});

// ---------- In the real page ----------

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

async function openStudioPage(t, steps, viewport) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-studio-'));
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const opened = await openPage(launched.browser, url, { steps });
    if (viewport) await opened.page.setViewportSize(viewport);
    await opened.page.uncheck('#isSandboxCheckbox').catch(() => {});
    return opened;
}

test('in the page: make a project and a character, talk to them, build a scene, export', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openStudioPage(t, []);
    await page.evaluate(() => {
        // The stand-in model: in character for chats, a JSON line for scene turns.
        window.groqChatMessage = async body => {
            window.__studioCalls = (window.__studioCalls || []).concat([body.messages]);
            const system = body.messages[0].content;
            if (/one turn at a time/.test(system)) return { role: 'assistant', content: '{"speaker": "Rook", "text": "You came back.", "emotion": "wary"}' };
            return { role: 'assistant', content: 'Hmph. Who sent you?' };
        };
        switchView('studio');
    });
    await page.fill('#view-studio input[placeholder="Your game\'s name"]', 'Ashen Crown');
    await page.click('#view-studio button:has-text("Create project")');
    await page.click('#view-studio button:has-text("New character")');
    await page.fill('#view-studio input[placeholder="Name"]', 'Rook');
    await page.fill('#view-studio textarea[placeholder="One or two sentences"]', 'A disgraced knight.');
    await page.click('#view-studio button:has-text("Save")');
    await page.click('#view-studio button:has-text("Talk to Rook")');
    await page.fill('#view-studio input[aria-label="Message"]', 'Hello there');
    await page.press('#view-studio input[aria-label="Message"]', 'Enter');
    await page.waitForSelector('#view-studio .gs-bubble.them:has-text("Who sent you?")');
    const chatSystem = await page.evaluate(() => window.__studioCalls[0][0].content);
    assert.match(chatSystem, /You are Rook, a character in the game "Ashen Crown"/);
    assert.match(chatSystem, /A disgraced knight\./);

    await page.click('#view-studio button:has-text("Scene Builder")');
    await page.click('#view-studio button:has-text("New scene")');
    await page.fill('#view-studio input[placeholder^="Scene title"]', 'The Return');
    await page.check('#view-studio input[type=checkbox][value="Rook"]');
    await page.fill('#view-studio input[placeholder^="Others"]', 'Gatekeeper');
    await page.click('#view-studio button:has-text("Start the scene")');
    await page.fill('#view-studio input[aria-label="Director\'s note"]', 'It is raining');
    await page.click('#view-studio button:has-text("Next line")');
    await page.waitForSelector('#view-studio .gs-bubble:has-text("You came back.")');
    await page.fill('#view-studio input[aria-label="Your line"]', 'State your business.');
    await page.selectOption('#view-studio select[aria-label="Step in as"]', 'Gatekeeper');
    await page.click('#view-studio button:has-text("Add")');
    const scene = await page.evaluate(() => storyStudio.findEntry(storyStudio.project('Ashen Crown'), 'The Return'));
    assert.deepEqual(scene.lines.map(l => [l.type || 'line', l.speaker || '', l.text]), [
        ['direction', '', 'It is raining'], ['line', 'Rook', 'You came back.'], ['line', 'Gatekeeper', 'State your business.']]);

    // Redo replaces the last line with a new take, asking for the same speaker.
    await page.click('#view-studio button:has-text("Redo last line")');
    await page.waitForFunction(() => storyStudio.findEntry(storyStudio.project('Ashen Crown'), 'The Return').lines[2].text === 'You came back.');
    const redo = await page.evaluate(() => window.__studioCalls[window.__studioCalls.length - 1][1].content);
    assert.match(redo, /Rewrite this line a different way: "State your business\."/);
    assert.match(redo, /spoken by Gatekeeper/);
    assert.equal(await page.evaluate(() => storyStudio.findEntry(storyStudio.project('Ashen Crown'), 'The Return').lines.length), 3);
    // Talking and scenes never changed the character's card.
    const rook = await page.evaluate(() => storyStudio.findEntry(storyStudio.project('Ashen Crown'), 'Rook'));
    assert.deepEqual([rook.summary, rook.fields], ['A disgraced knight.', {}]);

    await page.click('#view-studio button:has-text("Export to your game")');
    await page.selectOption('#view-studio select[aria-label="What to export"]', 'scenes');
    const preview = await page.textContent('#view-studio pre');
    assert.match(preview, /game_data\/scenes\/the_return\.json/);
    assert.match(preview, /"speaker_id": "rook"/);
    assert.deepEqual(errors, []);
});

test('in the page: an agent saves a character with studio_save; unrelated tasks don\'t get the tools', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openStudioPage(t, [
        [{ name: 'studio_save', arguments: { project: 'Ashen Crown', kind: 'character', name: 'Vel', summary: 'A fire witch.', fields: { speaking_style: 'Riddles.' } } }],
        'Made Vel.',
        'The answer is 4.'
    ]);
    await page.evaluate(() => storyStudio.createProject({ name: 'Ashen Crown' }));
    await sendPrompt(page, 'Create a villain character for Ashen Crown');
    await waitForChat(page, /Made Vel\./);
    const saved = await page.evaluate(() => storyStudio.findEntry(storyStudio.project('Ashen Crown'), 'Vel'));
    assert.equal(saved.fields.speaking_style, 'Riddles.');
    const first = await page.evaluate(() => window.__modelCalls[0]);
    assert.ok(first.tools.includes('studio_read') && first.tools.includes('studio_save'));
    assert.match(first.system, /\[Story Studio\] The user's game project "Ashen Crown"/);

    await sendPrompt(page, 'What is 2 + 2?');
    await waitForChat(page, /The answer is 4\./);
    const last = await page.evaluate(() => window.__modelCalls[window.__modelCalls.length - 1]);
    assert.ok(!last.tools.includes('studio_save'), 'no studio tools for an unrelated question');
    assert.doesNotMatch(last.system, /\[Story Studio\]/);
    assert.deepEqual(errors, []);
});

test('in the page: the studio fits a phone screen', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openStudioPage(t, [], { width: 390, height: 800 });
    await page.evaluate(() => {
        storyStudio.createProject({ name: 'Pocket Saga', pitch: 'A long pitch '.repeat(20) });
        storyStudio.saveEntry('', { kind: 'character', name: 'A very long character name that goes on and on', summary: 'x '.repeat(200) });
        mobileTab('studio');
    });
    await page.waitForSelector('#view-studio .gs-card');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px`);
    const tab = await page.$('.mobile-tab[data-view="studio"].active');
    assert.ok(tab, 'the Story tab is lit');
    assert.deepEqual(errors, []);
});

// ---------- Part 2: mood faces, voices, read-aloud ----------

test('moods come from a line\'s emotion word, faces fall back to calm then concept art, voices are clamped', () => {
    assert.equal(Studio.moodFor('cold'), 'angry');
    assert.equal(Studio.moodFor('Amused'), 'happy');
    assert.equal(Studio.moodFor('wary'), 'scared');
    assert.equal(Studio.moodFor(''), 'neutral');
    assert.deepEqual(Studio.splitMood('[Defiant] Never.'), { mood: 'defiant', text: 'Never.' });
    assert.deepEqual(Studio.splitMood('No tag here'), { mood: '', text: 'No tag here' });
    const pic = c => `data:image/jpeg;base64,${c}`;
    assert.equal(Studio.portraitFor({ portraits: { angry: { thumb: pic('A') }, neutral: { thumb: pic('N') } } }, 'furious'), pic('A'));
    assert.equal(Studio.portraitFor({ portraits: { neutral: { thumb: pic('N') } } }, 'sad'), pic('N'));
    assert.equal(Studio.portraitFor({ art: { thumb: pic('C') } }, 'sad'), pic('C'));
    assert.deepEqual(Studio.normalizeVoice({ engine: 'x', name: 'Ava', rate: 9, pitch: -1, elevenId: 'ab c!' }), { engine: 'device', name: 'Ava', rate: 2, pitch: 0, elevenId: 'abc' });

    const { store } = sampleStore();
    const mara = store.findEntry(store.project('Skyfall'), 'Mara Vex');
    store.saveEntry('', { id: mara.id, portraits: { angry: { id: 'img_1', thumb: pic('A') }, bogus: { thumb: pic('B') }, sad: { thumb: 'https://evil.example/x.png' } }, voice: { name: 'Ava', rate: 1.2 } });
    assert.deepEqual(Object.keys(store.findEntry(store.project('Skyfall'), 'Mara Vex').portraits), ['angry']);
    store.saveEntry('', { id: mara.id, locked: true });
    assert.equal(store.saveEntry('', { id: mara.id, portraits: { angry: null } }).locked, true, 'a locked character keeps its faces');
});

test('in the page: mood faces show in chats, lines are spoken in each character\'s voice, and a scene plays aloud', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openStudioPage(t, []);
    const seeds = [];
    // The free picture service: a 1px picture, noting the seed asked for.
    await page.route('https://image.pollinations.ai/**', route => {
        seeds.push(new URL(route.request().url()).searchParams.get('seed'));
        route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
    });
    await page.evaluate(() => {
        window.groqChatMessage = async () => ({ role: 'assistant', content: '[angry] Leave. Now.' });
        window.__spoken = [];
        // Stands in for the voices: notes each line and its voice, done at once.
        window.speakAsCharacter = async (text, voice) => { window.__spoken.push({ text, voice }); };
        storyStudio.createProject({ name: 'Ashen Crown' });
        storyStudio.saveEntry('', { kind: 'character', name: 'Rook', summary: 'A disgraced knight.', voice: { name: '', rate: 0.8, pitch: 0.6 } });
        storyStudio.saveEntry('', { kind: 'character', name: 'Vel', summary: 'A fire witch.', voice: { rate: 1.3, pitch: 1.5 } });
        storyStudio.updateProject(storyStudio.active().id, { narrator: { rate: 1, pitch: 1 } });
        storyStudio.saveEntry('', { kind: 'scene', name: 'Ashes', fields: { characters: 'Rook, Vel' }, lines: [
            { type: 'narration', text: 'Smoke rises.' }, { type: 'direction', text: 'Vel steps closer.' },
            { speaker: 'Vel', text: 'You owe me.', emotion: 'smug' }, { speaker: 'Rook', text: 'I owe nothing.', emotion: 'cold' }] });
        switchView('studio');
    });
    await page.click('#view-studio .gs-card:has-text("Rook")');
    await page.click('#view-studio summary:has-text("Mood faces")');
    await page.click('#view-studio .gs-face:has-text("Calm") button:has-text("Make")');
    await page.waitForSelector('#view-studio .gs-face:has-text("Calm") img');
    await page.click('#view-studio .gs-face:has-text("Angry") button:has-text("Make")');
    await page.waitForSelector('#view-studio .gs-face:has-text("Angry") img');
    assert.equal(seeds.length, 2);
    assert.equal(seeds[0], seeds[1], 'both faces use the character\'s seed');

    await page.click('#view-studio button:has-text("Talk to Rook")');
    await page.check('#view-studio label:has-text("Speak replies") input');
    await page.fill('#view-studio input[aria-label="Message"]', 'Hi');
    await page.press('#view-studio input[aria-label="Message"]', 'Enter');
    await page.waitForSelector('#view-studio .gs-said img');
    assert.equal(await page.textContent('#view-studio .gs-said .gs-bubble small'), 'Rook (angry)🔊');
    assert.equal(await page.textContent('#view-studio .gs-said .gs-bubble'), 'Rook (angry)🔊Leave. Now.');
    const spoken = await page.evaluate(() => window.__spoken);
    assert.deepEqual(spoken.map(s => [s.text, s.voice.pitch]), [['Leave. Now.', 0.6]]);

    await page.click('#view-studio button:has-text("Scene Builder")');
    await page.click('#view-studio .gs-card:has-text("Ashes")');
    await page.click('#view-studio button:has-text("Play scene")');
    await page.waitForFunction(() => window.__spoken.length === 4);
    const played = await page.evaluate(() => window.__spoken.slice(1).map(s => [s.text, s.voice && s.voice.pitch]));
    assert.deepEqual(played, [['Smoke rises.', 1], ['You owe me.', 1.5], ['I owe nothing.', 0.6]], 'the direction is skipped, each line in its own voice');
    assert.equal(await page.locator('#view-studio .gs-said img').count(), 1, 'Rook\'s line shows his angry face; Vel has none');
    assert.deepEqual(errors, []);
});

// ---------- Part 3: relationship web, timeline, story arcs ----------

test('links follow renames and deletions, the timeline keeps its order, arcs keep their beats, and all of it exports', async () => {
    const { store } = sampleStore();
    const p = store.project('Skyfall');
    const tools = Object.fromEntries(Studio.buildStudioTools(store).map(t => [t.name, t]));
    await tools.studio_save.run({ name: 'Mara Vex', links: [{ to: 'old tomas', type: 'mentor', note: 'Raised her' }, { to: 'Nobody', type: 'ally' }, { to: 'Mara Vex', type: 'ally' }] });
    let mara = store.findEntry(p, 'Mara Vex');
    assert.deepEqual(mara.links.map(l => [l.name, l.type]), [['Old Tomas', 'mentor']], 'unknown names and self-links are dropped');
    assert.match(await tools.studio_read.run({ name: 'Mara Vex' }), /Relationships: Mentor of Old Tomas \(Raised her\)/);
    const tomas = store.findEntry(p, 'Old Tomas');
    store.saveEntry('', { id: tomas.id, name: 'Tomas the Elder' });
    assert.equal(store.findEntry(p, 'Mara Vex').links[0].name, 'Tomas the Elder');

    store.saveEntry('', { kind: 'event', name: 'The Flood', order: 20 });
    store.saveEntry('', { kind: 'event', name: 'The Founding', order: 10 });
    store.saveEntry('', { kind: 'event', name: 'Unplaced' });
    assert.deepEqual(Studio.timelineOrder(p.entries.filter(e => e.kind === 'event')).map(e => e.name), ['The Founding', 'The Flood', 'Unplaced']);

    await tools.studio_save.run({ kind: 'arc', name: 'Mara learns to trust', beats: [{ text: 'She works alone', status: 'in_game' }, { text: 'Tomas is taken', status: 'bogus' }, { text: '' }] });
    assert.deepEqual(store.findEntry(p, 'Mara learns to trust').beats, [{ text: 'She works alone', status: 'in_game' }, { text: 'Tomas is taken', status: 'idea' }]);

    const bible = JSON.parse(Studio.toJson(p));
    assert.deepEqual(bible.entries_by_kind.characters[0].links, [{ to: 'tomas_the_elder', to_kind: 'character', type: 'mentor', note: 'Raised her' }]);
    assert.deepEqual(bible.entries_by_kind.timeline.map(e => e.name), ['The Founding', 'The Flood', 'Unplaced']);
    assert.equal(bible.entries_by_kind.arcs[0].beats.length, 2);
    assert.match(Studio.toGdscript(p), /^const ARCS := \{/m);

    store.removeEntry('', store.findEntry(p, 'Tomas the Elder').id);
    assert.equal(store.findEntry(p, 'Mara Vex').links, undefined, 'a deleted entry\'s links go with it');
});

test('in the page: link two characters and see the web, reorder the timeline, and work an arc board', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openStudioPage(t, []);
    await page.evaluate(() => {
        storyStudio.createProject({ name: 'Ashen Crown' });
        storyStudio.saveEntry('', { kind: 'character', name: 'Rook' });
        storyStudio.saveEntry('', { kind: 'character', name: 'Vel' });
        storyStudio.saveEntry('', { kind: 'event', name: 'The Burning', order: 10 });
        storyStudio.saveEntry('', { kind: 'event', name: 'The Exile', order: 20 });
        switchView('studio');
    });
    await page.click('#view-studio .gs-card:has-text("Rook")');
    await page.click('#view-studio summary:has-text("Relationships")');
    await page.selectOption('#view-studio select[aria-label="Related to"]', { label: '🧍 Vel' });
    await page.selectOption('#view-studio .gs-section select[aria-label="Relationship"]', 'rival');
    await page.click('#view-studio button:has-text("＋ Add")');
    await page.waitForFunction(() => storyStudio.findEntry(storyStudio.active(), 'Rook').links?.[0]?.type === 'rival');

    await page.click('#view-studio .gs-tabs button:has-text("Relationships")');
    assert.equal(await page.locator('#view-studio svg.gs-web .gs-web-node').count(), 2);
    assert.equal(await page.locator('#view-studio svg.gs-web line').count(), 1);
    await page.click('#view-studio .gs-web-node[aria-label="Vel"]');
    assert.match(await page.textContent('#view-studio .gs-form'), /Rook → rival: Vel/);

    await page.click('#view-studio .gs-tabs button:has-text("Timeline")');
    await page.click('#view-studio button[aria-label="Move The Exile earlier"]');
    assert.deepEqual(await page.$$eval('#view-studio .gs-timeline b', bs => bs.map(b => b.textContent)), ['The Exile', 'The Burning']);

    await page.click('#view-studio .gs-tabs button:has-text("Story arcs")');
    await page.fill('#view-studio input[aria-label="New arc"]', 'Rook\'s redemption');
    await page.click('#view-studio button:has-text("New arc")');
    await page.fill('#view-studio input[aria-label="Add a beat to Rook\'s redemption"]', 'He refuses the crown');
    await page.press('#view-studio input[aria-label="Add a beat to Rook\'s redemption"]', 'Enter');
    await page.click('#view-studio .gs-beat button:has-text("Idea")');
    const arc = await page.evaluate(() => storyStudio.findEntry(storyStudio.active(), 'Rook\'s redemption'));
    assert.deepEqual(arc.beats, [{ text: 'He refuses the crown', status: 'written' }]);
    assert.deepEqual(errors, []);
});

// ---------- Part 4: interview mode, what-if branches, lore checker ----------

test('the lore check sends the related entries first and reads back issues; a what-if scene exports where it branched', () => {
    const { store } = sampleStore();
    const p = store.project('Skyfall');
    const mara = store.findEntry(p, 'Mara Vex');
    const messages = Studio.loreCheckPrompt(p, [mara], 60);
    assert.match(messages[0].content, /contradictions/);
    assert.match(messages[1].content, /\[Story bible\]\n(Character|Place): /);
    assert.match(messages[1].content, /\[Check this\]\nCharacter: Mara Vex/);
    assert.deepEqual(Studio.parseIssues('Found: [{"problem": "Mara is 20 here but 30 in The Flood", "conflicts_with": "The Flood", "suggestion": "Pick one"}]'),
        [{ problem: 'Mara is 20 here but 30 in The Flood', conflicts_with: 'The Flood', suggestion: 'Pick one' }]);
    assert.deepEqual(Studio.parseIssues('[]'), []);
    assert.equal(Studio.parseIssues('no idea'), null);

    store.saveEntry('', { kind: 'scene', name: 'Duel', fields: { characters: 'Mara Vex' }, lines: [{ speaker: 'Mara Vex', text: 'A' }, { speaker: 'Mara Vex', text: 'B' }] });
    store.saveEntry('', { kind: 'scene', name: 'Duel: what if', fields: { characters: 'Mara Vex', branch_of: 'Duel', branch_at: '1' }, lines: [{ speaker: 'Mara Vex', text: 'A' }, { type: 'direction', text: 'What if: she runs' }] });
    const branch = JSON.parse(Studio.exportFiles(p, 'scenes')['game_data/scenes/duel_what_if.json']);
    assert.equal(branch.branch_of, 'duel');
    assert.equal(branch.branch_from, 'n1');
});

test('in the page: an interview kept as notes, a what-if branch, and a lore check that changes nothing', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { page, errors } = await openStudioPage(t, []);
    await page.evaluate(() => {
        window.groqChatMessage = async body => {
            const system = body.messages[0].content;
            if (/check the story bible/.test(system)) return { role: 'assistant', content: '[{"problem": "Rook is called an only child, but Vel is his sister", "conflicts_with": "Vel", "suggestion": "Make Vel a cousin"}]' };
            return { role: 'assistant', content: '[sad] Fire. Always fire.' };
        };
        storyStudio.createProject({ name: 'Ashen Crown' });
        storyStudio.saveEntry('', { kind: 'character', name: 'Rook', summary: 'An only child.' });
        storyStudio.saveEntry('', { kind: 'character', name: 'Vel', summary: 'Rook\'s sister.' });
        storyStudio.saveEntry('', { kind: 'scene', name: 'Ashes', fields: { characters: 'Rook, Vel' }, lines: [{ speaker: 'Vel', text: 'One.' }, { speaker: 'Rook', text: 'Two.' }, { speaker: 'Vel', text: 'Three.' }] });
        switchView('studio');
    });
    const before = await page.evaluate(() => JSON.stringify(storyStudio.findEntry(storyStudio.active(), 'Rook')));

    await page.click('#view-studio .gs-tabs button:has-text("Talk")');
    await page.click('#view-studio summary:has-text("Interview mode")');
    await page.selectOption('#view-studio select[aria-label="Interview question"]', 'What do you fear more than anything?');
    await page.click('#view-studio .gs-section button:has-text("Ask")');
    await page.waitForSelector('#view-studio .gs-bubble:has-text("Fire. Always fire.")');
    await page.click('#view-studio button:has-text("Keep the answers as notes")');
    const notes = await page.evaluate(() => storyStudio.findEntry(storyStudio.active(), 'Interview with Rook'));
    assert.equal(notes.kind, 'lore');
    assert.equal(notes.fields.details, 'Q: What do you fear more than anything?\nA: Fire. Always fire.');

    await page.click('#view-studio .gs-tabs button:has-text("Scene Builder")');
    await page.click('#view-studio .gs-card:has-text("Ashes")');
    await page.locator('#view-studio [data-line="1"] button:has-text("What if")').click();
    await page.fill('#view-studio input[aria-label="What if"]', 'Rook walks away');
    await page.click('#view-studio button:has-text("🌿 Branch")');
    const branch = await page.evaluate(() => storyStudio.findEntry(storyStudio.active(), 'Ashes: what if'));
    assert.deepEqual(branch.lines.map(l => l.text), ['One.', 'Two.', 'What if: Rook walks away']);
    assert.equal(branch.fields.branch_of, 'Ashes');
    assert.equal((await page.evaluate(() => storyStudio.findEntry(storyStudio.active(), 'Ashes'))).lines.length, 3, 'the original scene is untouched');

    await page.click('#view-studio .gs-tabs button:has-text("Story bible")');
    await page.click('#view-studio button:has-text("Check the whole bible")');
    await page.waitForSelector('#view-studio .gs-issue');
    assert.match(await page.textContent('#view-studio .gs-issue'), /only child[\s\S]*Conflicts with: Vel[\s\S]*Make Vel a cousin/);
    assert.equal(await page.evaluate(() => JSON.stringify(storyStudio.findEntry(storyStudio.active(), 'Rook'))), before, 'Rook was never changed');
    assert.deepEqual(errors, []);
});
