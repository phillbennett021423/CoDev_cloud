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
