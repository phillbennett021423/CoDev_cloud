// Roblox for CoDev's agents: the game's code as a Rojo-style project folder on disk,
// checked with the real Luau compiler and CoDev's Roblox rules (roblox-luau.js), put into
// the place open in Roblox Studio, played, and looked at. Studio is reached through
// Roblox's own MCP server (built into Studio: Assistant > ... > Manage MCP Servers >
// "Enable Studio as MCP server"), which CoDev starts over stdio like any MCP client,
// so there is no plugin to install and nothing to pay for.
//
//   createRoblox({ getProjectDir, env, log }) -> { tools, names, callTool(name, args), close() }
//
// CODEV_ROBLOX_MCP points at another Studio MCP server (for example Roblox's older
// open-source rbx-studio-mcp, with CODEV_ROBLOX_MCP_ARGS ["--stdio"]); tests point it at
// a stand-in Studio. The server is started only when a tool needs Studio.
//
// Every change roblox_sync makes in Studio is one ChangeHistoryService recording, so the
// user undoes a whole sync with one Ctrl+Z, and a sync that fails partway is rolled back.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compileLuau, luauAvailable, lintRoblox, scriptKind } = require('./roblox-luau');
const { guide, TOPICS } = require('./roblox-guide');

const PROJECT_FILE = 'default.project.json';
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'Packages', 'DevPackages', '__pycache__']);
const SCRIPT_RE = /\.(luau|lua)$/i;
const MAX_OUTPUT = 12000;
const MAX_CHUNK = 150000; // characters of Luau per execute call during a sync

function text(value, isError = false) {
    return { content: [{ type: 'text', text: String(value) }], ...(isError ? { isError: true } : {}) };
}

function tail(output, max = MAX_OUTPUT) {
    output = String(output || '').trim();
    return output.length > max ? `[first ${output.length - max} characters cut]\n${output.slice(-max)}` : output;
}

function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }

// default.project.json at the project folder or up to three folders down.
function findRojoRoot(projectDir) {
    if (!projectDir || !fs.existsSync(projectDir)) return '';
    const queue = [[projectDir, 0]];
    while (queue.length) {
        const [dir, depth] = queue.shift();
        if (isFile(path.join(dir, PROJECT_FILE))) return dir;
        if (depth >= 3) continue;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) queue.push([path.join(dir, e.name), depth + 1]);
    }
    return '';
}

// How CoDev starts Roblox Studio's MCP server on this computer, or null.
function findStudioMcp(env = process.env, platform = process.platform) {
    if (env.CODEV_ROBLOX_MCP) {
        let args = [];
        const raw = String(env.CODEV_ROBLOX_MCP_ARGS || '').trim();
        if (raw) { try { args = JSON.parse(raw); } catch { args = raw.split(/\s+/); } }
        const command = env.CODEV_ROBLOX_MCP;
        if (platform === 'win32' && /\.(bat|cmd)$/i.test(command)) return { command: 'cmd.exe', args: ['/c', command, ...args], label: command };
        return { command, args, label: command };
    }
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const bat = path.join(local, 'Roblox', 'mcp.bat');
        if (isFile(bat)) return { command: 'cmd.exe', args: ['/c', bat], label: bat };
    }
    if (platform === 'darwin') {
        for (const file of ['/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', path.join(os.homedir(), 'Applications', 'RobloxStudio.app', 'Contents', 'MacOS', 'StudioMCP')]) {
            if (isFile(file)) return { command: file, args: [], label: file };
        }
        const legacy = '/Applications/RobloxStudioMCP.app/Contents/MacOS/rbx-studio-mcp';
        if (isFile(legacy)) return { command: legacy, args: ['--stdio'], label: legacy };
    }
    return null;
}

// A Luau long string that holds source exactly: the opening bracket's level is one no
// line of the source can close, and the newline after it (which Luau drops) is ours.
function longString(source) {
    let level = 0;
    while (source.includes(`]${'='.repeat(level)}]`)) level++;
    const eq = '='.repeat(level);
    return `[${eq}[\n${source}]${eq}]`;
}

function luauString(value) { return JSON.stringify(String(value)); }

const SERVICES = new Set(['Workspace', 'ReplicatedStorage', 'ReplicatedFirst', 'ServerScriptService', 'ServerStorage', 'StarterGui', 'StarterPack', 'StarterPlayer', 'Lighting', 'SoundService', 'Teams', 'Chat', 'TextChatService', 'MaterialService', 'LocalizationService']);

