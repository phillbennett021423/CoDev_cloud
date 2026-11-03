// The companion avatar's state machine (mobile/www/companion/companion.js) and the
// bridge that turns CoDev's model and tool calls into its events (companion-bridge.js).
// Runs both files in a bare VM context with fake timers; no browser needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', 'mobile', 'www', 'companion');

function load(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const ctx = { console: { warn() {}, error() {} }, setTimeout, clearTimeout, Date, Promise, Math, Map };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const file of ['companion.js', 'companion-bridge.js']) {
        vm.runInContext(fs.readFileSync(path.join(DIR, file), 'utf8'), ctx, { filename: file });
    }
    return { C: ctx.VortexCompanion, B: ctx.CodevCompanion, tick: ms => t.mock.timers.tick(ms) };
}

test('the highest priority source wins, and the most recent wins a tie', t => {
    const { C } = load(t);
    assert.equal(C.current(), null);
    C.notify('inference.start');
    assert.equal(C.current(), 'head-tilt');
    C.notify('script.run');
    assert.equal(C.current(), 'typing', 'active work (50) beats thinking (40)');
    C.notify('search.start');
    assert.equal(C.current(), 'magnify', 'same priority: the newer one');
    C.notify('network.loading');
    assert.equal(C.current(), 'wrench');
    C.notify('build.error');
    assert.equal(C.current(), 'peekaboo');
    C.notify('network.done');
    C.notify('build.clear');
    assert.equal(C.current(), 'magnify');
    C.notify('search.end');
    assert.equal(C.current(), 'typing');
});

test('start and end events are counted per source', t => {
    const { C } = load(t);
    C.notify('search.start');
    C.notify('search.start');
    C.notify('search.end');
    assert.equal(C.current(), 'magnify', 'one search is still running');
    C.notify('search.end');
    assert.equal(C.current(), null);
});

test('one-shot animations end on their own and a passing build ends the panic', t => {
    const { C, tick } = load(t);
    C.notify('inference.sip');
    assert.equal(C.current(), 'drink-sip');
    tick(2800);
    assert.equal(C.current(), null);
    C.notify('build.error');
    C.notify('build.success');
    assert.equal(C.current(), 'happy-bounce');
    tick(2600);
    assert.equal(C.current(), null);
    C.notify('build.error');
    tick(5000);
    assert.equal(C.current(), null);
});

test('each milestone has its own celebration, and they end the error panic', t => {
    const { C, tick } = load(t);
    const cases = { 'task.done': 'tada', 'changes.submitted': 'confetti', 'merge.done': 'victory-spin', 'reply.done': 'groove', 'alert.ping': 'surprise-jump', hello: 'cheer-wave' };
    for (const [event, key] of Object.entries(cases)) {
        C.stop();
        C.notify(event);
        assert.equal(C.current(), key, event);
        tick(6000);
        assert.equal(C.current(), null, `${event} ends on its own`);
    }
    C.notify('build.error');
    C.notify('task.done');
    assert.equal(C.current(), 'tada');
    tick(3200);
    assert.equal(C.current(), null, 'the panic was cleared, not just covered');
});

test('a looping source whose end never comes is dropped after 10 minutes', t => {
    const { C, tick } = load(t);
    C.notify('log.stream');
    tick(10 * 60 * 1000 - 1);
    assert.equal(C.current(), 'tap-peek');
    tick(1);
    assert.equal(C.current(), null);
});

test('idle loops start after 2 quiet minutes and stop when work starts', t => {
    const { C, tick } = load(t);
    C.notify('inference.start');
    C.notify('inference.end');
    tick(119999);
    assert.equal(C.current(), null);
    tick(1);
    const idle = C.animations.filter(a => a.idle).map(a => a.key);
    assert.deepEqual([...idle], ['groove', 'butterfly-chase', 'yawn-stretch', 'headphone-jam', 'cheer-wave']);
    assert.ok(idle.includes(C.current()), `an idle animation plays (${C.current()})`);
    C.notify('script.run');
    assert.equal(C.current(), 'typing');
    tick(5 * 60 * 1000);
    assert.equal(C.current(), 'typing', 'no idle loop while work runs');
});

