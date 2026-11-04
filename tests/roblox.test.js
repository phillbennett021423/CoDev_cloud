// The Roblox tools (desktop/gamedev/roblox.js, roblox-luau.js): the real Luau compiler,
// the Roblox rules, the Rojo project mapping, and syncing and playtesting against a
// stand-in Roblox Studio MCP server (tests/fixtures/fake-roblox-studio.js) that runs the
// Luau it gets in the real Luau VM over a mock DataModel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRoblox, findStudioMcp, readProject, longString } = require('../desktop/gamedev/roblox');
const { compileLuau, lintRoblox, stripLuau } = require('../desktop/gamedev/roblox-luau');
const { guide } = require('../desktop/gamedev/roblox-guide');

const FAKE = path.join(__dirname, 'fixtures', 'fake-roblox-studio.js');
const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

function folder() { return fs.mkdtempSync(path.join(os.tmpdir(), 'codev-roblox-')); }

function withStudio(dir, extraEnv = {}) {
    const log = path.join(dir, '..', `${path.basename(dir)}-studio.log`);
    const roblox = createRoblox({
        getProjectDir: () => dir,
        env: { ...process.env, CODEV_ROBLOX_MCP: process.execPath, CODEV_ROBLOX_MCP_ARGS: JSON.stringify([FAKE, '--log', log]), ...extraEnv }
    });
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
    return { roblox, calls };
}

function rules(source, kind = 'server', file = 'x.server.luau') {
    return lintRoblox([{ file, source, kind }]).map(p => `${p.line}:${p.rule}`);
}

test('the real Luau compiler finds syntax errors with their line', async () => {
    assert.deepEqual(await compileLuau('--!strict\nlocal x: number = 1\nfor _, v in {1, 2} do x += v end\n', 'ok'), { ok: true, line: 0, message: '' });
    const bad = await compileLuau('local a = 1\nif a then\n  print(a)\n', 'Shop.server');
    assert.equal(bad.ok, false);
    assert.equal(bad.line, 4);
    assert.match(bad.message, /Expected 'end'/);
    assert.match((await compileLuau('local t = {\n', 'x')).message, /Expected/);
});

test('the Roblox rules catch exploitable, data-losing and deprecated code, but not comments or strings', () => {
    assert.deepEqual(rules('wait(1)\nspawn(f)\ntask.wait(1)\nx:Wait()\n-- wait(2)\nprint("wait(3)")\n'), ['1:deprecated-wait', '2:deprecated-spawn']);
    assert.deepEqual(rules('local p = Instance.new("Part", workspace)\n'), ['1:instance-new-parent']);
    assert.deepEqual(rules('print(workspace:FindFirstChild("Door").Name)\n'), ['1:find-first-child-chain']);
    assert.deepEqual(rules('local me = game.Players.LocalPlayer\n'), ['1:server-local-player']);
    assert.deepEqual(rules('local me = game.Players.LocalPlayer\n', 'client', 'x.client.luau'), []);
    assert.deepEqual(rules('local ds = game:GetService("DataStoreService")\n', 'client', 'x.client.luau'), ['1:client-server-only']);
    assert.deepEqual(rules('local ok = pcall(function()\n  return store:SetAsync(key, data)\nend)\nstore:GetAsync(key)\n'), ['4:datastore-pcall']);
    assert.deepEqual(rules('remote.OnServerEvent:Connect(function(player, amount)\n  coins.Value += amount\nend)\n'), ['1:remote-validation']);
    assert.deepEqual(rules('remote.OnServerEvent:Connect(function(player, amount)\n  if typeof(amount) ~= "number" then return end\nend)\n'), []);
    assert.deepEqual(rules('while true do\n  print(1)\nend\n'), ['1:loop-without-wait']);
    assert.deepEqual(rules('while true do\n  if x then print(1) end\n  task.wait(1)\nend\n'), []);
    assert.deepEqual(rules('local f = loadstring(src)\n'), ['1:loadstring']);
    assert.deepEqual(rules('--[[\nwait(1)\nwhile true do\nend\n]]\nlocal s = [==[ spawn( ]==]\n'), []);
    // Comments and strings are blanked without moving lines.
    const { code, noStrings } = stripLuau('a = "x" -- c\nb = [[y\nz]]');
    assert.equal(code.split('\n').length, 3);
    assert.equal(noStrings, 'a = " "     \nb = [[ \n ]]');
});

