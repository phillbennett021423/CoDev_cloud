// The page's sandbox dispatch and diff review, end to end in headless Chromium
// against tests/fixtures/mock-agent-backend.js (no Docker needed). Skips when
// Playwright or Chromium is missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForReview, waitForChat } = require('./helpers/page-driver');

const CODING_STEPS = [
    [{ name: 'list_files' }, { name: 'read_file', arguments: { path: 'README.md' } }],
    [
        { name: 'write_file', arguments: { path: 'src/greet.js', content: 'function greet(name) {\n  return `Hello, ${name}!`;\n}\nmodule.exports = { greet };\n' } },
        { name: 'write_file', arguments: { path: 'src/broken.js', content: 'function broken( {\n  return 1;\n}\n' } },
        { name: 'edit_file', arguments: { path: 'README.md', old_text: '# Demo', new_text: '# Demo\n\nNow with greetings.' } }
    ],
    [{ name: 'submit_changes', arguments: { summary: 'Added greet() and documented it.' } }],
    'Added src/greet.js and updated the README.'
];

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

function makeWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-ui-'));
    fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
    return dir;
}

test('a prompt runs in the sandbox and only approved, passing files reach disk', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: CODING_STEPS });

    await sendPrompt(page, 'Add a greet(name) helper in src/greet.js and mention it in the README');
    const rows = await waitForReview(page);

    // The agent's tools came from the sandbox, with direct-disk tools hidden.
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(calls[0].tools.includes('write_file'), 'sandbox write_file offered');
    assert.ok(!calls[0].tools.includes('write_workspace_file'), 'direct-disk write tool hidden');
    assert.match(calls[0].system, /\[Sandbox\]/);
    // Every tool call carried the agent and its sandbox.
    assert.ok(backend.log.length >= 5);
    assert.ok(backend.log.every(entry => entry.agentId && entry.workspace), 'tool calls carry codev/agent and codev/workspace');

    // Nothing is on disk before approval.
    assert.equal(fs.existsSync(path.join(workspace, 'src', 'greet.js')), false);
    assert.equal(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), '# Demo\n');

    const byPath = Object.fromEntries(rows.map(r => [r.path, r]));
    assert.deepEqual(Object.keys(byPath).sort(), ['README.md', 'src/broken.js', 'src/greet.js']);
    assert.equal(byPath['src/broken.js'].blocked, true, 'syntax error blocks the file');
    assert.equal(byPath['src/broken.js'].disabled, true);
    assert.equal(byPath['src/greet.js'].checked, true);
    assert.match(await page.textContent('#diffReviewOverlay'), /Added greet\(\) and documented it\./);
    assert.match(await page.textContent('#diffReviewOverlay .cdr-diff[data-path="src/greet.js"]'), /return `Hello, \$\{name\}!`;/);

    await page.click('#diffReviewOverlay [data-action="approve"]');
    await waitForChat(page, /Saved 2 files/);
    assert.equal(await page.$('#diffReviewOverlay'), null, 'review closed');

    assert.match(fs.readFileSync(path.join(workspace, 'src', 'greet.js'), 'utf8'), /function greet/);
    assert.match(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8'), /Now with greetings/);
    assert.equal(fs.existsSync(path.join(workspace, 'src', 'broken.js')), false, 'blocked file never written');
    assert.deepEqual(errors, []);
});

test('rejecting the review writes nothing', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, {
        steps: [[{ name: 'write_file', arguments: { path: 'notes.json', content: '{"ok": true}\n' } }], 'Wrote notes.json.']
    });
    await sendPrompt(page, 'Create notes.json');
    await waitForReview(page);
    await page.click('#diffReviewOverlay [data-action="reject"]');
    await waitForChat(page, /You rejected these changes/);
    assert.equal(fs.existsSync(path.join(workspace, 'notes.json')), false);
    assert.equal([...backend.changesets.values()][0].status, 'rejected');
});

