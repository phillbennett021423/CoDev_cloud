// Game engine tools for agents, on the user's own computer: the Godot editor (through
// the CoDev Bridge editor plugin), Godot itself run headless to check scripts, and
// Blender run in the background with bpy scripts. Assets go from Blender to Godot as
// .glb files saved into the project folder, which the editor imports.
//
// Also here: godot_screenshot (run a scene with Movie Maker and return the last frame),
// the project checkpoints (checkpoints.js) and the Roblox tools (roblox.js: Luau checks,
// sync into Roblox Studio and playtests through Studio's own MCP server).
//
//   createGameDevService({ getProjectDir, log, env }) ->
//     { name, tools, callTool(name, args), status(), handleMcp(message, next), close() }
//
// The Windows app adds these tools to the browser's over codev:browser-mcp
// (handleMcp, like outlier-bridge.js); server.js loads agents/gamedev, which wraps
// this, as an agent-tools service. The page asks before every blender_run and
// godot_install_bridge (_meta "codev/alwaysAsk"), whatever the auto-run setting says,
// since a bpy script is Python running on the computer and the install changes the project.
//
// The editor plugin (godot-plugin/addons/codev_bridge) listens on 127.0.0.1 only and
// writes its port and a random token to <project>/.codev_bridge.json each time the
// editor opens; every command must carry that token. The game's real-time loop stays
// in Godot: agents send short JSON commands (add a node, set a property, play),
// never frame-by-frame data.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createSceneDressing } = require('./scene-dressing');
const { createCheckpoints } = require('./checkpoints');
const { createRoblox } = require('./roblox');

const PLUGIN_DIR = path.join(__dirname, 'godot-plugin', 'addons', 'codev_bridge');
const BRIDGE_FILE = '.codev_bridge.json';
const PLUGIN_CFG = 'res://addons/codev_bridge/plugin.cfg';
const SKIP_DIRS = new Set(['node_modules', '.git', '.godot', '.import', 'build', 'dist', '.venv', 'venv', '__pycache__']);
const MAX_OUTPUT = 12000;
const EDITOR_ACTIONS = ['ping', 'scene_tree', 'open_scene', 'save_scene', 'reload_scene', 'rescan', 'play', 'stop', 'is_playing',
    'add_node', 'instantiate', 'set_property', 'get_property', 'remove_node', 'select', 'attach_script', 'connect_signal', 'undo', 'redo',
    'class_docs', 'find_class', 'game_state', 'game_input', 'game_log', 'game_shot'];
// The playtest helper the bridge adds to the game as an autoload (only active when the
// game is started from the editor).
const AUTOLOAD_NAME = 'CoDevPlaytest';
const AUTOLOAD_PATH = 'res://addons/codev_bridge/playtest.gd';

function text(value, isError = false) {
    return { content: [{ type: 'text', text: String(value) }], ...(isError ? { isError: true } : {}) };
}

function tail(output, max = MAX_OUTPUT) {
    output = String(output || '').trim();
    return output.length > max ? `[first ${output.length - max} characters cut]\n${output.slice(-max)}` : output;
}

// project.godot at the project folder or up to three folders down.
function findGodotRoot(projectDir) {
    if (!projectDir || !fs.existsSync(projectDir)) return '';
    const queue = [[projectDir, 0]];
    while (queue.length) {
        const [dir, depth] = queue.shift();
        if (fs.existsSync(path.join(dir, 'project.godot'))) return dir;
        if (depth >= 3) continue;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) queue.push([path.join(dir, e.name), depth + 1]);
    }
    return '';
}

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }
function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }

function onPath(names, env) {
    const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of dirs) for (const name of names) for (const ext of exts) {
        const file = path.join(dir, name + ext);
        if (isFile(file)) return file;
    }
    return '';
}

// Executables in a folder whose names match, newest version last-sorted first.
function inFolder(dir, re) {
    try { return fs.readdirSync(dir).filter(n => re.test(n)).sort().reverse().map(n => path.join(dir, n)).find(isFile) || ''; } catch { return ''; }
}