// The scripts a Rojo project maps into the place: [{ file, rel, kind, className, instancePath: [{ name, className }] }].
// Supports the common subset of Rojo: $path folders and files, $className, and init scripts.
function readProject(root) {
    const project = JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILE), 'utf8'));
    if (!project || typeof project.tree !== 'object') throw new Error(`${PROJECT_FILE} has no "tree".`);
    const scripts = [];
    const classFor = kind => (kind === 'server' ? 'Script' : kind === 'client' ? 'LocalScript' : 'ModuleScript');
    const baseName = file => path.basename(file).replace(/(\.server|\.client)?\.(luau|lua)$/i, '');

    function addFile(file, parentPath, nameOverride) {
        const kind = scriptKind(file);
        scripts.push({ file, rel: path.relative(root, file).split(path.sep).join('/'), kind, className: classFor(kind), instancePath: [...parentPath, { name: nameOverride || baseName(file), className: classFor(kind) }] });
    }

    function addDir(dir, instancePath) {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        const init = entries.find(e => e.isFile() && /^init(\.server|\.client)?\.(luau|lua)$/i.test(e.name));
        let here = instancePath;
        if (init) {
            // The folder is the script, and its other files are the script's children.
            const kind = scriptKind(init.name);
            const last = here[here.length - 1];
            here = [...here.slice(0, -1), { name: last.name, className: classFor(kind) }];
            scripts.push({ file: path.join(dir, init.name), rel: path.relative(root, path.join(dir, init.name)).split(path.sep).join('/'), kind, className: classFor(kind), instancePath: here });
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (e.name.startsWith('.') || (init && e.name === init.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) addDir(full, [...here, { name: e.name, className: 'Folder' }]); } else if (SCRIPT_RE.test(e.name)) addFile(full, here);
        }
    }

    function walk(node, instancePath) {
        for (const [key, child] of Object.entries(node)) {
            if (key.startsWith('$') || !child || typeof child !== 'object') continue;
            const className = child.$className || (instancePath.length === 0 ? (SERVICES.has(key) ? key : 'Folder') : 'Folder');
            const next = [...instancePath, { name: key, className }];
            if (child.$path) {
                const target = path.resolve(root, child.$path);
                if (!target.startsWith(path.resolve(root))) throw new Error(`$path "${child.$path}" is outside the project folder.`);
                if (isFile(target) && SCRIPT_RE.test(target)) addFile(target, instancePath, key);
                else if (fs.existsSync(target)) addDir(target, next);
            }
            walk(child, next);
        }
    }
    walk(project.tree, []);
    return { name: project.name || path.basename(root), scripts };
}

// The Luau that puts scripts into the open place, as one undoable recording.
function syncLuau(entries, label) {
    const lines = [
        'local CHS = game:GetService("ChangeHistoryService")',
        'local okSES, SES = pcall(function() return game:GetService("ScriptEditorService") end)',
        `local rec = CHS:TryBeginRecording(${luauString(label)})`,
        'local made, changed, same = 0, 0, 0',
        'local function child(parent, name, className, isScript)',
        '    local found = parent:FindFirstChild(name)',
        '    if found and found.ClassName ~= className then',
        '        if isScript and found:IsA("LuaSourceContainer") then found:Destroy(); found = nil',
        '        elseif isScript then error(("%s already has a %s named %s, not a %s"):format(parent:GetFullName(), found.ClassName, name, className)) end',
        '    end',
        '    if not found then',
        '        found = Instance.new(className)',
        '        found.Name = name',
        '        found.Parent = parent',
        '        if isScript then made += 1 end',
        '    end',
        '    return found',
        'end',
        'local function setSource(s, src)',
        '    if s.Source == src then same += 1 return end',
        '    local ok = okSES and pcall(function() SES:UpdateSourceAsync(s, function() return src end) end)',
        '    if not ok then s.Source = src end',
        '    changed += 1',
        'end',
        'local ok, err = pcall(function()'
    ];
    for (const e of entries) {
        const [top, ...rest] = e.instancePath;
        lines.push('    do');
        lines.push(`        local p = game:GetService(${luauString(top.name)})`);
        rest.forEach((seg, i) => {
            const isScript = i === rest.length - 1;
            lines.push(`        p = child(p, ${luauString(seg.name)}, ${luauString(seg.className)}, ${isScript})`);
        });
        lines.push(`        setSource(p, ${longString(e.source)})`);
        lines.push('    end');
    }
    lines.push(
        'end)',
        'if rec then CHS:FinishRecording(rec, if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel) end',
        'if not ok then error("CoDev sync failed and was rolled back: " .. tostring(err), 0) end',
        'print(("CODEV_SYNC %d %d %d"):format(made, changed - made, same))'
    );
    return lines.join('\n');
}