test('a review kept for later is approvable from the header button', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, {
        steps: [[{ name: 'write_file', arguments: { path: 'later.js', content: 'module.exports = 42;\n' } }], 'Wrote later.js.']
    });
    await sendPrompt(page, 'Create later.js');
    await waitForReview(page);
    await page.click('#diffReviewOverlay [data-action="defer"]');
    await waitForChat(page, /kept for review later/);
    assert.equal(fs.existsSync(path.join(workspace, 'later.js')), false);

    await page.waitForSelector('#pendingChangesBtn', { state: 'visible' });
    assert.match(await page.textContent('#pendingChangesBtn'), /\(1\)/);
    await page.click('#pendingChangesBtn');
    await waitForReview(page);
    await page.click('#diffReviewOverlay [data-action="approve"]');
    await page.waitForSelector('#pendingChangesBtn', { state: 'hidden' });
    assert.equal(fs.readFileSync(path.join(workspace, 'later.js'), 'utf8'), 'module.exports = 42;\n');
});

test('with the sandbox off, the page keeps its direct tools', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, { steps: ['Nothing to change.'] });
    await page.uncheck('#isSandboxCheckbox');
    await sendPrompt(page, 'Say hello');
    await waitForChat(page, /Nothing to change\./);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(!calls[0].system.includes('[Sandbox]'));
    assert.equal(backend.log.length, 0, 'no sandbox tool calls');
    assert.equal(backend.sandboxes.size, 0, 'no sandbox created');
    // The page's own folder tools never take in or write files that can hold keys.
    const secret = await page.evaluate(async () => ({
        paths: ['.env', 'config/production.env', '.github/ci.yml', 'certs/server.key', 'secrets.json', 'credentials.yaml'].map(normalizeWorkspacePath),
        loaded: ['.env.js', 'secrets.json', 'app.js'].map(isProjectFileName),
        write: await writeWorkspaceFile('.env', 'KEY=x')
    }));
    assert.deepEqual(secret.paths, ['', '', '', '', '', '']);
    assert.deepEqual(secret.loaded, [false, false, true]);
    assert.match(secret.write, /Use a file path/);
});

test('a follow-up carries the earlier turns, including the tool steps that failed', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, {
        steps: [[{ name: 'read_workspace_file', arguments: { name: 'missing/notes.txt' } }], "I couldn't open missing/notes.txt.", 'It failed because that file is not there.']
    });
    await page.uncheck('#isSandboxCheckbox');
    await sendPrompt(page, 'Open missing/notes.txt and summarize it');
    await waitForChat(page, /couldn't open missing\/notes\.txt/);
    await sendPrompt(page, 'Why did that fail?');
    await waitForChat(page, /file is not there/);
    const calls = await page.evaluate(() => window.__modelCalls);
    const first = calls[0].messages;
    assert.equal(first.length, 1, 'the first prompt has no earlier turns');
    const last = calls[calls.length - 1].messages;
    assert.equal(last[0].role, 'user');
    assert.match(last[0].content, /Open missing\/notes\.txt/);
    assert.equal(last[1].role, 'assistant');
    assert.match(last[1].content, /couldn't open missing\/notes\.txt/);
    assert.match(last[1].content, /\[Tool steps in that turn\][\s\S]*notes\.txt/);
    assert.equal(last[2].role, 'user');
    assert.match(last[2].content, /^Why did that fail\?/);
    assert.ok(!last.some(m => /Welcome to CoDev/.test(m.content)), 'the welcome note stays out');
});