function findGodot(env = process.env) {
    if (env.CODEV_GODOT_PATH && isFile(env.CODEV_GODOT_PATH)) return env.CODEV_GODOT_PATH;
    const found = onPath(['godot', 'godot4', 'Godot', 'godot-mono'], env);
    if (found) return found;
    const home = os.homedir();
    const exe = /^Godot_v4[\w.-]*(win64(_console)?\.exe|linux\.x86_64|linux\.arm64)$/i;
    for (const dir of [path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Godot'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Godot'), 'C:\\Godot', '/opt/godot'].filter(Boolean)) {
        const hit = inFolder(dir, exe);
        if (hit) return hit;
    }
    for (const file of ['C:\\Program Files (x86)\\Steam\\steamapps\\common\\Godot Engine\\godot.windows.opt.tools.64.exe', '/Applications/Godot.app/Contents/MacOS/Godot', '/Applications/Godot_mono.app/Contents/MacOS/Godot']) {
        if (isFile(file)) return file;
    }
    return '';
}

function findBlender(env = process.env) {
    if (env.CODEV_BLENDER_PATH && isFile(env.CODEV_BLENDER_PATH)) return env.CODEV_BLENDER_PATH;
    const found = onPath(['blender'], env);
    if (found) return found;
    const foundation = 'C:\\Program Files\\Blender Foundation';
    try {
        for (const dir of fs.readdirSync(foundation).sort().reverse()) {
            const file = path.join(foundation, dir, 'blender.exe');
            if (isFile(file)) return file;
        }
    } catch { /* not installed there */ }
    for (const file of ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/snap/bin/blender']) if (isFile(file)) return file;
    return '';
}

function run(file, args, { cwd, timeoutMs = 120000, env } = {}) {
    return new Promise(resolve => {
        execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: env || process.env }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: Boolean(err && err.killed), error: err && typeof err.code !== 'number' ? err.message : '', output: `${stdout || ''}${stderr ? `\n${stderr}` : ''}` });
        });
    });
}

// Keys and tokens from CoDev's own environment never reach Godot or Blender.
function childEnv(env, extra = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(env)) if (!/(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE)/i.test(k)) clean[k] = v;
    return { ...clean, ...extra };
}

