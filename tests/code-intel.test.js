// Code intelligence (mobile/www/agent-ui/code-intel.js): the project map, symbol search,
// line reads, the architecture review and the Godot checks, on a small Godot + JS project.
const test = require('node:test');
const assert = require('node:assert/strict');
const CI = require('../mobile/www/agent-ui/code-intel.js');

const formatThing = 'function formatThing(x) {\n  const one = x.first + x.second;\n  const two = one * 2 + x.third;\n  const three = two - one + x.fourth;\n  const four = three / 2 + x.fifth;\n  return four + three + two;\n}\n';
const FILES = {
    'game/project.godot': 'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.3", "Forward Plus")\n[autoload]\nGameState="*res://autoload/game_state.gd"\n',
    'game/main.tscn': '[gd_scene format=3]\n[ext_resource type="Script" path="res://player.gd" id="1"]\n[ext_resource type="Script" path="res://missing.gd" id="2"]\n[node name="Main" type="Node3D"]\n[connection signal="hit" from="Player" to="." method="_on_player_hit"]\n',
    'game/player.gd': 'extends CharacterBody3D\nclass_name Player\nsignal hit(damage: int)\nonready var cam = $Camera\nconst SPEED = 5.0\nfunc _physics_process(delta):\n\tvelocity.y -= gravity\n\tmove_and_slide(velocity)\nfunc _process(delta):\n\tmove_and_slide()\nfunc unused_helper():\n\tpass\n',
    'game/autoload/game_state.gd': 'extends Node\nvar score := 0\n',
    'game/enemy.gd': 'extends Player\nfunc _on_player_hit():\n\tpass\n',
    'game/fx.gdshader': 'shader_type spatial;\nuniform vec4 tint : hint_color;\nvoid fragment() {\n\tfloat a = 1;\n\tALBEDO = vec3(1, 0, 0);\n}\n',
    'Cs/Mover.cs': 'using Godot;\npublic class Mover : CharacterBody3D {\n  public override void _PhysicsProcess(float delta) {\n    Velocity.Y = 0;\n  }\n  public void _Ready() {}\n}\n',
    'src/a.js': 'import { b } from "./b";\nexport function aa() { return b(); }\n' + formatThing,
    'src/b.js': 'import { aa } from "./a";\nexport const b = () => 1;\n' + formatThing
};

test('the index finds symbols with line ranges and resolves imports, res:// paths, extends and scenes', () => {
    const index = CI.buildIndex(FILES);
    const player = index.files.get('game/player.gd');
    assert.deepEqual(player.symbols.map(s => `${s.kind}:${s.name}`), ['class_name:Player', 'signal:hit', 'var:cam', 'const:SPEED', 'function:_physics_process', 'function:_process', 'function:unused_helper']);
    assert.equal(player.symbols.find(s => s.name === '_physics_process').end, 8);
    assert.equal(index.files.get('src/a.js').symbols.find(s => s.name === 'formatThing').end, 9);
    assert.deepEqual([...index.importedBy.get('game/player.gd')].sort(), ['game/enemy.gd', 'game/main.tscn']);
    assert.ok(index.importedBy.get('src/b.js').has('src/a.js'));
    assert.equal(index.godot.version, '4.3');
    assert.equal(index.godot.mainScene, 'res://main.tscn');
    assert.deepEqual(index.godot.autoloads, [{ name: 'GameState', path: 'res://autoload/game_state.gd' }]);
});