test('chats survive a reload, and a run cut off by a crash comes back as a note the next prompt carries', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, { steps: ['First answer.'] });
    await page.uncheck('#isSandboxCheckbox');
    await sendPrompt(page, 'Remember the number 42');
    await waitForChat(page, /First answer\./);
    // A run that was still going when CoDev closed, as the page leaves it mid-run.
    await page.evaluate(() => {
        const session = chatSessions.find(s => s.id === activeChatId);
        session.messages.push({ sender: '🤖 CodeDev (Working...)', text: '📄 Reading notes.txt', task: 'Summarize notes.txt', toolLog: ['📄 Reading notes.txt → No loaded text file named "notes.txt".'] });
        saveChatsNow();
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof chatSessions !== 'undefined' && document.getElementById('chatFeed').children.length > 0);
    const restored = await page.evaluate(() => chatSessions.find(s => s.id === activeChatId).messages.map(m => ({ sender: m.sender, text: m.text, toolLog: m.toolLog })));
    assert.ok(restored.some(m => m.sender === '👤 You' && /number 42/.test(m.text)), 'the prompt is back');
    assert.ok(restored.some(m => /First answer/.test(m.text)), 'the reply is back');
    const note = restored.find(m => /Interrupted \[CodeDev\]/.test(m.sender));
    assert.ok(note, 'the cut-off run is a note');
    assert.match(note.text, /Summarize notes\.txt/);
    assert.ok(!restored.some(m => /Working\.\.\./.test(m.sender)), 'no run left spinning');
    await page.evaluate(() => {
        document.getElementById('settingsModal').style.display = 'none';
        window.__modelCalls = [];
        window.groqChatMessage = async body => {
            window.__modelCalls.push(body.messages.slice(1).map(m => ({ role: m.role, content: String(m.content) })));
            return { role: 'assistant', content: 'Picking it up.' };
        };
    });
    await page.uncheck('#isSandboxCheckbox');
    await sendPrompt(page, 'continue');
    await waitForChat(page, /Picking it up\./);
    const sent = (await page.evaluate(() => window.__modelCalls))[0];
    const joined = sent.map(m => m.content).join('\n');
    assert.match(joined, /number 42/);
    assert.match(joined, /Summarize notes\.txt/);
    assert.match(joined, /No loaded text file named "notes\.txt"/);
});

test('a run cut off by a crash resumes from its last step, and agents and settings survive a reload', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url);
    await page.uncheck('#isSandboxCheckbox');
    // The first round calls a tool; the second never answers, as if CoDev died mid-run.
    await page.evaluate(() => {
        let calls = 0;
        window.groqChatMessage = async () => {
            if (++calls === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_workspace_file', arguments: JSON.stringify({ name: 'missing/notes.txt' }) } }] };
            return new Promise(() => {});
        };
        agents[0].memory = 'Likes short answers.';
        renderAgentList();
        document.getElementById('isSelfHealCheckbox').checked = false;
    });
    await sendPrompt(page, 'Summarize missing/notes.txt');
    await page.waitForFunction(() => Object.keys(localStorage).some(k => k.startsWith('codev_run_') && /No loaded text file/.test(localStorage.getItem(k))));
    await page.evaluate(() => saveChatsNow());
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.resume-btn');
    const after = await page.evaluate(() => ({ memory: agents[0].memory, selfHeal: document.getElementById('isSelfHealCheckbox').checked }));
    assert.equal(after.memory, 'Likes short answers.', 'agents come back with their memory');
    assert.equal(after.selfHeal, false, 'the toggles come back as they were left');
    await page.evaluate(() => {
        document.getElementById('settingsModal').style.display = 'none';
        window.__sent = [];
        window.groqChatMessage = async body => {
            window.__sent.push(body.messages.map(m => ({ role: m.role, content: String(m.content), tool_call_id: m.tool_call_id })));
            return { role: 'assistant', content: 'Resumed and finished.' };
        };
    });
    await page.uncheck('#isSandboxCheckbox');
    await page.click('.resume-btn');
    await waitForChat(page, /Resumed and finished\./);
    const sent = (await page.evaluate(() => window.__sent))[0];
    assert.match(sent[0].content, /\[MCP\]/, 'the notes are added again');
    assert.equal(sent[0].content.match(/\[MCP\]/g).length, 1, 'only once');
    assert.ok(sent.some(m => m.role === 'user' && /Summarize missing\/notes\.txt/.test(m.content)), 'the original prompt');
    assert.ok(sent.some(m => m.role === 'tool' && m.tool_call_id === 'call_a' && /No loaded text file/.test(m.content)), 'the tool result from before the crash');
    assert.match(sent[sent.length - 1].content, /\[CoDev restarted\]/);
    const left = await page.evaluate(() => ({
        checkpoints: Object.keys(localStorage).filter(k => k.startsWith('codev_run_')).length,
        notes: chatSessions.find(s => s.id === activeChatId).messages.filter(m => /Interrupted/.test(m.sender)).length
    }));
    assert.deepEqual(left, { checkpoints: 0, notes: 0 }, 'the checkpoint and the note go once the run ends');
});