test('a developer product with no ProcessReceipt is an error; one in the server clears it', () => {
    const shop = { file: 'src/client/Shop.client.luau', kind: 'client', source: 'local MPS = game:GetService("MarketplaceService")\nMPS:PromptProductPurchase(player, 123)\n' };
    assert.deepEqual(lintRoblox([shop]).map(p => `${p.file}:${p.line}:${p.rule}`), ['src/client/Shop.client.luau:2:missing-process-receipt']);
    const receipt = { file: 'src/server/Receipts.server.luau', kind: 'server', source: 'MPS.ProcessReceipt = function(info)\n  return Enum.ProductPurchaseDecision.PurchaseGranted\nend\n' };
    assert.deepEqual(lintRoblox([shop, receipt]), []);
    const clientReceipt = { ...receipt, file: 'src/client/R.client.luau', kind: 'client' };
    assert.deepEqual(lintRoblox([shop, clientReceipt]).map(p => p.rule).sort(), ['client-process-receipt', 'missing-process-receipt']);
});

test('the Rojo project maps folders, init scripts and single files to instance paths', () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, 'default.project.json'), JSON.stringify({ name: 'G', tree: { $className: 'DataModel',
        ReplicatedStorage: { Shared: { $path: 'src/shared' } },
        ServerScriptService: { Server: { $path: 'src/server' }, Boot: { $path: 'boot.server.lua' } },
        Workspace: { Map: { $className: 'Model', Spinner: { $path: 'src/spinner.server.luau' } } } } }));
    const w = (rel, body = 'return {}\n') => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
    w('src/shared/Util.luau'); w('src/shared/Inventory/init.luau'); w('src/shared/Inventory/Items.luau');
    w('src/server/Main.server.luau', 'print(1)\n'); w('src/server/Combat/Hit.server.luau', 'print(2)\n'); w('src/server/notes.txt', 'x');
    w('boot.server.lua', 'print(3)\n'); w('src/spinner.server.luau', 'print(4)\n');
    const map = Object.fromEntries(readProject(dir).scripts.map(s => [s.rel, s.instancePath.map(p => `${p.name}:${p.className}`).join('/')]));
    assert.deepEqual(map, {
        'src/shared/Inventory/init.luau': 'ReplicatedStorage:ReplicatedStorage/Shared:Folder/Inventory:ModuleScript',
        'src/shared/Inventory/Items.luau': 'ReplicatedStorage:ReplicatedStorage/Shared:Folder/Inventory:ModuleScript/Items:ModuleScript',
        'src/shared/Util.luau': 'ReplicatedStorage:ReplicatedStorage/Shared:Folder/Util:ModuleScript',
        'src/server/Combat/Hit.server.luau': 'ServerScriptService:ServerScriptService/Server:Folder/Combat:Folder/Hit:Script',
        'src/server/Main.server.luau': 'ServerScriptService:ServerScriptService/Server:Folder/Main:Script',
        'boot.server.lua': 'ServerScriptService:ServerScriptService/Boot:Script',
        'src/spinner.server.luau': 'Workspace:Workspace/Map:Model/Spinner:Script'
    });
});

