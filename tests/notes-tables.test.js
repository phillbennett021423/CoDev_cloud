// Notes and tables (agent-ui/notes-tables.js), in place of Google Docs and Sheets:
// an Obsidian vault of Markdown notes and CSV/TSV/JSON tables, kept in a MEGA folder
// (through the real MEGA account logic over a stand-in for megajs) or in the project
// folder. Covers search, links and backlinks, every way of editing a note or a table,
// that edits ask first and can be turned off, and one run in the real page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Notes = require('../mobile/www/agent-ui/notes-tables.js');
const Mega = require('../mobile/www/agent-ui/mega-cloud.js');
const { createMegaConnect } = require('../desktop/mega-connect');
const { fakeMega } = require('./fixtures/fake-mega');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat, answerApprovals } = require('./helpers/page-driver');

const IDEAS = `---
tags: [project, game]
status: draft
---
# Game ideas

A roguelike set in [[Continuum]], see [[Relay|the courier]].

## Bosses
- The Warden

## Levels
- Docks #todo
`;

// A MEGA account with a vault in /Obsidian.
async function megaVault(t, { allowWrite = true } = {}) {
    const mega = fakeMega();
    const vault = mega.drive.add('Obsidian', mega.drive.rootId, { folder: true });
    const projects = mega.drive.add('Projects', vault, { folder: true });
    mega.drive.add('Game ideas.md', projects, { text: IDEAS, ts: 1762000000 });
    mega.drive.add('Continuum.md', vault, { text: '# Continuum\nThe world. Home of [[Game ideas]].', ts: 1761000000 });
    mega.drive.add('Relay.md', vault, { text: '# Relay\nCourier.', ts: 1760000000 });
    const hidden = mega.drive.add('.obsidian', vault, { folder: true });
    mega.drive.add('workspace.json', hidden, { text: '{}' });
    const data = mega.drive.add('Data', vault, { folder: true });
    mega.drive.add('players.csv', data, { text: 'Player,Team,Points\r\nJokic,DEN,31\r\n"Doncic, Luka",LAL,28\r\nTatum,BOS,25\r\n' });
    mega.drive.add('picks.json', data, { text: JSON.stringify({ season: 2026, picks: [{ player: 'Jokic', line: 29.5, hit: true }, { player: 'Tatum', line: 26.5, hit: false }] }) });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-notes-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const connect = createMegaConnect({ sessionFile: path.join(dir, 'mega.json'), Storage: mega.Storage });
    await connect.handle({ op: 'signin', email: 'pb@example.com', password: 'right-pass', allowWrite });
    const transport = Mega.backendTransport(req => connect.handle(req), 'computer');
    return { mega, connect, transport };
}

function toolsFor(transport, { edit = true, approve = () => true, asked = [] } = {}) {
    return Notes.createNotesTables({
        getStore: async () => Notes.megaStore(transport, '/Obsidian'),
        canEdit: () => edit,
        confirmWrite: async message => { asked.push(message); return approve(message); }
    });
}

const textOf = (mega, name) => mega.drive.nodes.filter(n => n.name === name && n.parentId !== mega.drive.trashId).map(n => n.text).pop();

test('notes: properties, tags and [[links]] are read the way Obsidian writes them', () => {
    const note = Notes.parseNote(IDEAS);
    assert.deepEqual(note.props.tags, ['project', 'game']);
    assert.equal(note.props.status, 'draft');
    assert.deepEqual(note.tags.sort(), ['game', 'project', 'todo']);
    assert.deepEqual(note.links, ['Continuum', 'Relay']);
    assert.deepEqual(note.headings, ['# Game ideas', '## Bosses', '## Levels']);
    assert.equal(Notes.cleanPath('../secret.md'), null);
    assert.equal(Notes.cleanPath('.obsidian/x.md'), null);
    assert.equal(Notes.cleanPath('Projects\\Ideas.md'), 'Projects/Ideas.md');
});