test('manual play overrides everything, and idle comes back after it', t => {
    const { C, tick } = load(t);
    C.notify('build.error');
    C.play(20);
    assert.equal(C.current(), 'cheer-wave');
    tick(2800);
    assert.equal(C.current(), null);
    tick(120000);
    assert.ok(C.current(), 'idle loops resume after a manual play');
    C.play(11, null);
    tick(60 * 60 * 1000);
    assert.equal(C.current(), 'typing', 'null loops until stop()');
    C.stop();
    assert.equal(C.current(), null);
    let seen;
    const off = C.subscribe(a => { seen = a && a.key; });
    C.notify('design.start');
    assert.equal(seen, 'heavy-lift');
    off();
    C.notify('edit.start');
    assert.equal(seen, 'heavy-lift', 'unsubscribed');
});

test('unknown events are refused, and the 20 actions come in four groups', t => {
    const { C } = load(t);
    assert.equal(C.notify('nope'), false);
    assert.equal(C.events.length, 30);
    assert.equal(C.animations.length, 20);
    const groups = {};
    for (const a of C.animations) groups[a.category] = (groups[a.category] || 0) + 1;
    assert.deepEqual(groups, { celebrate: 5, curious: 5, work: 5, idle: 5 });
});

test('the 3D robot has a move for every action', t => {
    const src = fs.readFileSync(path.join(DIR, 'robot3d.js'), 'utf8');
    const { C } = load(t);
    for (const a of C.animations) assert.ok(new RegExp(`(^|\\n)\\s*'?${a.key}'?: \\{`).test(src), `robot3d.js acts out ${a.key}`);
});

test('tool names map to the right animation', t => {
    const { B } = load(t);
    const cases = {
        run_command: 'script', 'codev-sandbox__write_file': 'edit', edit_workspace_file: 'edit',
        web_search: 'search', read_webpage: 'search', search_past_chats: 'search', find_symbol: 'search',
        read_file: 'log', query_table: 'log', read_attachment: 'log', browser_get_text: 'log',
        browser_navigate: 'network', outlier_research_list: 'weigh', odds_track: 'weigh',
        generate_image: 'design', studio_save: 'design', godot_check: 'check', save_memory: null
    };
    for (const [name, kind] of Object.entries(cases)) assert.equal(B.classifyTool(name), kind, name);
});

test('submitting changes and merging are celebrated, failures are not', t => {
    const { B } = load(t);
    assert.equal(B.milestone('submit_changes', {}, 'Submitted 3 changed files for review.'), 'changes.submitted');
    assert.equal(B.milestone('submit_changes', {}, 'Error: nothing to submit'), null);
    assert.equal(B.milestone('github__merge_pull_request', {}, 'Merged #12'), 'merge.done');
    assert.equal(B.milestone('run_command', { command: 'git merge feature' }, 'Exit code: 0\nFast-forward'), 'merge.done');
    assert.equal(B.milestone('run_command', { command: 'git merge feature' }, 'Exit code: 1\nCONFLICT (content)'), null);
    assert.equal(B.milestone('run_command', { command: 'npm test' }, 'Exit code: 0'), null);
    assert.equal(B.milestone('read_file', {}, 'merge'), null);
});

test('a finished task gets the Tada pose; plain replies groove at most every 2 minutes', t => {
    const { C, B, tick } = load(t);
    assert.equal(B.finished(true), 'task.done');
    assert.equal(C.current(), 'tada');
    tick(130000);
    assert.equal(B.finished(false), 'reply.done');
    assert.equal(C.current(), 'groove');
    assert.equal(B.finished(false), null, 'not again right away');
    tick(120000);
    assert.equal(B.finished(false), 'reply.done');
});

