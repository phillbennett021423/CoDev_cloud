// The coding loop in the real page: a checkpoint before the task, only the fitting
// templates and the project's decisions in the coder's prompt, then the engine gate and
// an independent QA agent that starts from a clean context and loops until Godot is
// happy, the run log, and ↩ rolling the task back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockBackend } = require('./fixtures/mock-agent-backend');
const { launchBrowser, openPage, sendPrompt, waitForChat, answerApprovals } = require('./helpers/page-driver');

let launched;
test.before(async () => { launched = await launchBrowser(); });
test.after(async () => { if (launched && launched.browser) await launched.browser.close(); });

test('a Godot coding task: checkpoint, fitting templates, engine gate, clean-context QA until it passes, run log, rollback', async t => {
    if (launched.skip) return t.skip(launched.skip);
    let validations = 0;
    const backend = createMockBackend({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'codev-qa-')), agentTools: {
        checkpoint_create: () => 'Checkpoint abc1234567 saved ("Before", 4 files). checkpoint_restore with this id rolls back to it.',
        checkpoint_restore: (box, args) => `Rolled back to checkpoint ${args.id}. To undo the rollback, restore checkpoint def7654321.`,
        // Godot rejects the coder's script once; after the QA round it loads.
        godot_validate: () => (++validations === 1
            ? '1 problem(s) found.\nGodot: /usr/bin/godot\n✗ res://scripts/player.gd\n  SCRIPT ERROR: Parse Error: Identifier "gravity" not declared in the current scope.\n  at: res://scripts/player.gd:4'
            : 'No errors.\n✓ res://scripts/player.gd')
    } });
    const url = await backend.listen();
    t.after(() => backend.close());
    const { page, errors } = await openPage(launched.browser, url, {
        selfHeal: true,
        steps: [
            'Noted: teal.',
            [{ name: 'write_workspace_file', arguments: { name: 'scripts/player.gd', content: 'extends CharacterBody3D\n\nfunc _physics_process(delta):\n\tvelocity.y -= gravity * delta\n' } }],
            'Fixed the jump.',
            [{ name: 'edit_workspace_file', arguments: { name: 'scripts/player.gd', old_text: 'extends CharacterBody3D\n', new_text: 'extends CharacterBody3D\n\nvar gravity: float = ProjectSettings.get_setting("physics/3d/default_gravity")\n' } }],
            'Declared gravity; the script loads now.'
        ]
    });
    await answerApprovals(page);
    await page.uncheck('#isSandboxCheckbox');
    await page.evaluate(() => {
        loadedProjectFiles = {
            'project.godot': 'config_version=5\n[application]\nconfig/features=PackedStringArray("4.3")\n',
            'scripts/player.gd': 'extends CharacterBody3D\n',
            'codev/snippets/player_controller.gd': '# tags: player, jump, movement\nextends CharacterBody3D\nconst JUMP_VELOCITY := 4.5\n',
            'codev/snippets/inventory.cs': '// tags: inventory\npublic partial class Inventory : Node {}\n',
            'codev/snippets/toon.gdshader': '// tags: shader, toon\nshader_type spatial;\n',
            'codev/decisions.md': '# Architecture decisions\n\n## 2026-10-20: Movement constants live on the player\n**Decision:** Speeds and jump velocity are consts at the top of player.gd.\n'
        };
    });
    await sendPrompt(page, 'My favorite color is teal');
    await waitForChat(page, /Noted: teal\./);
    await sendPrompt(page, 'Fix the jump in scripts/player.gd');
    await waitForChat(page, /Engine checks passed/, 60000);

    // ↩ A checkpoint was taken before the coder ran.
    assert.equal(backend.log[0].tool, 'checkpoint_create');
    assert.match(backend.log[0].args.label, /^Before: Fix the jump/);
    assert.equal(await page.isVisible('#undoTaskBtn'), true);

    const calls = await page.evaluate(() => window.__modelCalls);
    const coder = calls.find(c => c.messages.some(m => m.role === 'user' && /^Fix the jump/.test(m.content)));
    // Only the template that fits, and the project's decision.
    assert.match(coder.system, /\[Project snippets\][\s\S]*player_controller\.gd[\s\S]*JUMP_VELOCITY/);
    assert.doesNotMatch(coder.system, /public partial class Inventory|tags: shader, toon/);
    assert.match(coder.system, /\[Project decisions\][\s\S]*Movement constants live on the player/);
    const reply = await page.evaluate(() => chatSessions.find(s => s.id === activeChatId).messages.find(m => m.text === 'Fixed the jump.'));
    assert.ok(reply.toolLog.some(line => /^📚 Templates: player_controller\.gd \(tag player, tag jump, gdscript\)/.test(line)), reply.toolLog.join('\n'));

    // The QA agent: a clean context (no earlier chat, no "teal"), the engine failure first.
    const qa = calls.filter(c => /^Review and repair the changes just made/.test(c.messages[0].content));
    assert.ok(qa.length >= 1);
    assert.equal(qa[0].messages[0].role, 'user');
    assert.ok(!qa[0].messages.some(m => /teal/.test(m.content)), 'the reviewer never sees the chat');
    assert.doesNotMatch(qa[0].system, /teal/);
    assert.match(qa[0].messages[0].content, /\[Engine checks CoDev ran\] FAILED: fix these first[\s\S]*Identifier "gravity" not declared/);
    assert.match(qa[0].messages[0].content, /\[What the coder says it did \(claims to verify, not facts\)\]\n.*Fixed the jump\./);
    assert.match(qa[0].system, /ROLE: QA ENGINEER, the independent reviewer/);
    assert.equal(validations, 2, 'Godot ran again after the QA round');
    assert.deepEqual(backend.log.filter(e => e.tool === 'godot_validate').map(e => e.args.files), [['scripts/player.gd'], ['scripts/player.gd']]);

    // The run log keeps the failure and the fix for later tasks.
    const runlog = await page.evaluate(() => loadedProjectFiles['codev/runlog.md']);
    assert.match(runlog, /## \d{4}-\d{2}-\d{2}: Fix the jump in scripts\/player\.gd\n\*\*Files:\*\* scripts\/player\.gd\n\*\*Failed:\*\* .*Identifier "gravity" not declared[\s\S]*\*\*Fixed by:\*\* Declared gravity[\s\S]*\*\*Outcome:\*\* engine checks pass after QA fixes/);
    const lessons = await page.evaluate(() => projectBrainContext('Add a double jump to scripts/player.gd', ['scripts/player.gd']));
    assert.match(lessons, /\[Lessons from earlier runs\][\s\S]*gravity/);

    // ↩ rolls the task back, after the user says yes.
    await page.click('#undoTaskBtn');
    await waitForChat(page, /Rolled back to checkpoint abc1234567/);
    assert.deepEqual(backend.log.find(e => e.tool === 'checkpoint_restore').args, { id: 'abc1234567' });
    assert.equal(await page.isVisible('#undoTaskBtn'), false);
    assert.deepEqual(errors, []);
});

test('documentsOnly: a change to prose alone skips the QA pass; any code in it keeps the pass', () => {
    const { documentsOnly } = require('../mobile/www/agent-ui/qa-loop.js');
    assert.equal(documentsOnly(['continuum_universe_bible.md']), true);
    assert.equal(documentsOnly(['lore\\notes.txt', 'docs/README.markdown']), true);
    assert.equal(documentsOnly(['bible.md', 'player.gd']), false);
    assert.equal(documentsOnly(['package.json']), false);
    assert.equal(documentsOnly([]), false);
});