test('saying "continue" after a crash resumes the cut-off run, and a call left mid-way gets a result', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url);
    await page.evaluate(() => {
        // As a crash leaves it: a run mid-way, its last call never answered.
        localStorage.setItem('codev_run_r1', JSON.stringify({ agentId: 'agent_1', task: 'Check the props', kind: 'research', toolLog: ['📈 Researching → started'], messages: [
            { role: 'system', content: 'BASE PROMPT' },
            { role: 'user', content: 'Check the props' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'outlier_research_list', arguments: '{}' } }] }
        ] }));
        const session = chatSessions.find(s => s.id === activeChatId);
        session.messages.push({ sender: '🤖 Architect (Working...)', text: '📈 Researching', task: 'Check the props', runId: 'r1' });
        saveChatsNow();
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.resume-btn');
    await page.evaluate(() => {
        document.getElementById('settingsModal').style.display = 'none';
        window.__sent = [];
        window.groqChatMessage = async body => {
            window.__sent.push(body.messages.map(m => ({ role: m.role, content: String(m.content), tool_call_id: m.tool_call_id })));
            return { role: 'assistant', content: 'Picked the research back up.' };
        };
    });
    await page.uncheck('#isSandboxCheckbox');
    await sendPrompt(page, 'continue');
    await waitForChat(page, /Picked the research back up\./);
    const sent = (await page.evaluate(() => window.__sent))[0];
    assert.match(sent[0].content, /^BASE PROMPT/);
    const result = sent.find(m => m.role === 'tool' && m.tool_call_id === 'call_x');
    assert.ok(result, 'the unanswered call gets a result');
    assert.match(result.content, /closed before this call finished/);
});

test('in sandbox mode, MCP servers that write or run on this computer are kept out of the review bypass', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const helperTool = (name, readOnly) => ({ name, qualifiedName: `helper__${name}`, server: 'helper', description: `helper ${name}`,
        inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: readOnly } });
    const backend = createMockBackend({ workspace, hubTools: [helperTool('write_file', false), helperTool('run_command', false), helperTool('lookup', true), helperTool('deploy', false)] });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page } = await openPage(launched.browser, url, {
        mcpServers: { helper: { url: 'http://127.0.0.1:8787/mcp', type: 'http' } },
        steps: [[{ name: 'helper__lookup' }], [{ name: 'helper__deploy' }], 'Done looking.']
    });
    // Turn "run without asking" on to show the sandbox asks anyway; decline the dialog.
    await page.evaluate(() => { toolsAutoRun = true; });
    const dialogs = [];
    page.on('dialog', dialog => { dialogs.push(dialog.message()); dialog.dismiss(); });
    await sendPrompt(page, 'Look something up');
    await waitForChat(page, /Done looking\./);
    const offered = (await page.evaluate(() => window.__modelCalls))[0].tools;
    assert.ok(offered.includes('helper__lookup') && offered.includes('helper__deploy'), offered.join(', '));
    assert.ok(!offered.includes('helper__write_file') && !offered.includes('helper__run_command'), 'host write/run tools hidden');
    assert.deepEqual(backend.hubCalls.map(c => c.name), ['lookup'], 'read-only tool ran; declined tool did not');
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0], /helper__deploy[\s\S]*outside the sandbox/);
});