test('tables: CSV quoting, TSV and JSON round-trip and keep their format', () => {
    const csv = Notes.parseTable('a.csv', 'Name,Note\r\n"Doncic, Luka","said ""hi"""\r\n');
    assert.deepEqual(csv.rows, [['Doncic, Luka', 'said "hi"']]);
    assert.equal(Notes.serializeTable(csv), 'Name,Note\r\n"Doncic, Luka","said ""hi"""\r\n');
    const tsv = Notes.parseTable('a.tsv', 'A\tB\n1\t2\n');
    assert.deepEqual(tsv.columns, ['A', 'B']);
    const original = JSON.stringify({ season: 2026, picks: [{ player: 'Jokic', line: 29.5, hit: true }] });
    const json = Notes.parseTable('p.json', original);
    assert.deepEqual(json.columns, ['player', 'line', 'hit']);
    json.rows.push(['Tatum', '26.5', 'false']);
    assert.deepEqual(JSON.parse(Notes.serializeTable(json, original)), { season: 2026, picks: [{ player: 'Jokic', line: 29.5, hit: true }, { player: 'Tatum', line: 26.5, hit: false }] });
    assert.match(Notes.parseTable('bad.json', '{"a": 1}').error, /no list of rows/);
});

test('notes in a MEGA vault: search, tags, reading with links and backlinks', async t => {
    const { transport } = await megaVault(t);
    const { TOOLS } = toolsFor(transport);
    const listed = await TOOLS.notes_search.run({});
    assert.match(listed, /^Projects\/Game ideas\.md/);
    assert.doesNotMatch(listed, /workspace\.json|\.obsidian|players\.csv/);
    assert.match(await TOOLS.notes_search.run({ query: 'roguelike' }), /Projects\/Game ideas\.md · #project #game #todo\n  …A roguelike set in \[\[Continuum\]\]/);
    assert.match(await TOOLS.notes_search.run({ tag: '#todo' }), /Game ideas\.md/);
    assert.match(await TOOLS.notes_search.run({ query: 'nothing here' }), /No notes match "nothing here"/);
    assert.match(await TOOLS.notes_search.run({ kind: 'tables' }), /Data\/players\.csv[\s\S]*Data\/picks\.json|Data\/picks\.json[\s\S]*Data\/players\.csv/);

    const read = await TOOLS.notes_read.run({ note: 'Game ideas' });
    assert.match(read, /^Projects\/Game ideas\.md/);
    assert.match(read, /Tags: #project #game #todo/);
    assert.match(read, /Links to: \[\[Continuum\]\], \[\[Relay\]\]/);
    assert.match(read, /Linked from: Continuum\.md/);
    assert.match(read, /## Bosses/);
    assert.match(await TOOLS.notes_read.run({ note: 'Nope' }), /No note "Nope"/);
});

test('notes_write creates, appends under a heading, edits and replaces, asking every time', async t => {
    const { mega, transport } = await megaVault(t);
    const asked = [];
    let ok = true;
    const { TOOLS } = toolsFor(transport, { asked, approve: () => ok });

    assert.match(await TOOLS.notes_write.run({ note: 'Daily/2026-11-02', content: '# Today\n- [ ] Ship MEGA' }), /Created Daily\/2026-11-02\.md in the MEGA folder \/Obsidian/);
    assert.equal(textOf(mega, '2026-11-02.md'), '# Today\n- [ ] Ship MEGA');
    assert.match(asked[0], /Create the note Daily\/2026-11-02\.md/);
    assert.match(await TOOLS.notes_write.run({ note: 'Relay', content: 'x' }), /already exists/);

    assert.match(await TOOLS.notes_write.run({ note: 'Game ideas', mode: 'append', under_heading: 'Bosses', content: '- The Archivist' }), /Saved Projects\/Game ideas\.md/);
    assert.match(textOf(mega, 'Game ideas.md'), /- The Warden\n- The Archivist\n\n## Levels/);
    assert.ok(mega.drive.deleted.includes('Game ideas.md'), 'the old version went to the Rubbish Bin');

    assert.match(await TOOLS.notes_write.run({ note: 'Game ideas', mode: 'edit', find: 'status: draft', replace_with: 'status: active' }), /Saved/);
    assert.match(textOf(mega, 'Game ideas.md'), /status: active/);
    assert.match(asked.at(-1), /- status: draft\n\+ status: active/);
    assert.match(await TOOLS.notes_write.run({ note: 'Game ideas', mode: 'edit', find: '- ', replace_with: '* ' }), /appears \d+ times/);
    assert.match(await TOOLS.notes_write.run({ note: 'Game ideas', mode: 'append', under_heading: 'Nope', content: 'x' }), /no heading "Nope"/);

    ok = false;
    assert.match(await TOOLS.notes_write.run({ note: 'Relay', mode: 'replace', content: 'gone' }), /declined/);
    assert.equal(textOf(mega, 'Relay.md'), '# Relay\nCourier.');
    assert.match(await TOOLS.notes_write.run({ note: '../escape', content: 'x' }), /needs the note's path/);
});

test('tables: query every row, then append, update, delete and add columns', async t => {
    const { mega, transport } = await megaVault(t);
    const asked = [];
    const { TOOLS } = toolsFor(transport, { asked });

    assert.match(await TOOLS.table_read.run({ table: 'Data/players.csv' }), /3 rows, columns Player, Team, Points[\s\S]*Doncic, Luka \| LAL \| 28/);
    assert.match(await TOOLS.table_read.run({ table: 'players', filters: [{ column: 'Points', op: '>', value: '26' }] }), /Jokic[\s\S]*Doncic/);
    assert.doesNotMatch(await TOOLS.table_read.run({ table: 'players', filters: [{ column: 'Points', op: '>', value: '26' }] }), /Tatum/);

    assert.match(await TOOLS.table_write.run({ table: 'Data/players.csv', mode: 'append_rows', rows: [{ Player: 'Edwards', Team: 'MIN', Points: 27 }] }), /Saved Data\/players\.csv \(4 rows\)/);
    assert.match(await TOOLS.table_write.run({ table: 'Data/players.csv', mode: 'update_rows', where: [{ column: 'Player', op: '=', value: 'tatum' }], set: { Points: 30 } }), /Saved/);
    assert.match(asked.at(-1), /Change 1 row in Data\/players\.csv: set Points = 30/);
    assert.match(await TOOLS.table_write.run({ table: 'Data/players.csv', mode: 'add_column', column: 'Hit', value: 'no' }), /Saved/);
    assert.match(await TOOLS.table_write.run({ table: 'Data/players.csv', mode: 'delete_rows', where: [{ column: 'Team', op: '=', value: 'DEN' }] }), /Saved Data\/players\.csv \(3 rows\)/);
    assert.equal(textOf(mega, 'players.csv'), 'Player,Team,Points,Hit\r\n"Doncic, Luka",LAL,28,no\r\nTatum,BOS,30,no\r\nEdwards,MIN,27,no\r\n');

    assert.match(await TOOLS.table_write.run({ table: 'Data/picks.json', mode: 'append_rows', rows: [['Edwards', 25.5, true]] }), /Saved/);
    assert.deepEqual(JSON.parse(textOf(mega, 'picks.json')), { season: 2026, picks: [{ player: 'Jokic', line: 29.5, hit: true }, { player: 'Tatum', line: 26.5, hit: false }, { player: 'Edwards', line: 25.5, hit: true }] });

    assert.match(await TOOLS.table_write.run({ table: 'Data/new', columns: ['Day', 'Profit'], rows: [['Mon', 12]] }), /Saved Data\/new\.csv \(1 rows\)/);
    assert.equal(textOf(mega, 'new.csv'), 'Day,Profit\r\nMon,12\r\n');
    assert.match(await TOOLS.table_write.run({ table: 'Data/new.csv', columns: ['x'] }), /already exists/);
    assert.match(await TOOLS.table_write.run({ table: 'Data/players.csv', mode: 'update_rows', where: [{ column: 'Nope', value: 1 }], set: { Points: 1 } }), /No column "Nope"/);
});

test('tools are offered only when they can work, and editing can be off', async t => {
    const none = Notes.createNotesTables({ getStore: async () => ({ error: 'No vault.' }) });
    assert.deepEqual((await none.buildTools()).map(x => x.name), ['notes_status']);
    assert.match(await none.TOOLS.notes_status.run(), /No vault\./);

    const { transport, connect } = await megaVault(t);
    assert.deepEqual((await toolsFor(transport, { edit: false }).buildTools()).map(x => x.name), ['notes_status', 'notes_search', 'notes_read', 'table_read']);
    assert.deepEqual((await toolsFor(transport).buildTools()).map(x => x.name), Notes.NOTES_TOOL_NAMES);
    assert.match(await toolsFor(transport, { edit: false }).TOOLS.notes_write.run({ note: 'x', content: 'y' }), /Editing notes and tables is off/);
    assert.match(await toolsFor(transport).TOOLS.notes_status.run(), /MEGA folder \/Obsidian: 3 notes and 2 tables/);

    // A vault in MEGA also needs MEGA's own saving switch.
    await connect.handle({ op: 'settings', allowWrite: false });
    await assert.rejects(toolsFor(transport).TOOLS.notes_write.run({ note: 'New', content: 'x' }), /Saving to MEGA is off/);
});

test('a vault in the project folder, and a MEGA vault folder made on the first save', async t => {
    const files = { 'notes/Plan.md': '# Plan\nShip it', 'notes/data/a.csv': 'x,y\n1,2\n', 'src/app.js': '' };
    const writes = [];
    const tools = Notes.createNotesTables({
        getStore: async () => Notes.projectStore({ files: async () => files, read: async p => files[p] ?? null, write: async (p, text) => { writes.push(p); files[p] = text; } }, 'notes'),
        canEdit: () => true, confirmWrite: async () => true
    });
    assert.match(await tools.TOOLS.notes_search.run({}), /^Plan\.md$/m);
    assert.doesNotMatch(await tools.TOOLS.notes_search.run({}), /app\.js/);
    assert.match(await tools.TOOLS.notes_write.run({ note: 'Plan', mode: 'append', content: '- tests' }), /Saved Plan\.md in the project folder notes\//);
    assert.deepEqual(writes, ['notes/Plan.md']);
    assert.match(await tools.TOOLS.table_read.run({ table: 'data/a.csv' }), /1 rows, columns x, y/);

    const mega = fakeMega();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-notes-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const connect = createMegaConnect({ sessionFile: path.join(dir, 'm.json'), Storage: mega.Storage });
    await connect.handle({ op: 'signin', email: 'a@b.c', password: 'right-pass', allowWrite: true });
    const fresh = toolsFor(Mega.backendTransport(req => connect.handle(req)));
    assert.match(await fresh.TOOLS.notes_search.run({}), /has no notes yet/);
    assert.match(await fresh.TOOLS.notes_write.run({ note: 'Inbox/First', content: 'hello' }), /Created Inbox\/First\.md/);
    const vault = mega.drive.nodes.find(n => n.name === 'Obsidian');
    assert.ok(vault && vault.folder, 'the vault folder was made');
});

test('every notes and tables tool is documented', () => {
    const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'notes-and-tables.md'), 'utf8');
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const tools = Notes.createNotesTables({ getStore: async () => ({ error: 'x' }) });
    assert.deepEqual(Object.keys(tools.TOOLS), Notes.NOTES_TOOL_NAMES);
    for (const name of Notes.NOTES_TOOL_NAMES) {
        assert.ok(docs.includes(`\`${name}\``), `docs/notes-and-tables.md documents ${name}`);
        assert.ok(tools.describe(name, {}), `${name} has a step label`);
    }
    assert.match(readme, /docs\/notes-and-tables\.md/);
});

// The real page: the vault in MEGA through server.js's /mega route, and table_read
// running on the page's own query engine (media-tools.js).
test('in CoDev, an agent reads a note, totals a table and edits a note with the user\'s approval', async t => {
    const launched = await launchBrowser();
    if (launched.skip) return t.skip(launched.skip);
    t.after(() => launched.browser.close());
    const { mega, connect } = await megaVault(t);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-notes-page-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const backend = createMockBackend({ workspace, mega: req => connect.handle(req) });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: [
        [{ name: 'notes_read', arguments: { note: 'Game ideas' } }],
        [{ name: 'table_read', arguments: { table: 'Data/players.csv', action: 'stats', columns: ['Points'] } }],
        [{ name: 'notes_write', arguments: { note: 'Game ideas', mode: 'append', under_heading: 'Levels', content: '- Rooftops' } }],
        'Done: added Rooftops to your game ideas.'
    ] });
    await page.evaluate(() => { localStorage.setItem('codev_vault_allow_edit', '1'); });
    await page.uncheck('#isSandboxCheckbox');
    const dialogs = await answerApprovals(page, () => true);
    await sendPrompt(page, 'Add rooftops to the levels in my game ideas note.');
    await waitForChat(page, /Done: added Rooftops/);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(Notes.NOTES_TOOL_NAMES.every(name => calls[0].tools.includes(name)));
    assert.match(calls[1].messages.at(-1).content, /Links to: \[\[Continuum\]\]/);
    assert.match(calls[2].messages.at(-1).content, /Points: count 3, sum 84/);
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /Add to Projects\/Game ideas\.md under "Levels"/);
    assert.match(textOf(mega, 'Game ideas.md'), /- Docks #todo\n- Rooftops/);
    const steps = await page.evaluate(() => [...document.querySelectorAll('.msg-steps li')].map(li => li.textContent));
    assert.ok(steps.some(s => /📝 Reading the note Game ideas/.test(s)));
    await page.evaluate(() => { document.getElementById('settingsModal').style.display = 'flex'; document.getElementById('notesSettings').open = true; });
    await page.waitForFunction(() => /3 notes and 2 tables/.test(document.querySelector('#notesSettings [data-n="status"]').textContent));
    assert.deepEqual(errors, []);
});
