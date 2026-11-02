// The Godot and Blender tools (desktop/gamedev): the editor bridge's protocol against
// a stand-in editor, installing the plugin, headless Godot checks and Blender runs with
// stand-in executables, and the tools reaching server.js's agent-tools router.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createGameDevService, enablePlugin, findGodotRoot, godotProblems, PLUGIN_DIR } = require('../desktop/gamedev');
const { loadServices } = require('../agent-services');

const unix = process.platform !== 'win32';

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-gamedev-'));
    fs.mkdirSync(path.join(dir, 'game', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'game', 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Test"\n');
    fs.writeFileSync(path.join(dir, 'game', 'scripts', 'ok.gd'), 'extends Node\n');
    fs.writeFileSync(path.join(dir, 'game', 'scripts', 'bad.gd'), 'extends Node\nfunc x(\n');
    fs.writeFileSync(path.join(dir, 'game', '.gitignore'), '.godot/\n');
    return dir;
}

function textOf(result) { return result.content.map(c => c.text).join('\n'); }

// An executable stand-in: a Node script that does what fake() says.
function fakeExe(dir, name, body) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!${process.execPath}\nconst fs = require('fs');\nconst args = process.argv.slice(2);\n${body}\n`);
    fs.chmodSync(file, 0o755);
    return file;
}

test('the plugin is turned on in project.godot without losing other plugins or sections', () => {
    const fresh = enablePlugin('config_version=5\n[application]\nconfig/name="A"\n');
    assert.match(fresh, /\[editor_plugins\]\n\nenabled=PackedStringArray\("res:\/\/addons\/codev_bridge\/plugin\.cfg"\)/);
    const other = enablePlugin('[editor_plugins]\n\nenabled=PackedStringArray("res://addons/dialogic/plugin.cfg")\n\n[rendering]\nx=1\n');
    assert.match(other, /enabled=PackedStringArray\("res:\/\/addons\/dialogic\/plugin\.cfg", "res:\/\/addons\/codev_bridge\/plugin\.cfg"\)\n\n\[rendering\]\nx=1/);
    assert.equal(enablePlugin(other), other);
    assert.ok(fs.existsSync(path.join(PLUGIN_DIR, 'plugin.gd')) && fs.existsSync(path.join(PLUGIN_DIR, 'plugin.cfg')));
});

test('the project, the install and the editor bridge: token sent, replies passed on, a closed editor explained', async () => {
    const dir = project();
    assert.equal(findGodotRoot(dir), path.join(dir, 'game'));
    const service = createGameDevService({ getProjectDir: () => dir, env: { PATH: '' } });
    assert.match(textOf(await service.callTool('godot_editor', { action: 'ping' })), /isn't in this Godot project\. Call godot_install_bridge/);
    assert.match(textOf(await service.callTool('godot_install_bridge')), /Installed the CoDev Bridge/);
    assert.ok(fs.existsSync(path.join(dir, 'game', 'addons', 'codev_bridge', 'plugin.gd')));
    assert.match(fs.readFileSync(path.join(dir, 'game', 'project.godot'), 'utf8'), /codev_bridge\/plugin\.cfg/);
    assert.match(fs.readFileSync(path.join(dir, 'game', '.gitignore'), 'utf8'), /^\.codev_bridge\.json$/m);
    assert.match(textOf(await service.callTool('godot_editor', { action: 'ping' })), /isn't running this project/);

    const seen = [];
    const editor = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            seen.push({ token: req.headers['x-codev-token'], url: req.url, body: JSON.parse(body) });
            const { action, args } = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(action === 'ping' ? { ok: true, godot: '4.3.stable', scene: 'res://main.tscn' }
                : action === 'set_property' ? { ok: false, error: 'No node Nope in the open scene.' } : { ok: true, echo: args }));
        });
    });
    await new Promise(r => editor.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(dir, 'game', '.codev_bridge.json'), JSON.stringify({ port: editor.address().port, token: 'secret-token' }));
    try {
        assert.match(textOf(await service.callTool('gamedev_status')), /Godot editor bridge: connected \(Godot 4\.3\.stable, scene res:\/\/main\.tscn\)/);
        const added = await service.callTool('godot_editor', { action: 'add_node', args: { type: 'MeshInstance3D', name: 'Rock', properties: { position: [0, 1, 0] } } });
        assert.ok(!added.isError);
        assert.deepEqual(JSON.parse(textOf(added)).echo.properties.position, [0, 1, 0]);
        assert.deepEqual(seen.map(s => s.token), ['secret-token', 'secret-token']);
        assert.equal(seen[1].url, '/command');
        const failed = await service.callTool('godot_editor', { action: 'set_property', args: { node: 'Nope', property: 'x', value: 1 } });
        assert.ok(failed.isError);
        assert.match(textOf(failed), /Godot: No node Nope/);
        assert.match(textOf(await service.callTool('godot_editor', { action: 'run_python' })), /Unknown action "run_python"/);
    } finally { editor.close(); }
});

test('godot_validate runs Godot headless per script and reports its error lines', { skip: !unix && 'needs a Unix shell for the stand-in Godot' }, async () => {
    const dir = project();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-bin-'));
    const godot = fakeExe(bin, 'godot', `
if (args.includes('--import')) { fs.mkdirSync(args[args.indexOf('--path') + 1] + '/.godot', { recursive: true }); process.exit(0); }
const script = args[args.indexOf('--script') + 1];
if (script && script.endsWith('bad.gd')) { console.error('SCRIPT ERROR: Parse Error: Expected closing ")".\\n   at: GDScript::reload (' + script + ':3)'); process.exit(1); }
if (args.includes('--quit-after')) console.log('ERROR: Node not found: "Player/Camera3D".');`);
    const service = createGameDevService({ getProjectDir: () => dir, env: { PATH: '', CODEV_GODOT_PATH: godot, ANTHROPIC_API_KEY: 'sk-ant-x' } });
    const out = textOf(await service.callTool('godot_validate', { run_seconds: 2 }));
    assert.match(out, /^2 problem\(s\) found\./);
    assert.match(out, /Imported the project first/);
    assert.match(out, /✓ res:\/\/scripts\/ok\.gd/);
    assert.match(out, /✗ res:\/\/scripts\/bad\.gd\n  SCRIPT ERROR: Parse Error/);
    assert.match(out, /Main scene run for 2s: 1 error line\(s\)\n  ERROR: Node not found/);
    assert.match(textOf(await service.callTool('godot_validate', { files: ['res://scripts/ok.gd'] })), /^No errors\./);
    assert.deepEqual(godotProblems('hello\nERROR: x\n   at: res://a.gd:2\nfine'), ['ERROR: x', 'at: res://a.gd:2']);
    const missing = createGameDevService({ getProjectDir: () => dir, env: { PATH: '' } });
    if (!require('../desktop/gamedev').findGodot({ PATH: '' })) assert.match(textOf(await missing.callTool('godot_validate')), /Godot isn't installed/);
});

test('blender_run runs the script in the background, exports into the project and keeps CoDev\'s keys out', { skip: !unix && 'needs a Unix shell for the stand-in Blender' }, async () => {
    const dir = project();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-bin-'));
    const blender = fakeExe(bin, 'blender', `
const script = fs.readFileSync(args[args.indexOf('--python') + 1], 'utf8');
console.log('args ' + JSON.stringify(args.filter(a => a.startsWith('--'))));
console.log('key ' + (process.env.ANTHROPIC_API_KEY || 'none'));
if (!script.includes('primitive_cube_add') || !script.includes('export_scene.gltf')) process.exit(3);
fs.mkdirSync(require('path').dirname(process.env.CODEV_OUTPUT), { recursive: true });
fs.writeFileSync(process.env.CODEV_OUTPUT, 'glTF');`);
    const service = createGameDevService({ getProjectDir: () => dir, env: { PATH: '', CODEV_BLENDER_PATH: blender, ANTHROPIC_API_KEY: 'sk-ant-x' } });
    const result = await service.callTool('blender_run', { script: 'import bpy\nbpy.ops.mesh.primitive_cube_add(size=1)', output: 'game/models/crate.glb' });
    const out = textOf(result);
    assert.ok(!result.isError, out);
    assert.match(out, /Saved game\/models\/crate\.glb/);
    assert.match(out, /godot_editor action "rescan".*"res:\/\/models\/crate\.glb"/);
    assert.match(out, /args \["--background","--factory-startup","--python-exit-code","--python"\]/);
    assert.match(out, /key none/);
    assert.ok(fs.existsSync(path.join(dir, 'game', 'models', 'crate.glb')));
    assert.match(textOf(await service.callTool('blender_run', { script: 'x', output: '../outside.glb' })), /inside the project folder/);
    assert.match(textOf(await service.callTool('blender_run', { script: 'x', output: '.hidden/a.glb' })), /inside the project folder/);
    const tools = service.tools.filter(t => t._meta && t._meta['codev/alwaysAsk']).map(t => t.name).sort();
    assert.deepEqual(tools, ['blender_run', 'checkpoint_restore', 'godot_install_bridge']);
});

test('server.js\'s agent-tools router offers the game tools', async () => {
    const dir = project();
    const router = await loadServices({ workspace: { root: dir } }, { log: () => {}, specs: [{ name: 'gamedev', module: path.join(__dirname, '..', 'agents', 'gamedev') }] });
    const list = await router.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map(t => t.name), ['gamedev_status', 'godot_validate', 'godot_screenshot', 'godot_editor', 'godot_install_bridge', 'blender_run', 'scene_assets', 'scene_dress', 'scene_edit', 'scene_learn', 'checkpoint_create', 'checkpoint_list', 'checkpoint_restore']);
    const status = await router.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gamedev_status', arguments: {} } });
    assert.match(status.result.content[0].text, /Godot project: .*game/);
    await router.close();
});

test('godot_screenshot runs the scene with Movie Maker and returns the last frame with the errors it printed', { skip: !unix && 'needs a Unix shell for the stand-in Godot' }, async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'game', 'level.tscn'), '[gd_scene format=3]\n');
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-bin-'));
    const godot = fakeExe(bin, 'godot', `
const movie = args[args.indexOf('--write-movie') + 1];
fs.writeFileSync(movie + '.args', JSON.stringify(args));
const frames = Number(args[args.indexOf('--quit-after') + 1]);
for (let i = 0; i < 3; i++) fs.writeFileSync(movie.replace('.png', String(i).padStart(8, '0') + '.png'), 'frame' + i);
console.log('frames ' + frames + ' scene ' + (args[args.length - 1].startsWith('res://') ? args[args.length - 1] : 'main'));
console.error('ERROR: Shader compilation failed.');`);
    const service = createGameDevService({ getProjectDir: () => dir, env: { PATH: '', CODEV_GODOT_PATH: godot } });
    const result = await service.callTool('godot_screenshot', { scene: 'res://level.tscn', seconds: 1 });
    assert.ok(!result.isError, textOf(result));
    assert.match(result.content[0].text, /res:\/\/level\.tscn after 1s at 1280x720: frame 3\. 1 error line\(s\):\n  ERROR: Shader compilation failed\./);
    assert.equal(result.content[1].type, 'image');
    assert.equal(Buffer.from(result.content[1].data, 'base64').toString(), 'frame2');
    assert.match(textOf(await service.callTool('godot_screenshot', { scene: 'res://nope.tscn' })), /No scene res:\/\/nope\.tscn/);
});

test('checkpoints snapshot the folder outside its own git and roll back changed, deleted and new files', async () => {
    const dir = project();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-data-'));
    const service = createGameDevService({ getProjectDir: () => dir, env: { ...process.env, CODEV_DATA_DIR: data } });
    fs.mkdirSync(path.join(dir, 'game', 'node_modules'));
    fs.writeFileSync(path.join(dir, 'game', 'node_modules', 'big.js'), 'x');
    const made = textOf(await service.callTool('checkpoint_create', { label: 'Before the refactor' }));
    const id = (made.match(/^Checkpoint ([0-9a-f]+) saved \("Before the refactor", (\d+) files\)/) || [])[1];
    assert.ok(id, made);
    assert.ok(!fs.existsSync(path.join(dir, '.git')), 'the project gets no .git of its own');
    // The agent's changes: an edit, a deletion and a new file.
    fs.writeFileSync(path.join(dir, 'game', 'scripts', 'ok.gd'), 'extends Node2D\n');
    fs.rmSync(path.join(dir, 'game', 'scripts', 'bad.gd'));
    fs.writeFileSync(path.join(dir, 'game', 'scripts', 'new.gd'), 'extends Node\n');
    assert.match(textOf(await service.callTool('checkpoint_list')), new RegExp(`${id}  .*  Before the refactor`));
    const back = textOf(await service.callTool('checkpoint_restore', { id }));
    assert.match(back, new RegExp(`Rolled back to checkpoint ${id}; removed 1 file\\(s\\) made since \\(game/scripts/new\\.gd\\)\\. To undo the rollback, restore checkpoint ([0-9a-f]+)\\.`));
    assert.equal(fs.readFileSync(path.join(dir, 'game', 'scripts', 'ok.gd'), 'utf8'), 'extends Node\n');
    assert.ok(fs.existsSync(path.join(dir, 'game', 'scripts', 'bad.gd')));
    assert.ok(!fs.existsSync(path.join(dir, 'game', 'scripts', 'new.gd')));
    assert.ok(fs.existsSync(path.join(dir, 'game', 'node_modules', 'big.js')), 'excluded folders are left alone');
    // The rollback can itself be undone.
    const undo = back.match(/restore checkpoint ([0-9a-f]+)\.$/)[1];
    await service.callTool('checkpoint_restore', { id: undo });
    assert.equal(fs.readFileSync(path.join(dir, 'game', 'scripts', 'ok.gd'), 'utf8'), 'extends Node2D\n');
    assert.ok(fs.existsSync(path.join(dir, 'game', 'scripts', 'new.gd')));
    assert.match(textOf(await service.callTool('checkpoint_restore', { id: 'zz' })), /checkpoint id/);
});