test('build and test commands report success or failure from their exit code', t => {
    const { B } = load(t);
    assert.equal(B.buildOutcome('run_command', { command: 'npm test' }, 'Exit code: 0\n--- stdout ---\nok'), 'build.success');
    assert.equal(B.buildOutcome('run_command', { command: 'npm run build' }, 'Exit code: 2\n--- stderr ---\nerror TS2304'), 'build.error');
    assert.equal(B.buildOutcome('run_command', { command: './gradlew assembleDebug' }, 'Exit code: 0 (timed out)'), 'build.error');
    assert.equal(B.buildOutcome('run_command', { command: 'ls -la' }, 'Exit code: 1'), null, 'not a build');
    assert.equal(B.buildOutcome('run_command', { command: 'npm test' }, 'The user declined to run this command.'), null);
    assert.equal(B.buildOutcome('godot_check', {}, 'No errors found.'), 'build.success');
    assert.equal(B.buildOutcome('godot_check', {}, 'res://main.gd:12 Parse error: unexpected token'), 'build.error');
    assert.equal(B.buildOutcome('read_file', {}, 'Exit code: 1'), null);
});

test('a tool call plays its animation while it runs, then the build result', async t => {
    const { C, B } = load(t);
    let release;
    const running = B.tool('run_command', { command: 'npm test' }, () => new Promise(r => { release = r; }));
    assert.equal(C.current(), 'typing');
    release('Exit code: 1\n--- stderr ---\n1 failing');
    await running;
    assert.equal(C.current(), 'peekaboo');
    await assert.rejects(B.tool('web_search', {}, () => Promise.reject(new Error('down'))), /down/);
    assert.equal(C.current(), 'peekaboo', 'a failed search clears itself and adds nothing');
    await B.tool('submit_changes', {}, () => Promise.resolve('Submitted for review.'));
    assert.equal(C.current(), 'confetti', 'submitting changes ends the panic with confetti');
});

test('a model call tilts its head, then tightens the connection when slow, then a sip', async t => {
    const { C, B, tick } = load(t);
    let release;
    const call = B.inference(() => new Promise(r => { release = r; }));
    assert.equal(C.current(), 'head-tilt');
    tick(8000);
    assert.equal(C.current(), 'wrench');
    release({ content: 'hi' });
    assert.deepEqual(await call, { content: 'hi' });
    assert.equal(C.current(), 'drink-sip');
    tick(2800);
    assert.equal(C.current(), null);
    await assert.rejects(B.inference(() => { throw new Error('no key'); }), /no key/);
    assert.equal(C.current(), null, 'a failed call leaves nothing behind');
});

test('15 quiet minutes put it to sleep, and the next event wakes it with a stretch', async t => {
    const { C, B, tick } = load(t);
    B.notify('log.stream');
    B.notify('log.end');
    tick(15 * 60 * 1000);
    assert.equal(C.current(), 'power-nap');
    B.notify('search.start');
    assert.equal(C.current(), 'magnify');
    B.notify('search.end');
    assert.equal(C.current(), 'yawn-stretch', 'waking up stretches');
    tick(2800);
    assert.equal(C.current(), null, 'awake, not back to sleep');
});

test('there are several avatars to pick from, the 3D robot first, and an unknown pick falls back to it', t => {
    const { B } = load(t);
    assert.deepEqual([...B.avatars].map(a => a.id), ['codev-bot', 'duo', 'bear-wink', 'bear-smile', 'robot']);
    assert.equal(B.avatar(), 'codev-bot');
    assert.equal(B.setAvatar('bear-smile'), 'bear-smile');
    assert.equal(B.setAvatar('nope'), 'codev-bot');
    for (const file of ['avatars/bear-wink.png', 'avatars/bear-smile.png', 'avatar.svg', 'robot3d.js', '../vendor/three/three.module.min.js']) {
        assert.ok(fs.existsSync(path.join(DIR, file)), file);
    }
});