test('code_map, find_symbol, file_outline and read_lines give agents file-by-file context', () => {
    const index = CI.buildIndex(FILES);
    const map = CI.codeMap(index);
    assert.match(map, /Godot 4\.3 project/);
    assert.match(map, /game\/player\.gd \[13 lines\] class Player:2, signal hit:3/);
    assert.match(CI.codeMap(index, { focus: 'src' }), /Files matching "src": 2 files/);
    // Signals connected in the editor are found in the scene file.
    const found = CI.findSymbol(index, 'hit');
    assert.match(found, /game\/player\.gd:3 signal/);
    assert.match(found, /game\/main\.tscn:5/);
    assert.match(CI.fileOutline(index, 'res://player.gd'), /Used by: game\/enemy\.gd, game\/main\.tscn/);
    assert.match(CI.readLines(index, 'a.js', 3, 4), /^src\/a\.js lines 3-4 of 10:\n3\| function formatThing\(x\) \{\n4\|/);
    assert.match(CI.fileOutline(index, 'nope.gd'), /No file "nope\.gd"/);
});

test('architecture_review finds copy-paste, repeated definitions, unused code and import cycles, not engine callbacks', () => {
    const report = CI.architectureReview(CI.buildIndex(FILES));
    assert.match(report, /7 lines: src\/a\.js:3-9 = src\/b\.js:3-9/);
    assert.match(report, /- formatThing: src\/a\.js:3, src\/b\.js:3/);
    assert.match(report, /function unused_helper at game\/player\.gd:11/);
    assert.match(report, /src\/a\.js <-> src\/b\.js/);
    // Called by the engine or connected in a scene: never "unused".
    assert.doesNotMatch(report, /_physics_process|_on_player_hit|fragment|class Mover/);
});

test('godot_check flags Godot 3 code, shader GLSL-isms, C# struct traps, physics mistakes and missing res:// files', () => {
    const out = CI.godotCheck(CI.buildIndex(FILES));
    for (const expected of [
        /game\/player\.gd:4 \[error\] `onready var`/,
        /game\/player\.gd:8 \[error\] In Godot 4 `move_and_slide\(\)` takes no arguments/,
        /game\/player\.gd:7 \[warning\] Acceleration added to velocity without `\* delta`/,
        /game\/player\.gd:10 \[warning\] Physics movement in `_process`/,
        /game\/fx\.gdshader:2 \[error\] `hint_color`/,
        /game\/fx\.gdshader:4 \[error\] Integer literal 1/,
        /game\/fx\.gdshader:5 \[error\] `vec3\(1, 0, 0\)`/,
        /Cs\/Mover\.cs:2 \[error\] Godot 4 C# scripts must be `partial`/,
        /Cs\/Mover\.cs:3 \[error\] Godot 4 passes delta as double/,
        /Cs\/Mover\.cs:4 \[error\] .*CS1612/,
        /Cs\/Mover\.cs:6 \[error\] Engine callbacks need `override`/,
        /game\/main\.tscn:3 \[error\] res:\/\/missing\.gd doesn't exist/
    ]) assert.match(out, expected);
    // $Camera is a node path, not the Godot 3 Camera type.
    assert.doesNotMatch(out, /player\.gd:4 \[error\] Godot 3 3D node name/);
    const clean = CI.godotCheck(CI.buildIndex({ 'project.godot': 'config_version=5\n', 'ok.gd': 'extends CharacterBody3D\n@onready var cam: Camera3D = $Camera\nfunc _physics_process(delta: float) -> void:\n\tvelocity.y -= gravity * delta\n\tmove_and_slide()\n' }));
    assert.match(clean, /no problems found/);
    // A Godot 3 project isn't told to migrate.
    assert.doesNotMatch(CI.godotCheck(CI.buildIndex({ 'project.godot': 'config_version=4\n', 'old.gd': 'onready var x = 1\n' })), /onready/);
});

test('the indexer reads each file once, re-reads files agents changed, and the tools work on the result', async () => {
    const reads = [];
    const files = { 'a.gd': 'func one():\n\tpass\n', 'b.gd': 'func two():\n\tone()\n', 'pic.png': 'x' };
    const ws = { label: 'test', list: async () => Object.keys(files), read: async path => { reads.push(path); return files[path]; } };
    const indexer = CI.createIndexer({ isIndexable: p => /\.gd$/.test(p) });
    await indexer.index(ws);
    await indexer.index(ws);
    assert.deepEqual(reads.sort(), ['a.gd', 'b.gd']);
    files['a.gd'] = 'func uno():\n\tpass\n';
    const index = await indexer.index(ws, { changed: ['a.gd'] });
    assert.equal(reads.length, 3);
    assert.ok(index.defs.has('uno'));
    const tools = CI.buildTools({ getIndex: () => indexer.index(ws) });
    assert.deepEqual(tools.map(t => t.name), CI.TOOL_NAMES);
    assert.match(await tools.find(t => t.name === 'find_symbol').run({ name: 'two' }), /b\.gd:1-2 function/);
    const none = CI.buildTools({ getIndex: async () => { throw new Error('No project is connected.'); } });
    assert.match(await none[0].run({}), /isn't available: No project is connected/);
});

test('the engine guide and the code map note go only to tasks that need them', () => {
    assert.ok(CI.engineGuide('add a hitbox to the frame data of my punch').includes('FRAME-DATA STATE MACHINES'));
    assert.ok(CI.engineGuide('write a dissolve shader').includes('SHADERS'));
    assert.equal(CI.engineGuide('summarize this article'), '');
    const note = CI.contextNote(CI.buildIndex(FILES), 'fix formatThing in Player');
    assert.match(note, /Godot 4\.3 project/);
    assert.match(note, /formatThing: function at src\/a\.js:3-9/);
    assert.match(note, /Player: class_name at game\/player\.gd:2/);
});
