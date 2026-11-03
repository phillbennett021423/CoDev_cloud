#!/usr/bin/env node
// End-to-end check of the CoDev Bridge in a real Godot editor: makes a small project,
// installs the bridge with godot_install_bridge, opens the editor, then drives it the way
// an agent does through godot_editor: engine docs, edits with undo and redo, a script and
// a signal, saving, and a playtest (keys and actions, values, the log and a frame).
//
//   node scripts/godot-bridge-e2e.js --godot /path/to/Godot_v4.x [--display]
//
// Run by .github/workflows/godot-bridge.yml under xvfb, so a game window can render.
// Exits 1 with the failing step when something doesn't work.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { createGameDevService } = require('../desktop/gamedev');

const argv = process.argv.slice(2);
const godot = argv[argv.indexOf('--godot') + 1];
if (!godot || !fs.existsSync(godot)) { console.error('Pass --godot <path to the Godot 4 executable>.'); process.exit(2); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-bridge-e2e-'));
const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
write('project.godot', `config_version=5

[application]

config/name="Bridge E2E"
run/main_scene="res://main.tscn"

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`);
write('main.gd', 'extends Node2D\n\nvar ticks := 0\n\n\nfunc _on_timer_timeout() -> void:\n\tticks += 1\n');
write('player.gd', `extends Node2D

var speed := 200.0
var jumps := 0


func _ready() -> void:
	if not InputMap.has_action("jump"):
		InputMap.add_action("jump")
	print("player ready")
	push_error("e2e test error")


func _process(delta: float) -> void:
	if Input.is_key_pressed(KEY_D):
		position.x += speed * delta
	if Input.is_action_just_pressed("jump"):
		jumps += 1
`);
write('extra.gd', 'extends Node2D\n\nvar label := "extra"\n');
write('main.tscn', `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://main.gd" id="1"]
[ext_resource type="Script" path="res://player.gd" id="2"]

[node name="Main" type="Node2D"]
script = ExtResource("1")

[node name="Player" type="Node2D" parent="."]
position = Vector2(100, 100)
script = ExtResource("2")

[node name="Camera2D" type="Camera2D" parent="."]
`);

const service = createGameDevService({ getProjectDir: () => dir, env: { ...process.env, CODEV_GODOT_PATH: godot } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;

async function editor(action, args = {}) {
    const result = await service.callTool('godot_editor', { action, args });
    const textPart = result.content.find(c => c.type === 'text');
    let data = null;
    try { data = JSON.parse(textPart.text); } catch { /* not JSON */ }
    return { error: !!result.isError, text: textPart.text, data, content: result.content };
}

function check(name, ok, detail = '') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `\n     ${String(detail).slice(0, 1500).split('\n').join('\n     ')}` : ''}`);
    if (!ok) failures++;
}

async function until(what, fn, seconds) {
    const end = Date.now() + seconds * 1000;
    let last;
    while (Date.now() < end) {
        last = await fn();
        if (last && !last.error) return last;
        await sleep(1000);
    }
    throw new Error(`${what} didn't happen within ${seconds}s: ${last ? last.text : ''}`);
}

(async () => {
    console.log(`Godot: ${execFileSync(godot, ['--version'], { encoding: 'utf8' }).trim()}\nProject: ${dir}`);
    const installed = await service.callTool('godot_install_bridge');
    check('godot_install_bridge', !installed.isError, installed.content[0].text);
    execFileSync(godot, ['--headless', '--path', dir, '--import'], { stdio: 'inherit', timeout: 240000 });

    const log = fs.openSync(path.join(dir, 'editor.log'), 'w');
    const ed = spawn(godot, ['--editor', '--path', dir, '--rendering-driver', 'opengl3', '--verbose'], { stdio: ['ignore', log, log] });
    try {
        await until('the bridge starting', async () => (fs.existsSync(path.join(dir, '.codev_bridge.json')) ? { error: false } : { error: true, text: 'no .codev_bridge.json yet' }), 120);
        const ping = await until('ping', () => editor('ping'), 30);
        check('ping reports bridge 2.0', ping.data && ping.data.bridge === '2.0', ping.text);
        await until('opening main.tscn', async () => {
            await editor('open_scene', { path: 'res://main.tscn' });
            const tree = await editor('scene_tree');
            return tree.data && tree.data.scene === 'res://main.tscn' ? tree : { error: true, text: tree.text };
        }, 30);

        // Engine docs from this Godot build.
        const docs = await editor('class_docs', { type: 'CharacterBody2D' });
        check('class_docs lists properties and methods', !docs.error && docs.data.properties.some(p => p.startsWith('velocity: Vector2')) && docs.data.methods.some(m => m.startsWith('move_and_slide(')), JSON.stringify(docs.data && docs.data.properties));
        const inherited = await editor('class_docs', { type: 'Timer', filter: 'wait' });
        check('class_docs filters', !inherited.error && inherited.data.properties.some(p => p.startsWith('wait_time: float')), inherited.text);
        const scriptDocs = await editor('class_docs', { node: 'Player' });
        check('class_docs on a node includes its script', !scriptDocs.error && scriptDocs.data.script && scriptDocs.data.script.properties.some(p => p.startsWith('speed')), scriptDocs.text);
        const unknown = await editor('class_docs', { type: 'CharacterBody' });
        check('class_docs suggests close names', unknown.error && /CharacterBody2D/.test(unknown.text), unknown.text);
        const found = await editor('find_class', { query: 'Body3D' });
        check('find_class', !found.error && found.data.classes.includes('RigidBody3D'), found.text);

        // Edits, each one undoable.
        const names = async () => ((await editor('scene_tree')).data.nodes || []).map(n => n.path);
        const added = await editor('add_node', { type: 'Timer', name: 'T', properties: { wait_time: 0.25, autostart: true } });
        check('add_node', !added.error && (await names()).includes('T'), added.text);
        const undone = await editor('undo');
        check('undo takes the node back out', !undone.error && /CoDev: add T/.test(undone.text) && !(await names()).includes('T'), undone.text);
        const redone = await editor('redo');
        check('redo puts it back', !redone.error && (await names()).includes('T'), redone.text);
        const set = await editor('set_property', { node: 'T', property: 'wait_time', value: 0.5 });
        check('set_property', !set.error && /0\.5/.test(set.text), set.text);
        await editor('undo');
        const got = await editor('get_property', { node: 'T', property: 'wait_time' });
        check('undo restores the old value', !got.error && /0\.25/.test(got.text), got.text);
        const connected = await editor('connect_signal', { from: 'T', signal: 'timeout', to: '.', method: '_on_timer_timeout' });
        check('connect_signal', !connected.error, connected.text);
        const badSignal = await editor('connect_signal', { from: 'T', signal: 'nope', to: '.', method: '_on_timer_timeout' });
        check('connect_signal refuses a missing signal', badSignal.error && /no signal nope/.test(badSignal.text), badSignal.text);
        await editor('add_node', { type: 'Node2D', name: 'Extra' });
        const attached = await editor('attach_script', { node: 'Extra', path: 'res://extra.gd' });
        check('attach_script', !attached.error && /extra\.gd/.test(attached.text), attached.text);
        const wrongBase = await editor('attach_script', { node: 'T', path: 'res://extra.gd' });
        check('attach_script refuses the wrong base class', wrongBase.error && /extends Node2D/.test(wrongBase.text), wrongBase.text);
        await editor('remove_node', { node: 'Extra' });
        check('remove_node', !(await names()).includes('Extra'));
        await editor('undo');
        const back = ((await editor('scene_tree')).data.nodes || []).find(n => n.path === 'Extra');
        check('undo brings a removed node back with its script', back && /extra\.gd/.test(back.script || ''), JSON.stringify(back));
        const saved = await editor('save_scene');
        const tscn = fs.readFileSync(path.join(dir, 'main.tscn'), 'utf8');
        check('save_scene keeps the timer, the script and the signal', !saved.error && /name="T" type="Timer"/.test(tscn) && /name="Extra"/.test(tscn)
            && /\[connection signal="timeout" from="T" to="." method="_on_timer_timeout"\]/.test(tscn), saved.text + '\n' + tscn);

        // Playtest.
        const play = await editor('play', { scene: 'main' });
        check('play', !play.error, play.text);
        const state = await until('the game answering', () => editor('game_state', { node: 'Player' }), 45);
        check('game_state reads script variables', state.data.properties.speed === 200, state.text);
        const tree = await editor('game_state');
        check('game_state without node lists the running tree', tree.data && tree.data.nodes.some(n => n.path === 'Player'), tree.text);
        const moved = await editor('game_input', { steps: [{ key: 'D', hold: 1 }], watch: ['Player'] });
        check('game_input holds a key and the player moves', !moved.error && moved.data.after.Player[0] > moved.data.before.Player[0] + 50, moved.text);
        await editor('game_input', { steps: [{ action: 'jump' }, { action: 'jump' }] });
        const jumps = await editor('game_state', { node: 'Player', properties: ['jumps'] });
        check('game_input presses actions', jumps.data && jumps.data.properties.jumps === 2, jumps.text);
        const badAction = await editor('game_input', { steps: [{ action: 'fly' }] });
        check('game_input names the game\'s actions when one is missing', badAction.error && /no input action fly.*jump/.test(badAction.text), badAction.text);
        const ticks = await editor('game_state', { node: '.', properties: ['ticks'] });
        check('the connected signal fires in the game', ticks.data && ticks.data.properties.ticks > 0, ticks.text);
        const gameLog = await editor('game_log');
        check('game_log has the game\'s errors and prints', !gameLog.error && /e2e test error/.test(gameLog.text) && /player ready/.test(gameLog.text), gameLog.text);
        const shot = await editor('game_shot', { max_width: 640 });
        const image = shot.content.find(c => c.type === 'image');
        check('game_shot returns a picture', !shot.error && image && Buffer.from(image.data, 'base64').subarray(0, 2).toString('hex') === 'ffd8', shot.text);
        const stop = await editor('stop');
        check('stop', !stop.error, stop.text);
        await sleep(1500);
        const after = await editor('game_state');
        check('game_* explain when the game isn\'t running', after.error && /Call play/.test(after.text), after.text);
    } catch (err) {
        check('the run', false, err.stack || err.message);
    } finally {
        ed.kill();
        await sleep(500);
        if (failures) console.log(`\nEditor output (last 80 lines):\n${fs.readFileSync(path.join(dir, 'editor.log'), 'utf8').split('\n').slice(-80).join('\n')}`);
    }
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
})();