// Lines of Studio output that are errors (with the line after a "Stack Begin").
function studioProblems(output) {
    const keep = [];
    for (const line of String(output).split(/\r?\n/)) {
        if (/(^|\s)(Error|error|ERROR)\b|attempt to|Stack Begin|Script '[^']+', Line \d+|is not a valid member|Infinite yield|stack overflow|\[Error\]|:\d+: /.test(line)) keep.push(line.trim());
    }
    return keep.filter(Boolean);
}

function contentText(result) {
    return ((result && result.content) || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
}

function createRoblox({ getProjectDir = () => '', env = process.env, log = () => {} } = {}) {
    const rojoRoot = () => findRojoRoot(getProjectDir());
    let conn = null;
    let connecting = null;
    let stderr = [];

    async function connect() {
        if (conn) return conn;
        if (connecting) return connecting;
        const launch = findStudioMcp(env);
        if (!launch) {
            throw new Error('Roblox Studio\'s MCP server isn\'t set up on this computer. Ask the user to install Roblox Studio, open it, then in the Assistant panel choose ... > Manage MCP Servers and turn on "Enable Studio as MCP server". (Advanced: CODEV_ROBLOX_MCP can point at another Studio MCP server.)');
        }
        connecting = (async () => {
            const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
            const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
            stderr = [];
            const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: getDefaultEnvironment(), stderr: 'pipe' });
            transport.stderr && transport.stderr.on('data', chunk => { stderr.push(...String(chunk).split(/\r?\n/).filter(Boolean)); stderr = stderr.slice(-20); });
            const client = new Client({ name: 'codev', version: '1.0.0' });
            transport.onclose = () => { conn = null; };
            try {
                await client.connect(transport, { timeout: 30000 });
                const { tools } = await client.listTools(undefined, { timeout: 30000 });
                conn = { client, transport, tools: tools || [], launch, studioId: '' };
                log(`Connected to Roblox Studio's MCP server (${launch.label}), ${conn.tools.length} tools`);
                return conn;
            } catch (err) {
                try { await client.close(); } catch { /* already closed */ }
                throw new Error(`Couldn't start Roblox Studio's MCP server (${launch.label}): ${err.message}${stderr.length ? `\n${stderr.slice(-5).join('\n')}` : ''}`);
            }
        })();
        try { return await connecting; } finally { connecting = null; }
    }

    const toolDef = (c, name) => c.tools.find(t => t.name === name);
    const has = (c, ...names) => names.find(n => toolDef(c, n)) || '';

    // Fill in studio_id (the only open Studio, or the first) when the tool takes one.
    async function studioArgs(c, def, args) {
        const props = (def && def.inputSchema && def.inputSchema.properties) || {};
        const out = { ...args };
        if (props.studio_id && !out.studio_id && toolDef(c, 'list_roblox_studios')) {
            if (!c.studioId) {
                const listed = contentText(await c.client.callTool({ name: 'list_roblox_studios', arguments: {} }, undefined, { timeout: 30000 }));
                let id = '';
                try {
                    const data = JSON.parse(listed);
                    const list = Array.isArray(data) ? data : data.studios || data.instances || [];
                    const first = list[0] || {};
                    id = String(first.studio_id || first.id || first.studioId || '');
                } catch { id = (listed.match(/studio_id["':\s]+([\w-]+)/i) || listed.match(/\b([0-9a-f]{8}-[0-9a-f-]{27,})\b/i) || [])[1] || ''; }
                if (!id) throw new Error(`No Roblox Studio is open with a place loaded (list_roblox_studios said: ${listed.slice(0, 300) || 'nothing'}). Ask the user to open their place in Studio.`);
                c.studioId = id;
            }
            out.studio_id = c.studioId;
        }
        return out;
    }

    async function studio(name, args = {}, timeoutMs = 120000) {
        const c = await connect();
        const def = toolDef(c, name);
        if (!def) throw new Error(`Roblox Studio's MCP server has no tool "${name}". It has: ${c.tools.map(t => t.name).join(', ')}.`);
        const full = await studioArgs(c, def, args);
        try {
            return await c.client.callTool({ name, arguments: full }, undefined, { timeout: timeoutMs });
        } catch (err) {
            if (/closed|EPIPE|not connected/i.test(err.message)) conn = null;
            throw new Error(`Roblox Studio: ${err.message}`);
        }
    }

    // The value for a parameter that picks something, from its enum.
    function pick(def, prop, re) {
        const p = def && def.inputSchema && def.inputSchema.properties && def.inputSchema.properties[prop];
        const values = (p && p.enum) || [];
        return values.find(v => re.test(String(v))) || '';
    }

    // Run Luau in Studio's edit data model; returns the printed output.
    async function runLuau(code, timeoutMs = 120000) {
        const c = await connect();
        const name = has(c, 'execute_luau', 'run_code');
        if (!name) throw new Error('Roblox Studio\'s MCP server can\'t run Luau (no execute_luau or run_code tool).');
        const def = toolDef(c, name);
        const props = (def.inputSchema && def.inputSchema.properties) || {};
        const codeKey = ['code', 'source', 'luau', 'script', 'command'].find(k => props[k]) || Object.keys(props).find(k => props[k].type === 'string' && !/studio_id|datamodel/i.test(k)) || 'code';
        const args = { [codeKey]: code };
        if (props.datamodel_type) args.datamodel_type = pick(def, 'datamodel_type', /^edit$/i) || 'Edit';
        const result = await studio(name, args, timeoutMs);
        return { result, output: contentText(result), isError: Boolean(result && result.isError) };
    }

    // The scripts to check or sync: the given files, or every script in the project.
    function gather(files) {
        const root = rojoRoot();
        if (!root) throw new Error(`No Roblox project (${PROJECT_FILE}) in the project folder. Call roblox_init_project to make one.`);
        const project = readProject(root);
        let list = project.scripts;
        const wanted = (Array.isArray(files) ? files : files ? [files] : []).map(f => String(f).replace(/\\/g, '/').replace(/^\.\//, ''));
        if (wanted.length) {
            list = list.filter(s => wanted.some(w => s.rel === w || s.rel.endsWith(`/${w}`)));
            if (!list.length) throw new Error(`None of ${wanted.join(', ')} is a script the project maps into the place. Scripts: ${project.scripts.map(s => s.rel).slice(0, 30).join(', ') || 'none'}.`);
        }
        return { root, project, list: list.map(s => ({ ...s, source: fs.readFileSync(s.file, 'utf8').replace(/\r\n/g, '\n') })) };
    }

    async function checkList(list) {
        const compile = [];
        for (const s of list) {
            const r = await compileLuau(s.source, s.rel);
            if (!r.ok) compile.push({ file: s.rel, line: r.line, severity: 'error', rule: 'compile', message: r.message });
        }
        const lint = lintRoblox(list.map(s => ({ file: s.rel, source: s.source, kind: s.kind })));
        return { compile, lint };
    }

    function report(list, { compile, lint }) {
        const all = [...compile, ...lint];
        const errors = all.filter(p => p.severity === 'error').length;
        const warnings = all.length - errors;
        const lines = [errors || warnings ? `${errors} error(s), ${warnings} warning(s) in ${list.length} script(s).` : `No problems in ${list.length} script(s).`];
        for (const s of list) {
            const mine = all.filter(p => p.file === s.rel).sort((a, b) => a.line - b.line);
            if (!mine.length) { lines.push(`✓ ${s.rel}`); continue; }
            lines.push(`${mine.some(p => p.severity === 'error') ? '✗' : '!'} ${s.rel}`);
            for (const p of mine) lines.push(`  ${p.line ? `line ${p.line}` : 'file'} [${p.severity}${p.rule === 'compile' ? '' : `: ${p.rule}`}] ${p.message}`);
        }
        return { textOut: lines.join('\n'), errors, compileErrors: compile.length };
    }

    async function check({ files, source, kind = 'module' } = {}) {
        if (!(await luauAvailable())) return text('The Luau compiler (luau-web) isn\'t installed with CoDev, so scripts can\'t be checked. Run npm install in the CoDev folder.', true);
        let list;
        if (source !== undefined && source !== null && String(source).length) {
            const k = ['server', 'client', 'module'].includes(kind) ? kind : 'module';
            list = [{ rel: `snippet.${k === 'module' ? '' : `${k}.`}luau`, kind: k, source: String(source) }];
        } else list = gather(files).list;
        const r = report(list, await checkList(list));
        return text(tail(r.textOut), r.errors > 0);
    }

    async function initProject({ name = '' } = {}) {
        const dir = getProjectDir();
        if (!dir || !fs.existsSync(dir)) return text('No project folder is set, so there is nowhere to make the Roblox project. Ask the user to choose a project folder first.', true);
        const existing = findRojoRoot(dir);
        if (existing) return text(`There is already a Roblox project at ${existing} (${PROJECT_FILE}); keep working in it.`);
        const gameName = String(name || path.basename(dir)).trim().slice(0, 60) || 'MyGame';
        const write = (rel, body) => {
            const file = path.join(dir, rel);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            if (!fs.existsSync(file)) fs.writeFileSync(file, body);
        };
        write(PROJECT_FILE, JSON.stringify({
            name: gameName,
            tree: {
                $className: 'DataModel',
                ReplicatedStorage: { Shared: { $path: 'src/shared' } },
                ServerScriptService: { Server: { $path: 'src/server' } },
                StarterPlayer: { StarterPlayerScripts: { Client: { $path: 'src/client' } } }
            }
        }, null, 2) + '\n');
        write('src/shared/Config.luau', '--!strict\n-- Numbers the whole game shares (prices, rewards, timings), in one place.\nlocal Config = {\n\tStartingCoins = 0,\n}\n\nreturn Config\n');
        write('src/server/Main.server.luau', '--!strict\nlocal Players = game:GetService("Players")\nlocal ReplicatedStorage = game:GetService("ReplicatedStorage")\nlocal Config = require(ReplicatedStorage.Shared.Config)\n\nlocal function onPlayerAdded(player: Player)\n\tlocal leaderstats = Instance.new("Folder")\n\tleaderstats.Name = "leaderstats"\n\tlocal coins = Instance.new("IntValue")\n\tcoins.Name = "Coins"\n\tcoins.Value = Config.StartingCoins\n\tcoins.Parent = leaderstats\n\tleaderstats.Parent = player\nend\n\nPlayers.PlayerAdded:Connect(onPlayerAdded)\nfor _, player in Players:GetPlayers() do\n\tonPlayerAdded(player)\nend\n\nprint("Server ready")\n');
        write('src/client/Main.client.luau', '--!strict\nlocal Players = game:GetService("Players")\nlocal player = Players.LocalPlayer\n\nprint("Client ready for", player.Name)\n');
        const gitignore = path.join(dir, '.gitignore');
        const ignore = ['*.rbxl.lock', '*.rbxlx.lock', 'sourcemap.json'];
        const had = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
        const missing = ignore.filter(l => !had.split(/\r?\n/).includes(l));
        if (missing.length) fs.writeFileSync(gitignore, `${had}${had && !had.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
        log(`Made a Roblox project in ${dir}`);
        return text([
            `Made the Roblox project "${gameName}" in the project folder:`,
            `  ${PROJECT_FILE}: maps src/shared to ReplicatedStorage.Shared, src/server to ServerScriptService.Server, src/client to StarterPlayer.StarterPlayerScripts.Client (the Rojo layout, so Rojo works on it too)`,
            '  src/shared/Config.luau, src/server/Main.server.luau (leaderstats with Coins), src/client/Main.client.luau',
            'Next: write the game\'s scripts in src/, roblox_check them, then roblox_sync puts them into the place open in Studio.'
        ].join('\n'));
    }

    async function sync({ files } = {}) {
        const { project, list } = gather(files);
        if (!list.length) return text('The project has no scripts to sync yet. Write .server.luau, .client.luau or .luau files under src/ first.', true);
        const checked = await checkList(list);
        if (checked.compile.length) {
            return text(`Nothing was synced: ${checked.compile.length} script(s) don't compile.\n${report(list, { compile: checked.compile, lint: [] }).textOut}`, true);
        }
        const bad = list.find(s => !s.instancePath.length || !s.instancePath[0].name);
        if (bad) return text(`${bad.rel} isn't mapped under a service in ${PROJECT_FILE}.`, true);
        // Big projects go in several recordings so each call stays small.
        const batches = [];
        let size = 0;
        for (const s of list) {
            if (!batches.length || size + s.source.length > MAX_CHUNK) { batches.push([]); size = 0; }
            batches[batches.length - 1].push(s);
            size += s.source.length;
        }
        let made = 0; let changed = 0; let same = 0;
        for (let i = 0; i < batches.length; i++) {
            const label = `CoDev sync ${project.name}${batches.length > 1 ? ` (${i + 1}/${batches.length})` : ''}`;
            const { output, isError } = await runLuau(syncLuau(batches[i], label));
            const m = output.match(/CODEV_SYNC (\d+) (-?\d+) (\d+)/);
            if (isError || !m) return text(`Studio didn't finish the sync${i ? ` (batches 1 to ${i} went in)` : ''}:\n${tail(output, 3000) || 'no output'}`, true);
            made += Number(m[1]); changed += Math.max(0, Number(m[2])); same += Number(m[3]);
        }
        const warnings = checked.lint.filter(p => p.severity === 'warning').length;
        const lintErrors = checked.lint.filter(p => p.severity === 'error').length;
        const where = list.slice(0, 12).map(s => `  ${s.rel} -> ${s.instancePath.map(p => p.name).join('.')} (${s.className})`);
        return text([
            `Synced ${list.length} script(s) into the open place: ${made} new, ${changed} changed, ${same} already up to date. One Ctrl+Z in Studio undoes the sync.`,
            ...where,
            list.length > 12 ? `  ...and ${list.length - 12} more` : '',
            lintErrors || warnings ? `roblox_check found ${lintErrors} rule error(s) and ${warnings} warning(s); fix them next.` : '',
            'Scripts deleted from disk aren\'t removed from the place; remove those with roblox_studio if needed.',
            'Next: roblox_playtest.'
        ].filter(Boolean).join('\n'));
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function playtest({ seconds = 5, screenshot = true } = {}) {
        const c = await connect();
        const play = has(c, 'start_stop_play');
        const consoleTool = has(c, 'get_console_output');
        if (!play || !consoleTool) return text(`Roblox Studio's MCP server can't playtest (it needs start_stop_play and get_console_output; it has ${c.tools.map(t => t.name).join(', ')}).`, true);
        const def = toolDef(c, play);
        const startArgs = {};
        const stopArgs = {};
        for (const [key, p] of Object.entries((def.inputSchema && def.inputSchema.properties) || {})) {
            if (key === 'studio_id') continue;
            if (p.enum) {
                startArgs[key] = pick(def, key, /start_play|^play$|^start/i) || p.enum[0];
                stopArgs[key] = pick(def, key, /stop/i) || p.enum[p.enum.length - 1];
            } else if (p.type === 'boolean') { startArgs[key] = true; stopArgs[key] = false; }
        }
        const secs = Math.min(Math.max(Number(seconds) || 5, 1), 60);
        const before = contentText(await studio(consoleTool, {}, 30000));
        const started = await studio(play, startArgs, 60000);
        if (started.isError) return text(`Studio didn't start the playtest: ${contentText(started)}`, true);
        let shot = null;
        let output = '';
        try {
            await sleep(secs * 1000);
            const now = contentText(await studio(consoleTool, {}, 30000));
            output = now.startsWith(before) ? now.slice(before.length) : now;
            const capture = screenshot !== false && has(c, 'screen_capture');
            if (capture) {
                const res = await studio(capture, {}, 60000);
                shot = ((res && res.content) || []).find(x => x.type === 'image') || null;
            }
        } finally {
            await studio(play, stopArgs, 60000).catch(err => log(`Couldn't stop the playtest: ${err.message}`));
        }
        const problems = studioProblems(output);
        const summary = [
            problems.length ? `Playtest for ${secs}s: ${problems.length} error line(s) in the output.` : `Playtest for ${secs}s: no errors in the output.`,
            problems.length ? `Errors:\n  ${problems.slice(0, 40).join('\n  ')}` : '',
            `Output:\n${tail(output, 6000) || '(nothing printed)'}`,
            shot ? 'The picture is the game view at the end of the playtest; check it looks right.' : ''
        ].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text: summary }, ...(shot ? [shot] : [])], ...(problems.length ? { isError: true } : {}) };
    }

    async function status() {
        const root = rojoRoot();
        const launch = findStudioMcp(env);
        const compiler = await luauAvailable();
        let studioLine = 'not set up';
        let toolsLine = '';
        if (launch) {
            try {
                const c = await connect();
                toolsLine = c.tools.map(t => t.name).join(', ');
                let state = '';
                const stateTool = has(c, 'get_studio_state', 'get_studio_mode');
                if (stateTool) state = contentText(await studio(stateTool, {}, 15000)).slice(0, 300);
                studioLine = `connected (${launch.label})${state ? `, ${state}` : ''}`;
            } catch (err) { studioLine = err.message; }
        }
        let scripts = 0;
        if (root) { try { scripts = readProject(root).scripts.length; } catch (err) { scripts = -1; } }
        return text([
            `Roblox project: ${root ? `${root} (${scripts < 0 ? `${PROJECT_FILE} can't be read` : `${scripts} script(s)`})` : `none in the project folder (roblox_init_project makes one)`}`,
            `Luau compiler: ${compiler ? 'ready (roblox_check works without Studio)' : 'missing (run npm install in the CoDev folder)'}`,
            `Roblox Studio: ${launch ? studioLine : 'Studio\'s MCP server isn\'t set up. The user installs Roblox Studio, opens their place, and in the Assistant panel turns on ... > Manage MCP Servers > "Enable Studio as MCP server".'}`,
            toolsLine ? `Studio tools (for roblox_studio): ${toolsLine}` : ''
        ].filter(Boolean).join('\n'));
    }

    async function passThrough({ tool, args } = {}) {
        const c = await connect();
        if (!tool || tool === 'list') {
            return text(c.tools.map(t => `${t.name}: ${String(t.description || '').split('\n')[0].slice(0, 200)}\n  args: ${JSON.stringify((t.inputSchema && t.inputSchema.properties) ? Object.keys(t.inputSchema.properties) : [])}`).join('\n'));
        }
        const result = await studio(String(tool), args && typeof args === 'object' ? args : {});
        const content = ((result && result.content) || []).map(x => (x.type === 'text' ? { type: 'text', text: tail(x.text) } : x));
        return { content: content.length ? content : [{ type: 'text', text: '(Studio returned nothing)' }], ...(result && result.isError ? { isError: true } : {}) };
    }

    const tools = [
        {
            name: 'roblox_status',
            description: 'Check the Roblox setup: the Roblox project folder (default.project.json), the Luau compiler, and whether Roblox Studio is open with its MCP server on, plus the Studio tools roblox_studio can call. Call it once at the start of a Roblox task and follow what it says is missing; don\'t call it before every step.',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true }
        },
        {
            name: 'roblox_guide',
            description: 'Read CoDev\'s Roblox studio pack: how to build a Roblox game step by step with these tools (start), the Luau house style (luau), anti-exploit rules (security), saving player data (data), making money with game passes, developer products, subscriptions, Creator Rewards and DevEx (monetization), performance budgets (performance) and the publishing checklist (publish). Use it before planning a Roblox game or a system in one; for a current number such as the DevEx rate, use web_search instead, since Roblox changes them.',
            inputSchema: { type: 'object', properties: {
                topic: { type: 'string', enum: Object.keys(TOPICS), description: 'Which part of the pack to read; start is the overview and workflow.' }
            } },
            annotations: { readOnlyHint: true }
        },
        {
            name: 'roblox_init_project',
            description: 'Make a Roblox game project in the user\'s project folder: default.project.json (the Rojo layout) mapping src/shared, src/server and src/client into ReplicatedStorage, ServerScriptService and StarterPlayerScripts, with a starter Config module, server script (leaderstats) and client script. Existing files are never overwritten. Use it once, when roblox_status says there is no Roblox project; don\'t use it when one exists.',
            inputSchema: { type: 'object', properties: {
                name: { type: 'string', description: 'Optional: the game\'s name for the project file (default: the folder\'s name).' }
            } }
        },
        {
            name: 'roblox_check',
            description: 'Check Roblox Luau scripts without Studio: the real Luau compiler for syntax errors, plus CoDev\'s Roblox rules (remotes that trust the client, DataStore calls without pcall, developer products with no ProcessReceipt, server-only services in LocalScripts, LocalPlayer on the server, loops that never yield, deprecated wait/spawn/delay). Returns each problem with its line. Call it after every script change and before roblox_sync; fix every error. Pass source to check a snippet before writing it; it doesn\'t run the code (use roblox_playtest for that).',
            inputSchema: { type: 'object', properties: {
                files: { type: 'array', items: { type: 'string' }, description: 'Optional: project-relative script paths such as src/server/Shop.server.luau. Leave out to check every script in the project.' },
                source: { type: 'string', description: 'Optional: Luau source to check instead of files, for a snippet not saved yet.' },
                kind: { type: 'string', enum: ['server', 'client', 'module'], description: 'With source: whether it runs as a server Script, a LocalScript or a ModuleScript (default module).' }
            } },
            annotations: { readOnlyHint: true }
        },
        {
            name: 'roblox_sync',
            description: 'Put the project\'s scripts into the place open in Roblox Studio, at the paths default.project.json maps them to (making folders and scripts as needed and updating changed ones). It refuses when a script doesn\'t compile, and the whole sync is one step the user can undo with Ctrl+Z in Studio. Use it after roblox_check passes and before roblox_playtest. It only syncs scripts; to place parts, models or terrain use roblox_studio with execute_luau instead.',
            inputSchema: { type: 'object', properties: {
                files: { type: 'array', items: { type: 'string' }, description: 'Optional: only these project-relative script paths. Leave out to sync every script.' }
            } }
        },
        {
            name: 'roblox_playtest',
            description: 'Playtest the place open in Roblox Studio: press Play, let it run, read the output, take a picture of the game view, and stop. Returns the error lines, the output and the picture. Use it after roblox_sync and after every change to the world, and keep fixing until it runs clean and looks right; don\'t tell the user the game works before a clean playtest. Not for checking syntax (roblox_check is faster).',
            inputSchema: { type: 'object', properties: {
                seconds: { type: 'number', description: 'Optional: how long to run before reading the output (default 5, up to 60).' },
                screenshot: { type: 'boolean', description: 'Optional: take a picture of the game view at the end (default true).' }
            } }
        },
        {
            name: 'roblox_studio',
            description: 'Call any tool of Roblox Studio\'s own MCP server on the place the user has open: tool "list" shows them all with their arguments. The usual ones are execute_luau {code, datamodel_type: "Edit"} to build or change the world (place parts, models, lighting, terrain) and read anything, inspect_instance and the game-tree search to look at the place, script_read, insert_asset (with the asset search) for Creator Store models, mesh and material generation where Studio offers it, screen_capture and get_console_output. The Studio id is filled in for you. Use it for work inside Studio that the other roblox_ tools don\'t cover; don\'t use it to edit scripts that live in the project folder (edit the files, then roblox_sync), or to playtest (roblox_playtest).',
            inputSchema: { type: 'object', properties: {
                tool: { type: 'string', description: 'The Studio tool to call, such as execute_luau, or "list" to see every tool and its arguments.' },
                args: { type: 'object', description: 'The tool\'s arguments as an object, such as { "code": "print(workspace:GetChildren())" }.' }
            }, required: ['tool'] }
        }
    ];
    const names = tools.map(t => t.name);

    async function callTool(name, args = {}) {
        try {
            if (name === 'roblox_status') return await status();
            if (name === 'roblox_guide') return text(guide(args.topic));
            if (name === 'roblox_init_project') return await initProject(args);
            if (name === 'roblox_check') return await check(args);
            if (name === 'roblox_sync') return await sync(args);
            if (name === 'roblox_playtest') return await playtest(args);
            if (name === 'roblox_studio') return await passThrough(args);
            return text(`Unknown tool: ${name}`, true);
        } catch (err) {
            return text(err.message || String(err), true);
        }
    }

    async function close() {
        const c = conn;
        conn = null;
        if (c) { try { await c.client.close(); } catch { /* already closed */ } }
    }

    return { tools, names, callTool, close };
}

module.exports = { createRoblox, findRojoRoot, findStudioMcp, readProject, syncLuau, longString, studioProblems };