test('agents start as a blank slate, and a new task clears what the old one left', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: ['Here is the 4-leg parlay breakdown.'] });
    page.on('dialog', dialog => dialog.accept());

    // Built-in and newly created agents: no memory, no shared links, nothing project-specific.
    const defaults = await page.evaluate(() => {
        createNewAgent();
        return agents.map(a => ({ memory: a.memory, sharedWith: a.sharedWith, cross: a.crossKnowledgeEnabled, devRole: a.devRole, text: `${a.role} ${a.instructions}` }));
    });
    assert.ok(defaults.every(a => a.memory === '' && !a.sharedWith.length && !a.cross), 'empty memory and no shared links');
    assert.ok(defaults.every(a => !/godot|game|narrative|universe/i.test(a.text)), 'no pre-seeded project');
    assert.equal(defaults.at(-1).devRole, 'general', 'a new agent is general-purpose');

    // An unrelated task's prompt carries no engine rules and no empty memory lines.
    await sendPrompt(page, 'Rank tonight\'s NBA player props for a 4-leg parlay');
    await waitForChat(page, /parlay breakdown/);
    const system = (await page.evaluate(() => window.__modelCalls))[0].system;
    assert.doesNotMatch(system, /move_and_slide|Vector2/);
    assert.doesNotMatch(system, /\[Memory\]:\s*$/m);

    // Memory written for one task is gone after "New task (clear context)".
    const after = await page.evaluate(() => {
        agents[0].memory = 'Continuum Universe lore bible';
        agents[0].crossKnowledgeEnabled = true;
        agents[0].sharedWith = [agents[1].id];
        const before = activeChatId;
        startFreshTask();
        return { memories: agents.map(a => a.memory), shared: agents[0].sharedWith, cross: agents[0].crossKnowledgeEnabled, newChat: activeChatId !== before,
            messages: chatSessions.find(s => s.id === activeChatId).messages.length };
    });
    assert.ok(after.memories.every(m => m === ''));
    assert.deepEqual(after.shared, []);
    assert.equal(after.cross, false);
    assert.ok(after.newChat, 'an empty chat opens');
    assert.equal(after.messages, 1);
    assert.deepEqual(errors, []);
});

test('scrolling up in the chat stops auto-scroll until you return to the bottom, and the live view wheel scrolls in page pixels', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: ['ok'] });

    const state = () => page.evaluate(() => {
        const feed = document.getElementById('chatFeed');
        return { top: Math.round(feed.scrollTop), bottom: chatAtBottom(feed), jump: !document.getElementById('chatJumpBtn').hidden };
    });
    const add = () => page.evaluate(() => {
        chatSessions.find(s => s.id === activeChatId).messages.push({ sender: 'Architect', text: 'More analysis\n'.repeat(4) });
        renderActiveChatFeed();
    });
    await page.evaluate(() => {
        const session = chatSessions.find(s => s.id === activeChatId);
        for (let i = 0; i < 40; i++) session.messages.push({ sender: i % 2 ? 'Architect' : 'You', text: `Message ${i}\n`.repeat(3) });
        renderActiveChatFeed();
    });
    assert.equal((await state()).bottom, true, 'starts at the latest message');

    // The user scrolls up: new messages no longer pull the feed down.
    await page.evaluate(() => { const feed = document.getElementById('chatFeed'); feed.scrollTop = 200; feed.dispatchEvent(new Event('scroll')); });
    await add();
    await page.waitForTimeout(200);   // let any pending scroll and resize callbacks run
    const now = await state();
    assert.equal(now.top, 200, 'stays where the user is reading');
    assert.equal(now.jump, true, 'offers a way back to the latest');

    // Back at the bottom (by the button or by scrolling): auto-scroll resumes.
    await page.click('#chatJumpBtn');
    await add();
    // Scroll events arrive a frame later; wait for the feed to settle at the bottom.
    await page.waitForFunction(() => chatAtBottom(document.getElementById('chatFeed')) && document.getElementById('chatJumpBtn').hidden, null, { timeout: 3000 });

    // Wheel turns: lines and pages become pixels, scaled to the page's size on screen.
    const deltas = await page.evaluate(() => {
        live.frame = { width: 1280, height: 800 };
        const img = document.createElement('img');
        img.style.cssText = 'position: fixed; left: 0; top: 0; width: 640px; height: 400px;';
        document.body.append(img);
        const out = [
            liveWheelDelta({ deltaMode: 0, deltaX: 0, deltaY: 100 }, img),
            liveWheelDelta({ deltaMode: 1, deltaX: 0, deltaY: 3 }, img),
            liveWheelDelta({ deltaMode: 0, deltaX: -50, deltaY: 99999 }, img)
        ];
        img.remove();
        live.frame = null;
        return out;
    });
    assert.deepEqual(deltas, [{ deltaX: 0, deltaY: 200 }, { deltaX: 0, deltaY: 96 }, { deltaX: -100, deltaY: 2000 }]);
    assert.deepEqual(errors, []);
});

