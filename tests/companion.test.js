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
    assert.equal(C.current(), 'gears');
    C.notify('script.run');
    assert.equal(C.current(), 'coding-frenzy', 'active work (50) beats processing (40)');
    C.notify('search.start');
    assert.equal(C.current(), 'deep-search', 'same priority: the newer one');
    C.notify('network.loading');
    assert.equal(C.current(), 'network-spin');
    C.notify('build.error');
    assert.equal(C.current(), 'compile-error');
    C.notify('network.done');
    C.notify('build.clear');
    assert.equal(C.current(), 'deep-search');
    C.notify('search.end');
    assert.equal(C.current(), 'coding-frenzy');
});

test('start and end events are counted per source', t => {
    const { C } = load(t);
    C.notify('search.start');
    C.notify('search.start');
    C.notify('search.end');
    assert.equal(C.current(), 'deep-search', 'one search is still running');
    C.notify('search.end');
    assert.equal(C.current(), null);
});

test('one-shot animations end on their own and a passing build ends the panic', t => {
    const { C, tick } = load(t);
    C.notify('inference.sip');
    assert.equal(C.current(), 'quick-sip');
    tick(1800);
    assert.equal(C.current(), null);
    C.notify('build.error');
    C.notify('build.success');
    assert.equal(C.current(), 'build-success');
    tick(2500);
    assert.equal(C.current(), null);
    C.notify('build.error');
    tick(6000);
    assert.equal(C.current(), null);
});

test('a looping source whose end never comes is dropped after 10 minutes', t => {
    const { C, tick } = load(t);
    C.notify('log.stream');
    tick(10 * 60 * 1000 - 1);
    assert.equal(C.current(), 'data-analyzer');
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
    const idle = C.animations.filter(a => a.category === 'idle').map(a => a.key);
    assert.ok(idle.includes(C.current()), `an idle animation plays (${C.current()})`);
    C.notify('script.run');
    assert.equal(C.current(), 'coding-frenzy');
    tick(5 * 60 * 1000);
    assert.equal(C.current(), 'coding-frenzy', 'no idle loop while work runs');
});

test('manual play overrides everything, and idle comes back after it', t => {
    const { C, tick } = load(t);
    C.notify('build.error');
    C.play(20);
    assert.equal(C.current(), 'superhero-flex');
    tick(2000);
    assert.equal(C.current(), null);
    tick(120000);
    assert.ok(C.current(), 'idle loops resume after a manual play');
    C.play(4, null);
    tick(60 * 60 * 1000);
    assert.equal(C.current(), 'data-analyzer', 'null loops until stop()');
    C.stop();
    assert.equal(C.current(), null);
    let seen;
    const off = C.subscribe(a => { seen = a && a.key; });
    C.notify('design.start');
    assert.equal(seen, 'blueprint-draft');
    off();
    C.notify('weigh.start');
    assert.equal(seen, 'blueprint-draft', 'unsubscribed');
});

test('unknown events are refused', t => {
    const { C } = load(t);
    assert.equal(C.notify('nope'), false);
    assert.equal(C.events.length, 22);
    assert.equal(C.animations.length, 20);
});

test('tool names map to the right animation', t => {
    const { B } = load(t);
    const cases = {
        run_command: 'script', 'codev-sandbox__write_file': 'script', edit_workspace_file: 'script',
        web_search: 'search', read_webpage: 'search', search_past_chats: 'search', find_symbol: 'search',
        read_file: 'log', query_table: 'log', read_attachment: 'log', browser_get_text: 'log',
        browser_navigate: 'network', outlier_research_list: 'weigh', odds_track: 'weigh',
        generate_image: 'design', studio_save: 'design', godot_check: 'check', save_memory: null
    };
    for (const [name, kind] of Object.entries(cases)) assert.equal(B.classifyTool(name), kind, name);
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
    assert.equal(C.current(), 'coding-frenzy');
    release('Exit code: 1\n--- stderr ---\n1 failing');
    await running;
    assert.equal(C.current(), 'compile-error');
    await assert.rejects(B.tool('web_search', {}, () => Promise.reject(new Error('down'))), /down/);
    assert.equal(C.current(), 'compile-error', 'a failed search clears itself and adds nothing');
});

test('a model call shows gears, then waiting when slow, then a sip', async t => {
    const { C, B, tick } = load(t);
    let release;
    const call = B.inference(() => new Promise(r => { release = r; }));
    assert.equal(C.current(), 'gears');
    tick(8000);
    assert.equal(C.current(), 'waiting');
    release({ content: 'hi' });
    assert.deepEqual(await call, { content: 'hi' });
    assert.equal(C.current(), 'quick-sip');
    tick(1800);
    assert.equal(C.current(), null);
    await assert.rejects(B.inference(() => { throw new Error('no key'); }), /no key/);
    assert.equal(C.current(), null, 'a failed call leaves nothing behind');
});

test('15 quiet minutes put it to sleep, and the next event wakes it', async t => {
    const { C, B, tick } = load(t);
    B.notify('log.stream');
    B.notify('log.end');
    tick(15 * 60 * 1000);
    assert.equal(C.current(), 'timeout-sleep');
    B.notify('search.start');
    assert.equal(C.current(), 'deep-search');
    B.notify('search.end');
    assert.equal(C.current(), null, 'awake, not back to sleep');
});

test('there are several avatars to pick from, and an unknown pick falls back to the first', t => {
    const { B } = load(t);
    assert.deepEqual([...B.avatars].map(a => a.id), ['duo', 'bear-wink', 'bear-smile', 'robot']);
    assert.equal(B.setAvatar('bear-smile'), 'bear-smile');
    assert.equal(B.setAvatar('nope'), 'duo');
    for (const file of ['avatars/bear-wink.png', 'avatars/bear-smile.png', 'avatar.svg']) {
        assert.ok(fs.existsSync(path.join(DIR, file)), file);
    }
});
