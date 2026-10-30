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
    assert.deepEqual(tools, ['blender_run', 'godot_install_bridge']);
});

test('server.js\'s agent-tools router offers the game tools', async () => {
    const dir = project();
    const router = await loadServices({ workspace: { root: dir } }, { log: () => {}, specs: [{ name: 'gamedev', module: path.join(__dirname, '..', 'agents', 'gamedev') }] });
    const list = await router.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map(t => t.name), ['gamedev_status', 'godot_validate', 'godot_editor', 'godot_install_bridge', 'blender_run']);
    const status = await router.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gamedev_status', arguments: {} } });
    assert.match(status.result.content[0].text, /Godot project: .*game/);
    await router.close();
});