test('long strings hold any source exactly', () => {
    for (const src of ['a', 'x = [[a]] .. "]]"', 'y = "]=]" .. "]==]"', '\nstarts with a newline']) {
        const lit = longString(src);
        const level = lit.match(/^\[(=*)\[/)[1];
        assert.equal(lit.slice(level.length + 3, -(level.length + 2)), src);
        assert.ok(!src.includes(`]${level}]`));
    }
});

test('Studio\'s own MCP server is found where Roblox puts it, and an override wins', () => {
    const local = folder();
    fs.mkdirSync(path.join(local, 'Roblox'));
    fs.writeFileSync(path.join(local, 'Roblox', 'mcp.bat'), '@echo off\n');
    assert.deepEqual(findStudioMcp({ LOCALAPPDATA: local }, 'win32'), { command: 'cmd.exe', args: ['/c', path.join(local, 'Roblox', 'mcp.bat')], label: path.join(local, 'Roblox', 'mcp.bat') });
    assert.equal(findStudioMcp({ LOCALAPPDATA: folder() }, 'win32'), null);
    assert.equal(findStudioMcp({}, 'linux'), null);
    assert.deepEqual(findStudioMcp({ CODEV_ROBLOX_MCP: '/x/rbx-studio-mcp', CODEV_ROBLOX_MCP_ARGS: '--stdio' }, 'darwin'), { command: '/x/rbx-studio-mcp', args: ['--stdio'], label: '/x/rbx-studio-mcp' });
});

test('without Studio, status says how to turn its MCP server on and roblox_check still works', async () => {
    const dir = folder();
    const roblox = createRoblox({ getProjectDir: () => dir, env: { PATH: process.env.PATH } });
    if (process.platform === 'linux') {
        const status = textOf(await roblox.callTool('roblox_status'));
        assert.match(status, /Enable Studio as MCP server/);
        assert.match(status, /Luau compiler: ready/);
        const sync = await roblox.callTool('roblox_sync');
        assert.equal(sync.isError, true);
        assert.match(textOf(sync), /roblox_init_project/);
    }
    await roblox.callTool('roblox_init_project', { name: 'Obby' });
    const check = await roblox.callTool('roblox_check');
    assert.equal(check.isError, undefined, textOf(check));
    assert.match(textOf(check), /No problems in 3 script\(s\)/);
    const snippet = await roblox.callTool('roblox_check', { source: 'local me = game.Players.LocalPlayer\nwhile true do end', kind: 'server' });
    assert.equal(snippet.isError, true);
    assert.match(textOf(snippet), /line 1 \[error: server-local-player\]/);
    assert.match(textOf(snippet), /line 2 \[error: loop-without-wait\]/);
    assert.match(textOf(await roblox.callTool('roblox_init_project')), /already a Roblox project/);
    await roblox.close();
});

test('sync puts scripts into Studio as one undo step, refuses code that doesn\'t compile, and playtest reads the errors', async () => {
    const dir = folder();
    const { roblox, calls } = withStudio(dir);
    try {
        const status = textOf(await roblox.callTool('roblox_status'));
        assert.match(status, /Roblox Studio: connected/);
        assert.match(status, /execute_luau/);
        await roblox.callTool('roblox_init_project', { name: 'Coins' });
        const tricky = 'local s = [[a]] .. "]=]" -- ]==]\nreturn s\n';
        fs.writeFileSync(path.join(dir, 'src', 'shared', 'Tricky.luau'), tricky);

        const first = await roblox.callTool('roblox_sync');
        assert.equal(first.isError, undefined, textOf(first));
        assert.match(textOf(first), /Synced 4 script\(s\) into the open place: 4 new, 0 changed, 0 already up to date \(\+\d+ -0 lines\)/);
        assert.match(textOf(first), /src\/server\/Main\.server\.luau -> ServerScriptService\.Server\.Main \(Script, new\)/);
        const again = await roblox.callTool('roblox_sync');
        assert.match(textOf(again), /0 new, 0 changed, 4 already up to date/);

        // The source in Studio is byte for byte the file; the sync was one committed recording,
        // and the second sync had nothing to send.
        const read = await roblox.callTool('roblox_studio', { tool: 'execute_luau', args: { datamodel_type: 'Edit', code: 'print(game.ReplicatedStorage.Shared.Tricky.Source)\nlocal r = __codev_recordings()\nprint(#r, r[1].name, r[1].operation)' } });
        assert.equal(textOf(read), `${tricky}\n1 CoDev sync Coins Enum.FinishRecordingOperation.Commit`);

        // Every call to Studio carried the studio id from list_roblox_studios.
        assert.ok(calls().length >= 5);
        assert.ok(calls().filter(c => c.name !== 'list_roblox_studios').every(c => c.args.studio_id === 'studio-7f3a'));

        // A script that doesn't compile: nothing is sent to Studio.
        const before = calls().length;
        fs.writeFileSync(path.join(dir, 'src', 'server', 'Bad.server.luau'), 'local x = \n');
        const refused = await roblox.callTool('roblox_sync');
        assert.equal(refused.isError, true);
        assert.match(textOf(refused), /Nothing was synced: 1 script\(s\) don't compile[\s\S]*src\/server\/Bad\.server\.luau\n {2}line 2 \[error\]/);
        assert.equal(calls().length, before);
        fs.rmSync(path.join(dir, 'src', 'server', 'Bad.server.luau'));

        // A sync that fails in Studio is cancelled (rolled back), not left half done.
        await roblox.callTool('roblox_studio', { tool: 'execute_luau', args: { datamodel_type: 'Edit', code: 'local p = Instance.new("Part")\np.Name = "Blocker"\np.Parent = game.ServerScriptService.Server' } });
        fs.writeFileSync(path.join(dir, 'src', 'server', 'Blocker.server.luau'), 'print("x")\n');
        const blocked = await roblox.callTool('roblox_sync');
        assert.equal(blocked.isError, true);
        assert.match(textOf(blocked), /rolled back: .*already has a Part named Blocker/);
        const ops = textOf(await roblox.callTool('roblox_studio', { tool: 'execute_luau', args: { datamodel_type: 'Edit', code: 'local r = __codev_recordings()\nprint(r[#r].operation)' } }));
        assert.equal(ops, 'Enum.FinishRecordingOperation.Cancel');
        fs.rmSync(path.join(dir, 'src', 'server', 'Blocker.server.luau'));

        // A clean playtest: the server and client scripts ran, with the picture of the game view.
        const clean = await roblox.callTool('roblox_playtest', { seconds: 1 });
        assert.equal(clean.isError, undefined, textOf(clean));
        assert.match(textOf(clean), /no errors in the output[\s\S]*Server ready[\s\S]*Client ready for Player1/);
        assert.equal(clean.content[1].type, 'image');
        const plays = calls().filter(c => c.name === 'start_stop_play').map(c => c.args.mode);
        assert.deepEqual(plays, ['start_play', 'stop']);

        // A runtime error shows up with its script and line.
        fs.writeFileSync(path.join(dir, 'src', 'server', 'Door.server.luau'), 'local door = workspace:FindFirstChild("Door")\nprint(door.Name)\n');
        await roblox.callTool('roblox_sync', { files: ['src/server/Door.server.luau'] });
        const broken = await roblox.callTool('roblox_playtest', { seconds: 1, screenshot: false });
        assert.equal(broken.isError, true);
        assert.match(textOf(broken), /error line\(s\)/);
        assert.match(textOf(broken), /ServerScriptService\.Server\.Door"\]:2: attempt to index nil with 'Name'/);
        assert.equal(broken.content.length, 1);
        // Play stopped afterwards, so Studio is back in edit mode.
        assert.match(textOf(await roblox.callTool('roblox_studio', { tool: 'get_studio_state' })), /"mode":"Edit"/);
        assert.match(textOf(await roblox.callTool('roblox_studio', { tool: 'list' })), /search_game_tree: /);
        assert.match(textOf(await roblox.callTool('roblox_studio', { tool: 'nope' })), /has no tool "nope"/);
    } finally {
        await roblox.close();
    }
});

test('the studio pack covers the workflow, security, data and fair monetization', () => {
    assert.match(guide('start'), /roblox_check[\s\S]*roblox_sync[\s\S]*roblox_playtest/);
    assert.match(guide('monetization'), /ProcessReceipt[\s\S]*PurchaseGranted/);
    assert.match(guide('monetization'), /DevEx[\s\S]*web_search/);
    assert.match(guide('security'), /exploiter/);
    assert.match(guide('nonsense'), /^Topics: start, luau, security, data, monetization, performance, publish/);
});

test('roblox_diff shows line changes, and sync won\'t overwrite an edit made in Studio unless told to', async () => {
    const dir = folder();
    const { roblox } = withStudio(dir);
    try {
        await roblox.callTool('roblox_init_project', { name: 'Diffs' });
        await roblox.callTool('roblox_sync');
        const main = path.join(dir, 'src', 'server', 'Main.server.luau');
        fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace('print("Server ready")', 'print("Server ready!")\nprint("Version 2")'));
        fs.writeFileSync(path.join(dir, 'src', 'shared', 'Extra.luau'), 'return 1\n');
        const d = textOf(await roblox.callTool('roblox_diff'));
        assert.match(d, /1 new, 1 changed, 2 the same/);
        assert.match(d, /\+ src\/shared\/Extra\.luau -> ReplicatedStorage\.Shared\.Extra \(new ModuleScript, 2 lines\)/);
        assert.match(d, /~ src\/server\/Main\.server\.luau -> ServerScriptService\.Server\.Main: \+2 -1\n@@ line \d+\n[\s\S]*- print\("Server ready"\)\n\+ print\("Server ready!"\)\n\+ print\("Version 2"\)/);
        assert.doesNotMatch(d, /⚠/);
        const synced = textOf(await roblox.callTool('roblox_sync'));
        assert.match(synced, /1 new, 1 changed, 2 already up to date \(\+4 -1 lines\)/);

        // Someone edits the script in Studio: diff warns and sync refuses to overwrite it.
        await roblox.callTool('roblox_studio', { tool: 'execute_luau', args: { datamodel_type: 'Edit', code: 'local s = game.ServerScriptService.Server.Main\ns.Source = s.Source .. "print(\'edited in Studio\')\\n"' } });
        fs.writeFileSync(main, fs.readFileSync(main, 'utf8') + 'print("Version 3")\n');
        assert.match(textOf(await roblox.callTool('roblox_diff')), /⚠ edited in Studio since CoDev's last sync[\s\S]*- print\('edited in Studio'\)/);
        const refused = await roblox.callTool('roblox_sync');
        assert.equal(refused.isError, true);
        assert.match(textOf(refused), /Nothing was synced: 1 script\(s\)[\s\S]*src\/server\/Main\.server\.luau -> ServerScriptService\.Server\.Main \(edited in Studio\)/);
        const forced = await roblox.callTool('roblox_sync', { overwrite_studio_edits: true });
        assert.equal(forced.isError, undefined, textOf(forced));
        assert.match(textOf(forced), /0 new, 1 changed, 3 already up to date/);

        // A script that was already in the place (not from CoDev) is protected the same way.
        await roblox.callTool('roblox_studio', { tool: 'execute_luau', args: { datamodel_type: 'Edit', code: 'local s = Instance.new("ModuleScript")\ns.Name = "Theirs"\ns.Source = "return \'theirs\'"\ns.Parent = game.ReplicatedStorage.Shared' } });
        fs.writeFileSync(path.join(dir, 'src', 'shared', 'Theirs.luau'), 'return "mine"\n');
        assert.match(textOf(await roblox.callTool('roblox_sync')), /Theirs \(already in the place before CoDev synced\)/);
    } finally {
        await roblox.close();
    }
});

test('the obby, tycoon and simulator templates pass the checks and play clean, and the simulator trusts nothing from the client', async () => {
    for (const template of ['obby', 'tycoon', 'simulator']) {
        const dir = folder();
        const { roblox } = withStudio(dir);
        try {
            const made = textOf(await roblox.callTool('roblox_init_project', { template }));
            assert.match(made, new RegExp(`the ${template} template: .*src/server/PlayerData\\.luau`));
            const check = await roblox.callTool('roblox_check');
            assert.match(textOf(check), /No problems in 5 script\(s\)/, `${template}: ${textOf(check)}`);
            await roblox.callTool('roblox_sync');
            const play = await roblox.callTool('roblox_playtest', { seconds: 1, screenshot: false });
            assert.equal(play.isError, undefined, `${template}: ${textOf(play)}`);
            assert.match(textOf(play), { obby: /Obby ready: 10 stages/, tycoon: /Tycoon ready: 4 droppers/, simulator: /Simulator ready/ }[template]);
        } finally {
            await roblox.close();
        }
    }
    // The simulator's server side, driven like a client would (and like an exploiter would).
    const dir = folder();
    const { roblox } = withStudio(dir);
    try {
        await roblox.callTool('roblox_init_project', { template: 'simulator' });
        await roblox.callTool('roblox_sync');
        await roblox.callTool('roblox_studio', { tool: 'start_stop_play', args: { mode: 'start_play' } });
        const run = code => roblox.callTool('roblox_studio', { tool: 'execute_luau', args: { datamodel_type: 'Edit', code } }).then(textOf);
        // Spamming the remote counts once per cooldown; a fake rebirth without the strength does nothing.
        const out = await run('local r = game.ReplicatedStorage.Remotes\nfor i = 1, 50 do r.Train:FireServer(999999) end\nr.Rebirth:FireServer()\nlocal ls = game.Players.Player1.leaderstats\nprint(ls.Strength.Value, ls.Rebirths.Value, game.Players.Player1:GetAttribute("RebirthCost"))');
        assert.equal(out, '1 0 100');
        await roblox.callTool('roblox_studio', { tool: 'start_stop_play', args: { mode: 'stop' } });
    } finally {
        await roblox.close();
    }
});