// A path inside the project folder (no "..", no hidden files), or "".
function insideProject(root, rel) {
    const raw = String(rel || '').replace(/^res:\/\//, '').replace(/\\/g, '/');
    if (!raw || path.isAbsolute(raw) || raw.split('/').some(p => p === '..' || p.startsWith('.'))) return '';
    const full = path.resolve(root, raw);
    return full.startsWith(path.resolve(root) + path.sep) ? full : '';
}

function toRes(root, file) { return 'res://' + path.relative(root, file).split(path.sep).join('/'); }

// The lines of Godot's output worth an agent's attention.
function godotProblems(output) {
    const lines = String(output).split(/\r?\n/);
    const keep = [];
    lines.forEach((line, i) => {
        if (/SCRIPT ERROR|Parse Error|ERROR:|Failed to load|Compile Error|error\(/i.test(line)) {
            keep.push(line.trim());
            // Godot puts the location on the next line ("at: res://player.gd:12").
            if (lines[i + 1] && /^\s+at:/.test(lines[i + 1])) keep.push(lines[i + 1].trim());
        }
    });
    return keep;
}

// The playtest helper as an autoload in project.godot, keeping any others.
function enableAutoload(projectText) {
    const line = `${AUTOLOAD_NAME}="*${AUTOLOAD_PATH}"`;
    if (new RegExp(`^${AUTOLOAD_NAME}\\s*=`, 'm').test(projectText)) return projectText;
    const section = /^\[autoload\][ \t]*$/m;
    if (!section.test(projectText)) return `${projectText.replace(/\s*$/, '\n')}\n[autoload]\n\n${line}\n`;
    // Added as the section's first entry, so Godot loads it before the game's own autoloads.
    return projectText.replace(section, m => `${m}\n\n${line}`).replace(`${line}\n\n`, `${line}\n`);
}

// The plugin version in a plugin.cfg's text ("" when there is none).
function pluginVersion(cfgText) {
    const m = String(cfgText || '').match(/^version\s*=\s*"([^"]*)"/m);
    return m ? m[1] : '';
}

function enablePlugin(projectText) {
    const section = /^\[editor_plugins\]\s*$/m;
    if (!section.test(projectText)) return `${projectText.replace(/\s*$/, '\n')}\n[editor_plugins]\n\nenabled=PackedStringArray("${PLUGIN_CFG}")\n`;
    const [before, after] = projectText.split(section);
    const end = after.search(/^\[/m);
    let body = end >= 0 ? after.slice(0, end) : after;
    const rest = end >= 0 ? after.slice(end) : '';
    if (body.includes(PLUGIN_CFG)) return projectText;
    const enabled = body.match(/^enabled\s*=\s*PackedStringArray\(([^)]*)\)/m);
    body = enabled
        ? body.replace(enabled[0], `enabled=PackedStringArray(${enabled[1].trim() ? `${enabled[1].trim()}, ` : ''}"${PLUGIN_CFG}")`)
        : `${body.replace(/\s*$/, '')}\nenabled=PackedStringArray("${PLUGIN_CFG}")\n${rest ? '\n' : ''}`;
    return `${before}[editor_plugins]${body.startsWith('\n') ? '' : '\n'}${body}${rest}`;
}

const BLENDER_PRELUDE = `# Added by CoDev: where to save, and the project folder.
import os, sys, json
CODEV_OUTPUT = os.environ.get("CODEV_OUTPUT", "")
CODEV_PROJECT = os.environ.get("CODEV_PROJECT", "")
`;
const BLENDER_EXPORT = `
# Added by CoDev: save the scene as a .glb for Godot when the script didn't.
import bpy
if CODEV_OUTPUT and not os.path.exists(CODEV_OUTPUT):
    os.makedirs(os.path.dirname(CODEV_OUTPUT), exist_ok=True)
    if CODEV_OUTPUT.lower().endswith((".glb", ".gltf")):
        bpy.ops.export_scene.gltf(filepath=CODEV_OUTPUT, export_format="GLB" if CODEV_OUTPUT.lower().endswith(".glb") else "GLTF_SEPARATE", export_apply=True)
    elif CODEV_OUTPUT.lower().endswith(".blend"):
        bpy.ops.wm.save_as_mainfile(filepath=CODEV_OUTPUT)
    elif CODEV_OUTPUT.lower().endswith(".png"):
        bpy.context.scene.render.filepath = CODEV_OUTPUT
        bpy.ops.render.render(write_still=True)
`;

function createGameDevService({ getProjectDir = () => '', log = () => {}, env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const godotRoot = () => findGodotRoot(getProjectDir());

    async function bridge(action, args = {}, timeoutMs = 30000) {
        const root = godotRoot();
        if (!root) throw new Error('No Godot project (project.godot) in the project folder.');
        const infoFile = path.join(root, BRIDGE_FILE);
        if (!fs.existsSync(path.join(root, 'addons', 'codev_bridge', 'plugin.cfg'))) {
            throw new Error('The CoDev Bridge plugin isn\'t in this Godot project. Call godot_install_bridge, then the user opens the project in Godot (or turns the plugin on under Project > Project Settings > Plugins).');
        }
        let info;
        try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch {
            throw new Error('The Godot editor isn\'t running this project with the CoDev Bridge on. Ask the user to open the project in Godot 4 and make sure CoDev Bridge is ticked under Project > Project Settings > Plugins.');
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(`http://127.0.0.1:${Number(info.port)}/command`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CoDev-Token': String(info.token || '') },
                body: JSON.stringify({ action, args }), signal: controller.signal
            });
            const reply = await response.json().catch(() => ({ ok: false, error: `The editor answered HTTP ${response.status}.` }));
            if (!response.ok && reply.ok !== false) reply.ok = false;
            return reply;
        } catch (err) {
            if (err.name === 'AbortError') throw new Error(`The Godot editor didn't answer within ${timeoutMs / 1000} seconds.`);
            throw new Error(`Couldn't reach the Godot editor (${err.cause?.code || err.message}). It may have closed; ask the user to open the project in Godot again.`);
        } finally { clearTimeout(timer); }
    }

    async function status() {
        const root = godotRoot();
        const godot = findGodot(env);
        const blender = findBlender(env);
        let editor = 'not checked';
        if (root) {
            try {
                const reply = await bridge('ping', {}, 3000);
                editor = reply.ok ? `connected (Godot ${reply.godot}, scene ${reply.scene || 'none open'}${reply.playing ? ', game running' : ''})` : `error: ${reply.error}`;
            } catch (err) { editor = err.message; }
            const installed = readText(path.join(root, 'addons', 'codev_bridge', 'plugin.cfg'));
            const bundled = pluginVersion(readText(path.join(PLUGIN_DIR, 'plugin.cfg')));
            if (installed && pluginVersion(installed) !== bundled) {
                editor += `. The project has the older CoDev Bridge ${pluginVersion(installed) || '1.0'}; call godot_install_bridge to update it to ${bundled} (undo, engine docs and playtesting), then the user restarts the editor`;
            }
        }
        return { root, godot, blender, editor };
    }

    async function validate({ files = [], run_seconds: runSeconds = 0 } = {}) {
        const root = godotRoot();
        if (!root) return text('No Godot project (project.godot) in the project folder.', true);
        const godot = findGodot(env);
        if (!godot) return text('Godot isn\'t installed where CoDev can find it, so only the static godot_check can run. The user can set CODEV_GODOT_PATH to their Godot 4 executable (for example C:\\Godot\\Godot_v4.3-stable_win64.exe), or put godot on the PATH.', true);
        const cenv = childEnv(env);
        const out = [`Godot: ${godot}`, `Project: ${root}`];
        // Class names and imports come from the .godot cache; a fresh checkout has none.
        if (!fs.existsSync(path.join(root, '.godot'))) {
            const imported = await run(godot, ['--headless', '--path', root, '--import'], { cwd: root, timeoutMs: 300000, env: cenv });
            out.push(`Imported the project first (exit ${imported.code}).`);
        }
        let scripts = (Array.isArray(files) ? files : [files]).map(f => insideProject(root, f)).filter(Boolean);
        if (!scripts.length) {
            const all = [];
            const walk = dir => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name) || (e.isDirectory() && e.name === 'addons')) continue;
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) walk(full); else if (e.name.endsWith('.gd')) all.push(full);
                }
            };
            walk(root);
            scripts = all.slice(0, 60);
            if (all.length > 60) out.push(`Checking the first 60 of ${all.length} scripts; pass files to check others.`);
        }
        let failed = 0;
        for (const file of scripts) {
            if (!file.endsWith('.gd')) continue;
            const res = toRes(root, file);
            const result = await run(godot, ['--headless', '--path', root, '--check-only', '--script', res], { cwd: root, timeoutMs: 60000, env: cenv });
            const problems = godotProblems(result.output);
            if (result.code !== 0 || problems.length) {
                failed++;
                out.push(`✗ ${res}${result.timedOut ? ' (timed out)' : ''}\n  ${(problems.length ? problems : [tail(result.output, 600) || `exit ${result.code}`]).join('\n  ')}`);
            } else out.push(`✓ ${res}`);
        }
        const seconds = Math.min(Math.max(Number(runSeconds) || 0, 0), 60);
        if (seconds) {
            // Runs the game's main scene without a window and reports what it printed as errors.
            const result = await run(godot, ['--headless', '--path', root, '--quit-after', String(Math.round(seconds * 60))], { cwd: root, timeoutMs: (seconds + 60) * 1000, env: cenv });
            const problems = godotProblems(result.output);
            if (!problems.length && result.code !== 0) problems.push(tail(result.output, 600) || `Godot exited with code ${result.code}.`);
            if (problems.length) failed++;
            out.push(problems.length ? `Main scene run for ${seconds}s: ${problems.length} error line(s)\n  ${problems.slice(0, 40).join('\n  ')}` : `Main scene ran for ${seconds}s with no errors.`);
        }
        out.unshift(failed ? `${failed} problem(s) found.` : 'No errors.');
        return text(tail(out.join('\n')), false);
    }

    async function installBridge() {
        const root = godotRoot();
        if (!root) return text('No Godot project (project.godot) in the project folder, so there is nowhere to install the plugin.', true);
        const target = path.join(root, 'addons', 'codev_bridge');
        fs.mkdirSync(target, { recursive: true });
        for (const name of fs.readdirSync(PLUGIN_DIR)) fs.writeFileSync(path.join(target, name), fs.readFileSync(path.join(PLUGIN_DIR, name)));
        const projectFile = path.join(root, 'project.godot');
        const before = fs.readFileSync(projectFile, 'utf8');
        const after = enableAutoload(enablePlugin(before));
        if (after !== before) fs.writeFileSync(projectFile, after);
        // The token file changes on every editor start and shouldn't be committed.
        const gitignore = path.join(root, '.gitignore');
        if (fs.existsSync(gitignore) && !fs.readFileSync(gitignore, 'utf8').split(/\r?\n/).includes(BRIDGE_FILE)) fs.appendFileSync(gitignore, `\n${BRIDGE_FILE}\n`);
        log(`Installed the CoDev Bridge plugin in ${target}`);
        return text(`Installed the CoDev Bridge editor plugin ${pluginVersion(readText(path.join(PLUGIN_DIR, 'plugin.cfg')))} in ${toRes(root, target)}, turned it on in project.godot and added its playtest helper (${AUTOLOAD_NAME}, which only runs when the game is started from the editor). `
            + 'The user now opens (or reopens) the project in the Godot 4 editor; the bridge starts with it. Then godot_editor works, starting with action "ping".');
    }

    async function editor({ action, args } = {}) {
        if (!EDITOR_ACTIONS.includes(action)) return text(`Unknown action "${action}". Actions: ${EDITOR_ACTIONS.join(', ')}.`, true);
        // game_input waits while it holds keys (up to 30 seconds in the game).
        const reply = await bridge(action, args && typeof args === 'object' ? args : {}, action === 'game_input' ? 50000 : 30000);
        const { ok, error, ...rest } = reply;
        if (ok === false) return text(`Godot: ${error || 'the command failed.'}`, true);
        if (action === 'game_shot' && rest.data) {
            const { data, mime, ...about } = rest;
            return { content: [
                { type: 'text', text: `The running game at frame ${about.frame} (${about.width}x${about.height}, the window is ${(about.game_size || []).join('x')}). Clicks in game_input use the window's size.` },
                { type: 'image', data, mimeType: mime || 'image/jpeg' }
            ] };
        }
        return text(JSON.stringify(rest, null, 2).slice(0, MAX_OUTPUT));
    }

    async function blenderRun({ script, output = '', blend_file: blendFile = '', timeout_seconds: timeoutSeconds = 300 } = {}) {
        if (!String(script || '').trim()) return text('blender_run needs a script (Python using bpy).', true);
        const blender = findBlender(env);
        if (!blender) return text('Blender isn\'t installed where CoDev can find it. The user can install it free from blender.org, or set CODEV_BLENDER_PATH to blender.exe.', true);
        const root = getProjectDir();
        if (!root || !fs.existsSync(root)) return text('No project folder is set, so there is nowhere to save what Blender makes.', true);
        const outFile = output ? insideProject(root, output) : '';
        if (output && !outFile) return text(`output must be a path inside the project folder, like assets/models/rock.glb (got "${output}").`, true);
        const blend = blendFile ? insideProject(root, blendFile) : '';
        if (blendFile && (!blend || !fs.existsSync(blend))) return text(`No .blend file "${blendFile}" in the project folder.`, true);
        const existed = outFile && fs.existsSync(outFile) ? fs.statSync(outFile).mtimeMs : 0;
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-blender-'));
        const scriptFile = path.join(work, 'codev_script.py');
        // An output that existed before is replaced: the export at the end only runs when the file is missing.
        if (existed) fs.rmSync(outFile, { force: true });
        fs.writeFileSync(scriptFile, BLENDER_PRELUDE + '\n' + String(script) + '\n' + BLENDER_EXPORT);
        const args = ['--background', ...(blend ? [blend] : ['--factory-startup']), '--python-exit-code', '1', '--python', scriptFile];
        const seconds = Math.min(Math.max(Number(timeoutSeconds) || 300, 10), 1800);
        const result = await run(blender, args, { cwd: work, timeoutMs: seconds * 1000, env: childEnv(env, { CODEV_OUTPUT: outFile, CODEV_PROJECT: root }) });
        fs.rmSync(work, { recursive: true, force: true });
        const lines = [result.timedOut ? `Blender was stopped after ${seconds} seconds.` : result.code === 0 ? 'Blender finished.' : `Blender failed (exit ${result.code}${result.error ? `: ${result.error}` : ''}).`];
        if (outFile) {
            if (fs.existsSync(outFile)) {
                const size = fs.statSync(outFile).size;
                lines.push(`Saved ${path.relative(root, outFile).split(path.sep).join('/')} (${(size / 1024).toFixed(1)} KB).`);
                if (/\.(glb|gltf)$/i.test(outFile) && godotRoot() && outFile.startsWith(godotRoot())) {
                    lines.push(`For Godot: godot_editor action "rescan" imports it, then "instantiate" with path "${toRes(godotRoot(), outFile)}" adds it to the open scene.`);
                }
            } else lines.push('The output file wasn\'t made; read the log below.');
        }
        const log = tail(result.output.split(/\r?\n/).filter(l => !/^(Read prefs|Blender quit|Warning: Unable to open|found bundled python|Color management)/.test(l)).join('\n'), 8000);
        if (log) lines.push('Blender output:\n' + log);
        return text(lines.join('\n'), result.code !== 0 || result.timedOut);
    }

    // Movie Maker mode writes every frame as a PNG at a fixed frame rate; the last one is
    // the picture. It needs a real renderer, so a window opens for the run.
    async function screenshot({ scene = '', seconds = 2, resolution = '1280x720' } = {}) {
        const root = godotRoot();
        if (!root) return text('No Godot project (project.godot) in the project folder.', true);
        const godot = findGodot(env);
        if (!godot) return text('Godot isn\'t installed where CoDev can find it. The user can set CODEV_GODOT_PATH to their Godot 4 executable, or put godot on the PATH.', true);
        const secs = Math.min(Math.max(Number(seconds) || 2, 0.5), 20);
        const size = /^\d{2,4}x\d{2,4}$/.test(String(resolution)) ? String(resolution) : '1280x720';
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-shot-'));
        try {
            const args = ['--path', root, '--write-movie', path.join(out, 'frame.png'), '--fixed-fps', '30', '--quit-after', String(Math.round(secs * 30)), '--resolution', size, '--disable-vsync'];
            if (scene) {
                const file = insideProject(root, scene);
                if (!file || !file.endsWith('.tscn') || !fs.existsSync(file)) return text(`No scene ${scene} in the project. Pass a .tscn path like res://levels/main.tscn, or leave scene out for the main scene.`, true);
                args.push(toRes(root, file));
            }
            const result = await run(godot, args, { cwd: root, timeoutMs: (secs + 90) * 1000, env: childEnv(env) });
            const problems = godotProblems(result.output);
            const frames = fs.readdirSync(out).filter(f => /\.png$/i.test(f)).sort();
            if (!frames.length) return text(`Godot didn't write a frame (exit ${result.code}${result.timedOut ? ', timed out' : ''}).${problems.length ? `\nErrors:\n  ${problems.slice(0, 30).join('\n  ')}` : `\n${tail(result.output, 1500)}`}`, true);
            const png = fs.readFileSync(path.join(out, frames[frames.length - 1]));
            return { content: [
                { type: 'text', text: `${scene ? toRes(root, insideProject(root, scene)) : 'Main scene'} after ${secs}s at ${size}: frame ${frames.length}. ${problems.length ? `${problems.length} error line(s):\n  ${problems.slice(0, 30).join('\n  ')}` : 'No errors printed.'}` },
                { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }
            ] };
        } finally {
            fs.rmSync(out, { recursive: true, force: true });
        }
    }

    // Scene dressing: the asset library, placement rules and learning from the user's edits.
    const dressing = createSceneDressing({ getRoot: () => godotRoot() || getProjectDir(), bridge, log });
    // Checkpoints of the whole project folder, with one-step rollback (checkpoints.js).
    const checkpoints = createCheckpoints({ getRoot: () => getProjectDir() || godotRoot(), env });
    // Roblox: the project's Luau checked, synced into Studio and playtested (roblox.js).
    // A bpy script run in the background for the Roblox export, or null without Blender.
    async function runBlenderScript(script, extra, timeoutMs) {
        const blender = findBlender(env);
        if (!blender) return null;
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-blender-'));
        try {
            const file = path.join(work, 'codev_script.py');
            fs.writeFileSync(file, script);
            return await run(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', file], { cwd: work, timeoutMs, env: childEnv(env, extra) });
        } finally { fs.rmSync(work, { recursive: true, force: true }); }
    }
    const roblox = createRoblox({ getProjectDir, env, log, runBlender: runBlenderScript, fetchImpl });

    const tools = [
        {
            name: 'gamedev_status',
            description: 'Check the game tools on the user\'s computer: the Godot project folder, whether Godot and Blender are installed, and whether the Godot editor is open with the CoDev Bridge plugin. Call it before using godot_editor, godot_validate or blender_run for the first time in a task, and follow what it says is missing (install Godot or Blender, open the editor, or godot_install_bridge). Once per task is enough; don\'t call it before every step.',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true }
        },
        {
            name: 'godot_validate',
            description: 'Run the real Godot engine headless on the user\'s project (as saved on disk) to check GDScript for parse and compile errors, and optionally run the main scene for a few seconds to catch runtime errors. Call it after changing scripts, besides the static godot_check. With sandbox review on, the changes are checked once the user approves them, so it checks the saved files, not staged edits: don\'t use it to check sandbox edits before approval (use godot_check for those).',
            inputSchema: { type: 'object', properties: {
                files: { type: 'array', items: { type: 'string' }, description: 'Scripts to check (res:// or project-relative paths). Leave it out to check every script (up to 60).' },
                run_seconds: { type: 'number', description: 'Optional: also run the main scene headless for this many seconds (up to 60) and report errors it prints.' }
            } },
            annotations: { readOnlyHint: true }
        },
        {
            name: 'godot_screenshot',
            description: 'Run the user\'s Godot game (the main scene, or another scene) for a moment with Godot\'s Movie Maker and return the last frame as a picture, plus any errors it printed, so you can see whether a change looks right: a camera, UI layout, a shader, lighting, a placed model. It opens a game window briefly on the user\'s computer (real rendering can\'t run headless). Use it after a visual change, once godot_validate passes; don\'t use it to check logic or parse errors (godot_validate is faster for those), and don\'t call it again without changing something first.',
            inputSchema: { type: 'object', properties: {
                scene: { type: 'string', description: 'Optional: the scene to run, as a res:// or project-relative path to a .tscn. Leave it out for the main scene.' },
                seconds: { type: 'number', description: 'Optional: how long to run before the picture is taken (default 2, up to 20), so animations and physics settle.' },
                resolution: { type: 'string', description: 'Optional: the window size as WIDTHxHEIGHT, like 1280x720 (the default).' }
            } },
            annotations: { readOnlyHint: true }
        },
        {
            name: 'godot_editor',
            description: 'Control the Godot 4 editor the user has open, through the CoDev Bridge plugin: ping, scene_tree (the open scene\'s nodes), open_scene {path}, save_scene, reload_scene {path}, rescan (import new or changed files such as a .glb from Blender), play {scene?: "main" | "current" | res path}, stop, is_playing, '
                + 'add_node {parent?, type, name, properties?}, instantiate {path (.tscn or .glb), parent?, name?, properties?}, set_property {node, property, value}, get_property {node, property}, remove_node {node}, select {node}, '
                + 'attach_script {node, path (a .gd already saved; rescan first)}, connect_signal {from, signal, to, method}, undo / redo (only CoDev\'s own last change, unless force: true because the user asked). '
                + 'Every edit is one step in the editor\'s undo history ("CoDev: ..."), so the user can Ctrl+Z it. '
                + 'Engine docs from the user\'s exact Godot version: class_docs {type or node, filter?, inherited?} lists properties, methods, signals and enums (with a node, its script\'s too); find_class {query} finds class names. Check them before using a property or method you aren\'t sure exists in this version. '
                + 'Playtesting, after play (wait a second or two for the game to start): game_state {node?, properties?} (no node: the running scene tree with positions; with node: its script variables or the properties listed), '
                + 'game_input {steps: [{action | key ("W", "Space", "Left") | click [x, y], hold?: seconds, wait?: seconds after}], watch?: [node paths]} presses them in the running game and reports the watched nodes\' positions before and after, '
                + 'game_log {since?, errors_only?} (errors, warnings and prints since the game started; pass the returned next as since to get only new ones), game_shot {max_width?} (a picture of the running game). '
                + 'A playtest loop: play, game_input, game_state or game_shot to check the result, game_log for errors, stop, fix, play again. '
                + 'Node paths are relative to the scene root ("." is the root, "Player/Camera3D"); in game_* they are relative to the running scene, or /root/... for autoloads. Vectors and colors are arrays ([1, 2, 3]); res:// strings load resources. Changes show in the editor at once; save_scene writes them to disk. '
                + 'Use it when the user has the Godot editor open and wants a scene built, changed or played; call gamedev_status first, and godot_install_bridge if it says the bridge is missing. To change .gd or .tscn files on disk, use the file tools instead. If an action fails, read scene_tree to check node paths before trying again.',
            inputSchema: { type: 'object', properties: {
                action: { type: 'string', enum: EDITOR_ACTIONS, description: 'What to do in the editor, one of the actions above (ping to check the bridge is connected).' },
                args: { type: 'object', description: 'The action\'s arguments, as listed in the description.' }
            }, required: ['action'] }
        },
        {
            name: 'godot_install_bridge',
            description: 'Install the CoDev Bridge editor plugin into the user\'s Godot project (addons/codev_bridge) and turn it on in project.godot, so godot_editor can control the editor. The user is asked first. Use it only when gamedev_status or godot_editor says the bridge isn\'t installed; it is needed once per project, so don\'t call it again after it worked.',
            inputSchema: { type: 'object', properties: {} },
            _meta: { 'codev/alwaysAsk': true }
        },
        {
            name: 'blender_run',
            description: 'Run a Python script in Blender in the background (bpy) on the user\'s computer, for example to model, rig, animate or render, and save the result into the project folder. With output ending in .glb or .gltf, the scene is exported for Godot automatically when the script doesn\'t save it (.blend and .png outputs work too). '
                + 'In the script, CODEV_OUTPUT is the full output path and CODEV_PROJECT the project folder. Blender starts from an empty factory scene unless blend_file is given; delete the default cube, camera and light when you don\'t want them. The user is asked before each run.',
            inputSchema: { type: 'object', properties: {
                script: { type: 'string', description: 'The Python script (import bpy).' },
                output: { type: 'string', description: 'Optional: where to save, inside the project folder, like assets/models/crate.glb.' },
                blend_file: { type: 'string', description: 'Optional: a .blend file in the project to open first.' },
                timeout_seconds: { type: 'number', description: 'Optional: stop Blender after this long (default 300, up to 1800).' }
            }, required: ['script'] },
            _meta: { 'codev/alwaysAsk': true }
        },
        ...dressing.tools,
        ...checkpoints.tools,
        ...roblox.tools
    ];

    async function callTool(name, args = {}) {
        try {
            if (name === 'gamedev_status') {
                const s = await status();
                return text([
                    `Godot project: ${s.root || 'none found in the project folder (no project.godot)'}`,
                    `Godot engine: ${s.godot || 'not found (set CODEV_GODOT_PATH, or put godot on the PATH); godot_validate is off, godot_check still works'}`,
                    `Blender: ${s.blender || 'not found (free from blender.org, or set CODEV_BLENDER_PATH); blender_run is off'}`,
                    `Godot editor bridge: ${s.root ? s.editor : 'needs a Godot project'}`
                ].join('\n'));
            }
            if (name === 'godot_validate') return await validate(args);
            if (name === 'godot_editor') return await editor(args);
            if (name === 'godot_screenshot') return await screenshot(args);
            if (name === 'godot_install_bridge') return await installBridge();
            if (name === 'blender_run') return await blenderRun(args);
            if (dressing.names.includes(name)) return await dressing.callTool(name, args);
            if (checkpoints.names.includes(name)) return await checkpoints.callTool(name, args);
            if (roblox.names.includes(name)) return await roblox.callTool(name, args);
            return text(`Unknown tool: ${name}`, true);
        } catch (err) {
            return text(err.message || String(err), true);
        }
    }

    // The Windows app: these tools join the browser's on codev:browser-mcp.
    async function handleMcp(message, next) {
        if (message && message.method === 'tools/call' && tools.some(t => t.name === (message.params && message.params.name))) {
            return { jsonrpc: '2.0', id: message.id, result: await callTool(message.params.name, message.params.arguments || {}) };
        }
        const reply = await next(message);
        if (message && message.method === 'tools/list' && reply && reply.result) reply.result = { ...reply.result, tools: [...(reply.result.tools || []), ...tools] };
        return reply;
    }

    return {
        name: 'gamedev',
        tools,
        callTool,
        handleMcp,
        status: async () => {
            const s = await status();
            return { available: true, detail: `Godot ${s.godot ? 'found' : 'not found'}, Blender ${s.blender ? 'found' : 'not found'}${s.root ? `, Godot project at ${s.root}` : ''}` };
        },
        close: () => roblox.close()
    };
}

module.exports = { createGameDevService, findGodotRoot, findGodot, findBlender, enablePlugin, enableAutoload, pluginVersion, godotProblems, EDITOR_ACTIONS, PLUGIN_DIR };
