// Lore bridges (mobile/www/agent-ui/lore-bridges.js): Story Studio's bible to and from an
// Chronicler vault, an Azgaar's Fantasy Map Generator JSON export and a StoryCraftr book
// folder; the store's mergeEntries; the agents' studio_import; and the desktop art tools
// reading the vault so a brief that names a character gets their canon look.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Studio = require('../mobile/www/agent-ui/story-studio.js');
const B = require('../mobile/www/agent-ui/lore-bridges.js');
const { createCreativeService } = require('../desktop/creative');
const L = require('../desktop/creative/lore');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage } = require('./helpers/page-driver');

const AZGAAR = fs.readFileSync(path.join(__dirname, 'fixtures', 'azgaar-continuum.json'), 'utf8');

function memoryStorage() {
    const data = {};
    return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
}

function continuum() {
    const store = Studio.createStudioStore(memoryStorage());
    store.createProject({ name: 'Continuum Universe', pitch: 'Relay and Null across fractured timelines.' });
    store.saveEntry('', { kind: 'faction', name: 'Null', summary: 'The cult that follows Null.' });
    store.saveEntry('', { kind: 'character', name: 'Relay', summary: 'A courier of timelines.', tags: ['hero', 'A.E.G.I.S. pilot'],
        fields: { appearance: 'Carbon-black armour, cyan energy seams, crowned helmet', powers: 'Dash, afterimage' } });
    store.saveEntry('', { kind: 'character', name: 'Null', summary: 'The void walker.', fields: { appearance: 'Matte white plating, no face' },
        links: [{ to: 'Relay', type: 'enemy', note: 'since the Fracture' }] });
    store.saveEntry('', { kind: 'scene', name: 'First clash', lines: [{ speaker: 'Relay', text: 'Stand down.', emotion: 'angry' }, { type: 'direction', text: 'Null raises a hand' }, { type: 'narration', text: 'Time stutters.' }] });
    store.saveEntry('', { kind: 'arc', name: 'Relay rises', beats: [{ text: 'Relay loses the crown', status: 'written' }] });
    store.saveEntry('', { kind: 'event', name: 'The Fracture', order: 1, fields: { what: 'Time splits into shards.' } });
    return store;
}

const asFiles = map => Object.entries(map).map(([p, text]) => ({ path: p, text }));