test('an Outlier prompt goes straight to the Outlier scan, and says how to get it when this CoDev has none', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const backend = createMockBackend({ workspace: makeWorkspace(), agentTools: {
        outlier_scan_board: (box, args) => `Outlier > ${args.sport} > 8:00 PM BOS vs NYK\n4 props, 4 passed.`
    } });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, {
        steps: [[{ name: 'outlier_scan_board', arguments: { sport: 'NBA', game: '8pm' } }], 'Here is your 4-leg ticket.']
    });
    page.on('dialog', dialog => dialog.accept());
    await sendPrompt(page, 'Go to Outlier and build me a 4-leg NBA ticket for the 8pm game');
    await waitForChat(page, /Here is your 4-leg ticket\./);
    const calls = await page.evaluate(() => window.__modelCalls);
    assert.ok(calls[0].tools.includes('outlier_scan_board'), `tools offered: ${calls[0].tools.join(', ')}`);
    assert.match(calls[0].system, /call outlier_scan_board first/);
    assert.match(calls[0].system, /Don't search the project files for Outlier/);
    const scan = backend.log.find(entry => entry.tool === 'outlier_scan_board');
    assert.deepEqual(scan && scan.args, { sport: 'NBA', game: '8pm' });
    assert.ok(scan.agentId, 'the call carries the agent');
    assert.deepEqual(errors, []);

    // A CoDev without the Outlier pipeline (the Windows app, an old server).
    const plain = createMockBackend({ workspace: makeWorkspace() });
    const plainUrl = await plain.listen();
    t.after(() => plain.close());
    const other = await openPage(launched.browser, plainUrl, { steps: ['Start CoDev with start-codev.bat.'] });
    await sendPrompt(other.page, 'Make me a parlay using Outlier');
    await waitForChat(other.page, /start-codev\.bat/);
    const without = await other.page.evaluate(() => window.__modelCalls);
    assert.match(without[0].system, /The Outlier scan isn't available here\. .*start-codev\.bat/);
});

test('each request is sorted first: only code and file tasks carry the project, and a question never browses it', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const workspace = makeWorkspace();
    const backend = createMockBackend({ workspace });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, { steps: ['Paris.', 'Added it.'] });
    await page.uncheck('#isSandboxCheckbox');
    await page.evaluate(() => { loadedProjectFiles = { 'README.md': '# Demo\n', 'src/app.js': 'console.log(1);\n' }; });

    const kinds = await page.evaluate(() => [
        classifyRequest('What is the capital of France?'),
        classifyRequest('Look up player props for LeBron tonight'),
        classifyRequest('Read the screenshots in my folder'),
        classifyRequest('Fix the bug in src/app.js'),
        classifyRequest('now do the same for the other one', 'Fix the bug in src/app.js'),
        classifyRequest('Build me a 5 leg slip from these', '', true)
    ]);
    assert.deepEqual(kinds, ['general', 'props', 'images', 'code', 'code', 'props']);

    await sendPrompt(page, 'What is the capital of France?');
    await waitForChat(page, /Paris\./);
    await sendPrompt(page, 'Add a footer to src/app.js');
    await waitForChat(page, /Added it\./);
    const calls = await page.evaluate(() => window.__modelCalls);
    const question = calls[0].messages.at(-1).content;
    assert.doesNotMatch(question, /\[Workspace/, 'a question carries no project files');
    assert.match(calls[0].system, /You are CoDev, a multi-purpose agent/);
    assert.match(calls[0].system, /\[Request type\] A general question/);
    assert.doesNotMatch(calls[0].system, /AUTONOMOUS DEVELOPER MODE/);
    assert.ok(calls[0].tools.includes('read_screenshots'));
    const coding = calls[1].messages.at(-1).content;
    assert.match(coding, /\[Workspace File: src\/app\.js\]/, 'a code task carries the files');
    assert.match(calls[1].system, /AUTONOMOUS DEVELOPER MODE/);
    assert.deepEqual(errors, []);
});

