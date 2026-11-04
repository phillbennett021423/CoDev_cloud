#!/usr/bin/env node
// End-to-end check of CoDev's Roblox tools, the way an agent uses them: through
// server.js's agent-tools router, make a project, write a small coin game with a shop,
// check it, sync it into Studio, playtest, catch a bug, fix it, playtest again, and run a
// 3-player test (a local server and 3 clients).
//
//   node scripts/roblox-bridge-e2e.js           against the stand-in Studio (tests/fixtures)
//   node scripts/roblox-bridge-e2e.js --real    against Roblox Studio on this computer: open
//                                               an empty Baseplate first, with Assistant >
//                                               ... > Manage MCP Servers > "Enable Studio as
//                                               MCP server" turned on
//
// The project goes in a new temporary folder; nothing else on the computer is changed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const real = process.argv.includes('--real');
if (!real) {
    process.env.CODEV_ROBLOX_MCP = process.execPath;
    process.env.CODEV_ROBLOX_MCP_ARGS = JSON.stringify([path.join(__dirname, '..', 'tests', 'fixtures', 'fake-roblox-studio.js')]);
}

const GAME = {
    'src/shared/Config.luau': `--!strict
local Config = {
	CoinValue = 5,
	CoinCount = 3,
	Products = {
		[1001] = { coins = 100 },
	},
}

return Config
`,
    'src/server/Coins.server.luau': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(ReplicatedStorage.Shared.Config)

-- BUG on purpose: the place has no SpawnPad, so this line errors when the game runs.
local pad = workspace.SpawnPad

local coinsFolder = Instance.new("Folder")
coinsFolder.Name = "Coins"
coinsFolder.Parent = workspace

for i = 1, Config.CoinCount do
	local coin = Instance.new("Part")
	coin.Name = "Coin" .. i
	coin.Anchored = true
	coin.CanCollide = false
	coin.Parent = coinsFolder
end

print("Placed", #coinsFolder:GetChildren(), "coins near", pad.Name)
`,
    'src/server/Shop.server.luau': `--!strict
local MarketplaceService = game:GetService("MarketplaceService")
local Config = require(game:GetService("ReplicatedStorage").Shared.Config)

MarketplaceService.ProcessReceipt = function(info)
	local product = Config.Products[info.ProductId]
	local player = game:GetService("Players"):GetPlayerByUserId(info.PlayerId)
	if not product or not player then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	player.leaderstats.Coins.Value += product.coins
	return Enum.ProductPurchaseDecision.PurchaseGranted
end

print("Shop ready")
`
};

function show(step, result) {
    const body = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const images = result.content.filter(c => c.type === 'image').length;
    console.log(`\n=== ${step}${result.isError ? '  (reported a problem)' : ''}`);
    console.log(body.split('\n').map(l => `  ${l}`).join('\n'));
    if (images) console.log(`  [${images} picture(s) of the game view]`);
    return body;
}

function expect(ok, what) {
    if (!ok) { console.error(`\nFAILED: ${what}`); process.exitCode = 1; throw new Error(what); }
    console.log(`  ✓ ${what}`);
}

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-roblox-e2e-'));
    const { loadServices } = require('../agent-services');
    const router = await loadServices({ workspace: { root: dir } }, { log: () => {}, specs: [{ name: 'gamedev', module: path.join(__dirname, '..', 'agents', 'gamedev') }] });
    let id = 0;
    const call = async (name, args = {}) => (await router.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })).result;
    try {
        console.log(`Roblox end-to-end check against ${real ? 'Roblox Studio on this computer' : 'the stand-in Studio (real Luau VM, mock DataModel)'}\nProject folder: ${dir}`);
        let out = show('roblox_status', await call('roblox_status'));
        expect(/Roblox Studio: connected/.test(out), 'CoDev reached Studio through its MCP server');

        show('roblox_init_project', await call('roblox_init_project', { name: 'Coin Rush' }));
        for (const [rel, body] of Object.entries(GAME)) fs.writeFileSync(path.join(dir, rel), body);

        // A shop prompt with no receipt handler is caught before anything reaches Studio.
        fs.writeFileSync(path.join(dir, 'src/client/BuyButton.client.luau'), 'local MarketplaceService = game:GetService("MarketplaceService")\nlocal Players = game:GetService("Players")\nMarketplaceService:PromptProductPurchase(Players.LocalPlayer, 1001)\n');
        const shop = fs.readFileSync(path.join(dir, 'src/server/Shop.server.luau'), 'utf8');
        fs.rmSync(path.join(dir, 'src/server/Shop.server.luau'));
        out = show('roblox_check (shop without ProcessReceipt)', await call('roblox_check'));
        expect(/missing-process-receipt/.test(out), 'roblox_check catches a developer product nobody grants');
        fs.writeFileSync(path.join(dir, 'src/server/Shop.server.luau'), shop);
        out = show('roblox_check', await call('roblox_check'));
        expect(/0 error\(s\)|No problems/.test(out), 'the game passes the compiler and the Roblox rules');

        out = show('roblox_sync', await call('roblox_sync'));
        expect(/Synced 6 script\(s\)/.test(out), 'all six scripts went into the place as one undo step');

        out = show('roblox_playtest (with the bug)', await call('roblox_playtest', { seconds: 2 }));
        expect(/SpawnPad is not a valid member of Workspace/.test(out) && /Coins"?\]?:\d+|Server\.Coins/.test(out), 'the playtest caught the runtime error and named the script and line');

        // The fix an agent makes from that error: make the pad when the place has none.
        const coins = path.join(dir, 'src/server/Coins.server.luau');
        fs.writeFileSync(coins, fs.readFileSync(coins, 'utf8').replace(
            '-- BUG on purpose: the place has no SpawnPad, so this line errors when the game runs.\nlocal pad = workspace.SpawnPad\n',
            'local pad = workspace:FindFirstChild("SpawnPad")\nif not pad then\n\tpad = Instance.new("Part")\n\tpad.Name = "SpawnPad"\n\tpad.Anchored = true\n\tpad.Parent = workspace\nend\n'));
        out = show('roblox_check', await call('roblox_check'));
        expect(/0 error\(s\)|No problems/.test(out), 'the fix passes the checks');
        out = show('roblox_sync', await call('roblox_sync'));
        expect(/0 new, 1 changed, 5 already up to date/.test(out), 'only the changed script was updated');
        out = show('roblox_playtest (fixed)', await call('roblox_playtest', { seconds: 2 }));
        expect(/no errors in the output/.test(out) && /Placed\s+3\s+coins near\s+SpawnPad/.test(out) && /Shop ready/.test(out), 'the fixed game plays clean: coins placed, shop ready');

        out = show('roblox_playtest (3 players)', await call('roblox_playtest', { players: 3, seconds: 5 }));
        expect(/3 players joined\. No errors on the server or any client/.test(out) && /\[server\] OUT .*Shop ready/.test(out), 'a local server with 3 clients plays clean');

        console.log('\nAll checks passed.');
    } finally {
        await router.close();
    }
}

main().catch(err => { if (!process.exitCode) { console.error(err.stack || err); process.exitCode = 1; } });