test('the bible goes out as a Chronicler vault and comes back the same', () => {
    const store = continuum();
    const p = store.active();
    const vault = B.toChroniclerVault(p, 'lore');
    const names = Object.keys(vault).sort();
    assert.deepEqual(names, ['lore/Characters/Null.md', 'lore/Characters/Relay.md', 'lore/Continuum Universe.md', 'lore/Factions/Null.md', 'lore/Scenes/First clash.md', 'lore/Story arcs/Relay rises.md', 'lore/Timeline/The Fracture.md']);
    const relay = vault['lore/Characters/Relay.md'];
    // Chronicler's own keys, then the short fields as its infobox, then CoDev's.
    assert.match(relay, /^---\ntitle: "Relay"\nsubtitle: "Character"\ntags:\n {2}- "character"\n {2}- "hero"\n {2}- "A\.E\.G\.I\.S\. pilot"\nAppearance: "Carbon-black armour, cyan energy seams, crowned helmet"\nPowers and abilities: "Dash, afterimage"\ncodev_kind: "character"\n---\n/);
    assert.match(vault['lore/Timeline/The Fracture.md'], /\ncodev_order: 1\n/);
    assert.match(vault['lore/Characters/Null.md'], /- Enemy: \[\[Relay\]\] \(since the Fracture\)/);
    assert.match(vault['lore/Continuum Universe.md'], /\[\[Characters\/Null\|Null\]\]/, 'two notes named Null link by path');

    const back = B.parseVault(asFiles(vault).map(f => ({ ...f, path: f.path.replace(/^lore\//, '') })));
    assert.equal(back.name, 'Continuum Universe');
    assert.equal(back.pitch, 'Relay and Null across fractured timelines.');
    const copy = store.createProject({ name: 'Copy' }).project;
    const done = store.mergeEntries(copy.id, back.entries);
    assert.deepEqual([done.created, done.updated, done.links], [6, 0, 1]);
    const strip = list => list.map(e => ({ kind: e.kind, name: e.name, summary: e.summary, fields: e.fields, tags: e.tags, order: e.order,
        links: (e.links || []).map(l => [l.name, l.type, l.note]), lines: (e.lines || []).map(l => [l.type || 'line', l.speaker || '', l.text, l.emotion || '']), beats: e.beats }));
    assert.deepEqual(strip(store.project('Copy').entries), strip(p.entries));
});

test('hand-written notes: folders, properties, tags, headings and links say what they are', () => {
    const vault = B.parseVault([
        { path: 'People/Kestrel.md', text: '---\naliases: [Kes, "The Wren"]\nfaction: "[[Iron Choir]]"\nenemies:\n  - "[[Null]]"\nage: 31\n---\n# Kestrel\n\nA scout who hears the timelines hum.\n\n## Looks\n\nGrey cloak, brass goggles.\n\n## Voice\nDry and quiet.\n' },
        { path: 'Groups/Iron Choir.md', text: 'Singers who keep the walls standing.\n\n## Territory\nThe Spire.\n\n## Relationships\n- Rival of [[Null]]\n' },
        { path: 'misc/Null.md', text: '---\ntags: [character, villain]\n---\nThe void walker. See [[Kestrel]] and [[Nowhere]].' },
        { path: '.chronicler/snippets/x.md', text: 'x' }, { path: 'Templates/Character.md', text: '## Looks' }, { path: 'pic.png', text: '' }
    ]);
    assert.equal(vault.skipped, 3);
    const by = Object.fromEntries(vault.entries.map(e => [e.name, e]));
    assert.equal(by.Kestrel.kind, 'character');
    assert.equal(by.Kestrel.summary, 'A scout who hears the timelines hum.');
    assert.equal(by.Kestrel.fields.appearance, 'Grey cloak, brass goggles.');
    assert.equal(by.Kestrel.fields.speaking_style, 'Dry and quiet.');
    assert.equal(by.Kestrel.fields.aliases, 'Kes, The Wren');
    assert.equal(by.Kestrel.fields.age, '31');
    assert.deepEqual(by.Kestrel.links, [{ to: 'Iron Choir', type: 'member' }, { to: 'Null', type: 'enemy' }]);
    assert.equal(by['Iron Choir'].kind, 'faction');
    assert.equal(by['Iron Choir'].fields.territory, 'The Spire.');
    assert.deepEqual(by['Iron Choir'].links, [{ to: 'Null', type: 'rival' }]);
    assert.equal(by.Null.kind, 'character', 'a #character tag');
    assert.deepEqual(by.Null.tags, ['villain']);
    assert.deepEqual(by.Null.links, [{ to: 'Kestrel', type: 'other' }, { to: 'Nowhere', type: 'other' }], 'links outside the vault keep their name');
    const store = Studio.createStudioStore(memoryStorage());
    store.createProject({ name: 'Mine' });
    store.mergeEntries('', vault.entries);
    assert.deepEqual(store.findEntry(store.active(), 'Null').links.map(l => l.name), ['Kestrel'], 'and the bible drops what it doesn\'t have');
    assert.deepEqual(B.loreMatches(vault.entries, 'a winter skin for kes').map(e => e.name), ['Kestrel'], 'aliases match');
    assert.deepEqual(B.loreMatches(vault.entries, 'nullify'), [], 'whole words only');
});

test('a page written in Chronicler: title, subtitle, infobox, tags, inserts and spoilers', () => {
    const vault = B.parseVault([
        { path: 'World/Rivertown.md', text: "---\ntitle: Rivertown\nsubtitle: City\ntags: [trade, river]\nimage: rivertown.jpg\npopulation: 12000\nleader: '[[Mara Vell|Lady Mara]]'\nlayout:\n  - type: separator\n---\nA market town on the Sel.\n\n{{insert: Trade Routes}}\n\n## Inhabitants\nBargemen and ||a hidden guild||.\n" },
        { path: 'World/Mara Vell.md', text: '---\ntitle: Mara Vell\nsubtitle: Character\nRole in the story: Ruler of Rivertown\n---\nShe keeps the river tolls.' }
    ]);
    const by = Object.fromEntries(vault.entries.map(e => [e.name, e]));
    assert.equal(by.Rivertown.kind, 'location', 'the subtitle says what it is');
    assert.deepEqual(by.Rivertown.tags, ['trade', 'river']);
    assert.equal(by.Rivertown.summary, 'A market town on the Sel.');
    assert.equal(by.Rivertown.fields.population, '12000');
    assert.equal(by.Rivertown.fields.inhabitants, 'Bargemen and a hidden guild.');
    assert.ok(!('image' in by.Rivertown.fields) && !('layout' in by.Rivertown.fields), "Chronicler's own keys aren't lore");
    assert.deepEqual(by.Rivertown.links, [{ to: 'Mara Vell', type: 'other', note: 'leader' }]);
    assert.equal(by['Mara Vell'].kind, 'character');
    assert.equal(by['Mara Vell'].fields.role, 'Ruler of Rivertown', 'infobox labels map back to fields');
});

test('an Azgaar map becomes factions with borders and diplomacy, places with positions, and lore', () => {
    const map = B.fromAzgaar(AZGAAR);
    assert.equal(map.name, 'Continuum');
    const by = Object.fromEntries(map.entries.map(e => [e.name, e]));
    const dominion = by['Aegis Dominion'];
    assert.equal(dominion.kind, 'faction');
    assert.match(dominion.fields.territory, /Capital: Relay Spire\. Provinces: Spirewatch\. 2 cities and towns \(largest: Relay Spire, Tessel\)\. Borders: Null Expanse\./);
    assert.match(dominion.fields.history, /War of the Fracture \(1130–1138\)/);
    assert.deepEqual(dominion.links, [{ to: 'Null Expanse', type: 'enemy' }]);
    assert.equal(by['Null Expanse'].fields.history, 'Ruled from the void by Null.', 'the state\'s note');
    assert.ok(by['Null Expanse (province)'], 'a province named like its state gets told apart');
    const spire = by['Relay Spire'];
    assert.equal(spire.kind, 'location');
    assert.equal(spire.summary, 'Capital of Aegis Dominion, about 42,500 people.');
    assert.equal(spire.fields.map_position, 'x 500, y 301 on the 1920×1080 map');
    assert.equal(spire.fields.history, 'Where Relay first crossed the timelines.', 'HTML stripped from the note');
    assert.deepEqual(spire.links, [{ to: 'Aegis Dominion', type: 'member' }]);
    assert.ok(!by['Old Ruin'], 'removed burgs stay out');
    assert.equal(by['Church of the Signal'].summary, 'Organized monotheism, worshipping The First Signal.');
    assert.equal(by['Routes of Continuum'].fields.details, '- (roads): Relay Spire → Tessel\n- Void Lane (searoutes): Relay Spire → Hollow Gate');
    assert.match(by['Map of Continuum'].summary, /year 1142 of the Fractured Era/);
    assert.deepEqual(B.fromAzgaar(AZGAAR, { maxBurgs: 2 }).stats, { states: 2, provinces: 2, burgs: 2, allBurgs: 3, cultures: 2, religions: 1 });
    assert.match(B.fromAzgaar('1.99|Continuum|...').error, /\.map save file.*Export to JSON > Full/);
    assert.match(B.fromAzgaar('{"info":{}}').error, /no states/);

    const store = continuum();
    store.saveEntry('', { kind: 'faction', name: 'Aegis Dominion', fields: { purpose: 'Keep the timelines whole.' }, locked: true });
    const done = store.mergeEntries('', map.entries);
    assert.equal(done.locked, 1, 'a locked entry is left alone');
    const locked = store.findEntry(store.active(), 'Aegis Dominion', 'faction');
    assert.deepEqual(locked.fields, { purpose: 'Keep the timelines whole.' });
    const nullState = store.findEntry(store.active(), 'Null Expanse', 'faction');
    assert.deepEqual(nullState.links.map(l => [l.name, l.type]), [['Aegis Dominion', 'enemy']]);
    // Importing the same map again updates, it doesn't duplicate.
    const again = store.mergeEntries('', map.entries);
    assert.equal(again.created, 0);
    assert.equal(again.links, 0);
});

test('StoryCraftr: the bible goes into its book folder and what it writes comes back as lore', () => {
    const store = continuum();
    const files = B.toStoryCraftr(store.active(), 'storycraftr');
    assert.deepEqual(Object.keys(files).sort(), ['storycraftr/outline/character_summary.md', 'storycraftr/outline/general_outline.md', 'storycraftr/outline/plot_points.md', 'storycraftr/worldbuilding/culture.md', 'storycraftr/worldbuilding/history.md']);
    assert.match(files['storycraftr/outline/character_summary.md'], /## Null\n\nThe void walker\.\n\n\*\*Appearance:\*\* Matte white plating, no face\n\n\*\*Relationships:\*\* Enemy of Relay \(since the Fracture\)/);
    assert.match(files['storycraftr/worldbuilding/history.md'], /## The Fracture/);
    const back = B.fromStoryCraftr([
        ...asFiles(files),
        { path: 'storycraftr/worldbuilding/magic_system.md', text: '# Magic System\n\nThe Continuum hums at three frequencies.\n\nOnly couriers hear the third.' },
        { path: 'storycraftr/chapters/chapter-1.md', text: '# Chapter 1\n\nIt begins.' }
    ]);
    assert.deepEqual(back.entries.map(e => e.name), ['StoryCraftr: Magic system'], 'CoDev\'s own files and chapters are skipped');
    assert.equal(back.entries[0].summary, 'The Continuum hums at three frequencies.');
});

test('agents import a vault and an Azgaar map from the project folder with studio_import', async () => {
    const store = continuum();
    const folder = { 'lore/Characters/Kestrel.md': '---\ncodev_kind: character\n---\nA scout.\n\n## Relationships\n- Ally: [[Relay]]\n', 'maps/continuum.json': AZGAAR };
    const asked = [];
    const tools = Studio.buildStudioTools(store, { bridges: B, confirm: async t => { asked.push(t); return true; },
        readFolder: async p => Object.entries(folder).filter(([k]) => k === p || k.startsWith(p + '/')).map(([k, text]) => ({ path: k === p ? k : k.slice(p.length + 1), text })) });
    const imp = tools.find(t => t.name === 'studio_import');
    assert.match(await imp.run({ source: 'chronicler', path: 'lore' }), /1 added, 0 updated, 1 relationships/);
    assert.equal(store.findEntry(store.active(), 'Kestrel').links[0].name, 'Relay');
    assert.match(await imp.run({ source: 'azgaar', path: 'maps/continuum.json', max_cities: 1 }), /added/);
    assert.ok(store.findEntry(store.active(), 'Relay Spire'));
    assert.ok(store.findEntry(store.active(), 'Hollow Gate'), 'every capital comes in');
    assert.ok(!store.findEntry(store.active(), 'Tessel'), 'past max_cities');
    assert.match(await imp.run({ source: 'chronicler', path: 'nowhere' }), /nothing at nowhere/);
    assert.equal(asked.length, 2);
    const written = {};
    const exp = Studio.buildStudioTools(store, { bridges: B, writeFiles: async files => { Object.assign(written, files); return `Saved ${Object.keys(files).length} files.` } }).find(t => t.name === 'studio_export');
    assert.match(await exp.run({ format: 'chronicler' }), /Saved \d+ files/);
    assert.ok(written['lore/Characters/Kestrel.md']);
});

test('the desktop art tools read the vault and add a named character\'s look to the prompt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-lore-'));
    const store = continuum();
    for (const [rel, text] of Object.entries(B.toChroniclerVault(store.active(), 'lore'))) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
    fs.mkdirSync(path.join(dir, 'game_data'));
    fs.writeFileSync(path.join(dir, 'game_data', 'story_bible.json'), Studio.toJson({ ...store.active(), entries: [{ id: 'x', kind: 'item', name: 'Crown of Echoes', summary: '', fields: { description: 'A halo of broken clock hands' }, tags: [] }] }));
    assert.equal(L.available, true);
    const loaded = L.loadLore(dir, {});
    assert.deepEqual(loaded.read, ['lore/ (6 notes)', 'game_data/story_bible.json (1 entries)']);

    const prompts = [];
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fetchImpl = async url => { prompts.push(decodeURIComponent(String(url).split('/prompt/')[1].split('?')[0])); return { ok: true, status: 200, arrayBuffer: async () => PNG }; };
    const svc = createCreativeService({ getProjectDir: () => dir, fetchImpl, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' } });
    const gen = await svc.callTool('art_generate', { prompt: 'battle skin for Relay wearing the Crown of Echoes', count: 1, no_preview: true, seed: 1 });
    assert.ok(!gen.isError, gen.content[0].text);
    assert.match(prompts[0], /Relay: Carbon-black armour, cyan energy seams, crowned helmet/);
    assert.match(prompts[0], /Crown of Echoes: A halo of broken clock hands/);
    assert.match(gen.content[0].text, /Lore: added the look of Crown of Echoes \(game_data\/story_bible\.json\), Relay \(lore\)/);
    await svc.callTool('art_generate', { prompt: 'chest plate', lore_subject: 'relay', count: 1, no_preview: true, seed: 1 });
    assert.match(prompts[1], /Relay: Carbon-black/, 'the pipeline passes the character');
    await svc.callTool('art_generate', { prompt: 'Relay', lore: false, count: 1, no_preview: true, seed: 1 });
    assert.doesNotMatch(prompts[2], /Carbon-black/);

    const lore = await svc.callTool('art_lore', { name: 'null' });
    assert.match(lore.content[0].text, /character: Null \(from lore\)[\s\S]*appearance: Matte white plating[\s\S]*relationships: enemy Relay \(since the Fracture\)[\s\S]*faction: Null \(from lore\)/);
    const list = await svc.callTool('art_lore', {});
    assert.match(list.content[0].text, /Universe bible: lore\/ \(6 notes\), game_data\/story_bible\.json \(1 entries\)\. 7 entries/);
    const empty = createCreativeService({ getProjectDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'codev-lore-')) });
    assert.match((await empty.callTool('art_lore', {})).content[0].text, /No universe bible found/);
});

test('in the page: 🧭 World tools import a vault and an Azgaar map, and download the vault as a zip', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const backend = createMockBackend({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'codev-lore-page-')) });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, {});
    page.on('dialog', d => d.accept());
    await page.evaluate(() => {
        window.__saved = [];
        storyStudio.createProject({ name: 'Continuum Universe' });
        storyStudio.saveEntry('', { kind: 'character', name: 'Relay', fields: { appearance: 'Carbon-black armour' } });
        const original = CodevStoryStudio.mount;
        CodevStoryStudio.mount = (c, s, d) => original(c, s, Object.assign({}, d, { saveZip: (name, files) => window.__saved.push([name, Object.keys(files)]) }));
        switchView('studio');
    });
    await page.click('#view-studio .gs-tabs button:has-text("World tools")');
    assert.equal(await page.locator('#view-studio .gs-tool').count(), 3);

    let chooser = page.waitForEvent('filechooser');
    await page.click('#view-studio button:has-text("Import a vault")');
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-vault-'));
    fs.mkdirSync(path.join(vaultDir, 'Characters'));
    fs.writeFileSync(path.join(vaultDir, 'Characters', 'Null.md'), 'The void walker.\n\n## Relationships\n- Enemy: [[Relay]]\n');
    fs.writeFileSync(path.join(vaultDir, 'notes.png'), 'x');
    await (await chooser).setFiles(vaultDir);
    await page.waitForFunction(() => /1 added, 0 updated, 1 relationships/.test(document.querySelector('#view-studio .gs-world-msg').textContent));

    chooser = page.waitForEvent('filechooser');
    await page.click('#view-studio button:has-text("Import map JSON")');
    await (await chooser).setFiles([{ name: 'continuum.json', mimeType: 'application/json', buffer: Buffer.from(AZGAAR) }]);
    await page.waitForFunction(() => /Imported from the map "Continuum": 12 added/.test(document.querySelector('#view-studio .gs-world-msg').textContent));
    const bible = await page.evaluate(() => storyStudio.active().entries.map(e => `${e.kind}:${e.name}`));
    assert.ok(bible.includes('faction:Aegis Dominion') && bible.includes('location:Relay Spire') && bible.includes('character:Null'));

    await page.click('#view-studio button:has-text("Download vault (.zip)")');
    const saved = await page.evaluate(() => window.__saved);
    assert.equal(saved[0][0], 'continuum_universe_chronicler_vault.zip');
    assert.ok(saved[0][1].includes('Characters/Relay.md') && saved[0][1].includes('Factions/Aegis Dominion.md'));
    assert.deepEqual(errors, []);
});