test('read_screenshots reads the whole 📸 folder, counts a leg on two screenshots once, remembers what it read and hands the legs to the Outlier research', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const backend = createMockBackend({ workspace: makeWorkspace(), agentTools: {
        outlier_research_list: (box, args) => `Researched ${args.legs.length} legs.`
    } });
    const url = await backend.listen();
    t.after(() => backend.close());
    const legs = 'Prop legs found in the screenshots:\nLeBron James | Points | 25.5 | Over | NBA | vs BOS 7:30 PM';
    const research = [{ name: 'outlier_research_list', arguments: { sport: 'NBA', legs: [{ player: 'LeBron James', stat: 'Points', line: 25.5, side: 'over' }] } }];
    const { page, errors } = await openPage(launched.browser, url, { steps: [
        [{ name: 'read_screenshots', arguments: { question: 'research these' } }],
        `### IMG_2811.PNG\n${legs}\nJayson Tatum | Rebounds | 8.5 | Under | NBA |\n\n### IMG_2810.PNG\n${legs}\nEntry $10, pays 3x`,
        research,
        'LeBron Over 25.5 points checks out.',
        [{ name: 'read_screenshots', arguments: {} }],
        'Same legs as before.'
    ] });
    page.on('dialog', dialog => dialog.accept());
    // No screenshots picked yet: the tool says how to pick them.
    assert.match(await page.evaluate(() => readScreenshotsTool({})), /click 📸/);
    await page.evaluate(async () => {
        localStorage.removeItem(SCREENSHOT_NOTES_KEY);
        const canvas = document.createElement('canvas');
        canvas.width = 40; canvas.height = 80;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const file = (name, modified) => ({ path: name, file: new File([blob], name, { type: 'image/png', lastModified: modified }) });
        screenshotFolder = { name: 'New folder', files: [file('IMG_2810.PNG', 1), file('IMG_2811.PNG', 2), { path: 'notes.txt', file: new File(['x'], 'notes.txt') }].filter(f => isScreenshotName(f.path)) };
    });
    await sendPrompt(page, 'Look at my Dabble screenshots and research them');
    await waitForChat(page, /checks out/);
    let calls = await page.evaluate(() => window.__modelCalls);
    const vision = calls[1];
    assert.match(vision.system, /Prop legs found in the screenshots/);
    assert.equal((vision.messages[0].content.match(/data:image\/jpeg;base64/g) || []).length, 2, 'both screenshots went to the vision model in one batch');
    const toolResult = calls[2].messages.find(m => m.role === 'tool').content;
    assert.match(toolResult, /2 different leg\(s\) \(1 repeat\(s\)/);
    assert.match(toolResult, /LeBron James \| Points \| 25\.5 \| Over \| NBA \| vs BOS 7:30 PM \| IMG_2811\.PNG, IMG_2810\.PNG/);
    assert.match(toolResult, /Jayson Tatum \| Rebounds \| 8\.5 \| Under/);
    assert.match(toolResult, /Entry \$10, pays 3x/);
    assert.match(toolResult, /call outlier_research_list/);
    assert.ok(backend.log.some(entry => entry.tool === 'outlier_research_list'), 'the legs were researched');

    // Asked again with the same screenshots: nothing goes to the vision model.
    await sendPrompt(page, 'Read my screenshots again');
    await waitForChat(page, /Same legs as before\./);
    calls = await page.evaluate(() => window.__modelCalls);
    const again = calls.slice(4);
    assert.equal(again.length, 2, 'two agent turns and no second vision call');
    assert.ok(!again.some(c => /You read screenshots for CoDev/.test(c.system)), 'no second vision call');
    assert.match(again[1].messages.find(m => m.role === 'tool').content, /2 from earlier reads[\s\S]*LeBron James \| Points/);
    assert.deepEqual(errors, []);
});

test('📎 takes more than 3 screenshots: the vision model reads them 3 at a time and the agent gets every leg once', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const backend = createMockBackend({ workspace: makeWorkspace() });
    const url = await backend.listen();
    t.after(() => backend.close());
    const leg = 'Prop legs found in the screenshots:\nLeBron James | Points | 25.5 | Over | NBA |';
    const { page, errors } = await openPage(launched.browser, url, { steps: [
        `### Attached image 1\n${leg}\n### Attached image 2\n${leg}\n### Attached image 3\nJayson Tatum | Rebounds | 8.5 | Under | NBA |`,
        `### Attached image 4\n${leg}\n### Attached image 5\nNikola Jokic | Assists | 9.5 | Over | NBA |`,
        'Here is the slip.'
    ] });
    page.on('dialog', dialog => dialog.accept());
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('#attachmentInput', [1, 2, 3, 4, 5].map(n => ({ name: `IMG_28${n}.PNG`, mimeType: 'image/png', buffer: png })));
    await page.waitForFunction(() => pendingAttachments.length === 5 && pendingAttachments.every(a => !a.processing));
    await sendPrompt(page, 'Build me a slip from these Dabble props');
    await waitForChat(page, /Here is the slip\./);
    const calls = await page.evaluate(() => window.__modelCalls);
    const imagesIn = call => (call.messages.at(-1).content.match(/data:image\/jpeg;base64/g) || []).length;
    assert.deepEqual([imagesIn(calls[0]), imagesIn(calls[1])], [3, 2], 'two vision requests, 3 images at most each');
    const asked = calls[2].messages.at(-1).content;
    assert.match(asked, /3 different leg\(s\) \(2 repeat\(s\)/);
    assert.match(asked, /Nikola Jokic \| Assists \| 9\.5 \| Over/);
    assert.ok(calls[2].tools.length > 0, 'the agent still has its tools');
    assert.deepEqual(errors, []);
});

test('a folder named by its full path is read without a picker or an upload, and remembered for next time', async t => {
    if (launched.skip) return t.skip(launched.skip);
    const { handleImageFolder } = require('../desktop/image-folder');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'New folder '));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    for (let n = 0; n < 5; n++) fs.writeFileSync(path.join(dir, `IMG_281${n}.PNG`), png);
    const backend = createMockBackend({ workspace: makeWorkspace() });
    const url = await backend.listen();
    t.after(() => backend.close());
    const leg = n => `### IMG_281${n}.PNG\nProp legs found in the screenshots:\nLeBron James | Points | 25.5 | Over | NBA |`;
    const { page, errors } = await openPage(launched.browser, url, { steps: [
        [{ name: 'read_screenshots', arguments: { folder: dir } }],
        [4, 3, 2].map(leg).join('\n'), [1, 0].map(leg).join('\n'),
        'All five read.',
        [{ name: 'read_screenshots', arguments: {} }],
        'Read them again.'
    ] });
    page.on('dialog', dialog => dialog.accept());
    await page.exposeFunction('__imageFolder', req => handleImageFolder(req));
    await page.evaluate(() => { localStorage.removeItem(SCREENSHOT_NOTES_KEY); window.imageFolderRequest = req => window.__imageFolder(req); });
    await sendPrompt(page, `Look in ${dir} and research the props`);
    await waitForChat(page, /All five read\./);
    let calls = await page.evaluate(() => window.__modelCalls);
    const result = calls[3].messages.find(m => m.role === 'tool').content;
    assert.match(result, /Read 5 screenshot/);
    assert.match(result, /1 different leg\(s\) \(4 repeat\(s\)/);
    assert.equal(await page.evaluate(() => localStorage.getItem(SCREENSHOT_PATH_KEY)), dir, 'the folder is remembered');

    // Next time, "my screenshots" is enough, and nothing is read twice.
    await sendPrompt(page, 'Read my screenshots again');
    await waitForChat(page, /Read them again\./);
    calls = await page.evaluate(() => window.__modelCalls);
    assert.equal(calls.length, 6, 'no new vision requests');
    assert.match(calls[5].messages.find(m => m.role === 'tool' && /5 from earlier reads/.test(m.content)).content, /LeBron James/);
    assert.deepEqual(errors, []);
});
