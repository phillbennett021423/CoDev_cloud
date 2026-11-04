// The Roblox studio pack: what CoDev's agents follow when they make a Roblox game.
// roblox_guide returns one topic at a time so an agent reads only what the job needs.
// Numbers that Roblox changes (DevEx rate, payout rules) say to check the live page.

const TOPICS = {
    start: `# Making a Roblox game with CoDev

1. roblox_status: is Roblox Studio open with its MCP server on, and is there a project folder?
2. roblox_init_project once per game (template obby, tycoon or simulator gives a whole working starter game with safe saving and purchases): a Rojo-style folder (default.project.json and src/server, src/client, src/shared), so the game's code lives in files CoDev can check, undo (checkpoint_create) and keep in git.
3. Write scripts as files: Name.server.luau is a Script, Name.client.luau a LocalScript, Name.luau a ModuleScript. Shared code goes in src/shared (ReplicatedStorage.Shared) and is required from both sides.
4. roblox_check after every change: the real Luau compiler plus CoDev's Roblox rules. Fix every error before going on.
5. roblox_diff shows what a sync would change, line by line, when the user wants to review first. roblox_sync puts the changed scripts into the open place, as one step the user can undo with Ctrl+Z in Studio. It won't overwrite a script someone edited in Studio; copy that edit into the file, or pass overwrite_studio_edits if it should go.
6. Art and sound: roblox_export_model fits a model to Roblox's limits (20,000 triangles per mesh, 4 bone weights per vertex, 1024 textures), roblox_asset_check confirms it, roblox_upload puts it on Roblox and writes its id into src/shared/Assets.luau, so scripts use require(ReplicatedStorage.Shared.Assets).Name. Animations upload as .rbxm from Studio's Animation Editor; a .fbx animation goes in through Studio's 3D Importer.
7. Build the world in Studio with roblox_studio (execute_luau to place parts and models, search_game_tree and inspect_instance to look, insert_asset for Creator Store models, generate_mesh / generate_material where offered).
8. roblox_playtest: press Play, read every error, look at the screenshot, stop. Fix and repeat until it runs clean and looks right. Never tell the user it works before a clean playtest.

Plan the core loop first (what the player does every 30 seconds, and why they come back tomorrow), build that, playtest it, then add content and monetization.

Game types that do well on Roblox: obby (obstacle course), tycoon, simulator (click, collect, upgrade, rebirth), tower defense, roleplay/hangout, horror, fighting/battlegrounds, story games, and social party games. Short sessions, friends playing together and visible progress matter more than graphics.`,

    luau: `# Luau on Roblox: the house style

- Start every script with --!strict where practical and type function parameters; it catches bugs before Play.
- local Players = game:GetService("Players") at the top; never game.Players in hot code paths.
- task.wait / task.spawn / task.delay / task.defer, never wait / spawn / delay.
- Instance.new(class), set properties, set Parent last.
- WaitForChild for things that replicate in (client side), FindFirstChild with a nil check otherwise.
- Connections: keep the RBXScriptConnection and :Disconnect() it when the object goes away; use Destroy() on instances you make so they don't leak.
- Use ModuleScripts for shared logic and config (prices, levels, item stats) so numbers live in one place.
- Physics and movement on the client are owned by that player; anything that matters (currency, damage, inventory, purchases) is decided on the server.
- CollectionService tags plus one script per tag beat one script copied into every part.
- RunService.Heartbeat for per-frame server logic; RenderStepped only on the client for camera and visuals.`,

    security: `# Security: assume every client is an exploiter

- The client can fire any RemoteEvent with any arguments, any number of times. On the server, check each argument's type (typeof), range and ownership, and rate-limit per player.
- Never accept prices, damage, rewards, positions to teleport to, or "I won" from the client. The client asks; the server decides.
- Keep secrets and server logic in ServerScriptService and ServerStorage; anything in ReplicatedStorage or the Workspace can be read by the player.
- Don't use RemoteFunction:InvokeClient on the server (a client can hang it forever).
- Check distance on the server for interactions (the player must actually be near the shop, chest or NPC).
- Filter any text players type that other players will see with TextService:FilterStringAsync (chat itself is filtered by Roblox).
- No loadstring, no require(assetId) of other people's modules, no free models with scripts you haven't read (they are a common way backdoors get into games).`,

    data: `# Saving player data

- DataStoreService on the server only. Wrap every call in pcall with retries and backoff; they fail and throttle sometimes.
- Load on PlayerAdded, save on PlayerRemoving and in game:BindToClose (give it time to finish), plus autosave every few minutes.
- One key per player (the UserId), one table per player with a version number so you can migrate the format later.
- UpdateAsync instead of SetAsync when the value may change in two servers at once.
- Session-lock or use a proven pattern so a player joining a new server before the old one saved doesn't lose progress.
- Don't save on every coin pickup; keep data in memory and save on the schedule above.
- Studio playtests need "Enable Studio Access to API Services" in Game Settings > Security to use DataStores.`,

    monetization: `# Making money on Roblox (fair, and within Roblox's rules)

Ways a game earns Robux:
- Game passes: a one-time purchase for a permanent perk (VIP area, 2x coins, a gear, a cosmetic slot). Check ownership on the server with MarketplaceService:UserOwnsGamePassAsync and also handle PromptGamePassPurchaseFinished so the perk starts right away.
- Developer products: things bought again and again (coins, revives, boosts, skips). They MUST be granted by one MarketplaceService.ProcessReceipt callback in a server Script that saves the grant and returns Enum.ProductPurchaseDecision.PurchaseGranted only after the save works (NotProcessedYet otherwise, so Roblox retries). Without it, players pay and get nothing. roblox_check flags this.
- Subscriptions: a monthly perk sold through Roblox's subscriptions feature, for games with a reason to come back every day.
- Private servers (paid access to a server for friends) for social and roleplay games.
- Creator Rewards: Roblox pays for daily engagement of spending users and for bringing new or lapsed players into the platform (share links help). It replaced the older engagement-based payouts; check the current rules on create.roblox.com.
- Ads: Roblox's own ads products (immersive and rewarded video ads) where the experience is eligible.
- UGC items and avatar items if the user is in the UGC program.

How much the creator keeps: Roblox takes about 30% of game pass and developer product sales, so the creator gets about 70% of the Robux. The Developer Exchange (DevEx) cashes earned Robux out for real money once the account is eligible (13+, ID-verified, an earned-Robux minimum, in good standing, tax form). The DevEx rate changes; look up the current rate with web_search before quoting a dollar figure.

Pricing and design rules of thumb:
- Sell convenience, cosmetics and time saved, not wins. Pay-to-win drives players away and hurts the game's ratings.
- Offer a cheap first purchase (around 25 to 99 Robux) and a small number of clear bigger ones. Show the value in the shop UI.
- Put the shop button where players already look, prompt at natural moments (after a win, when they run out), never pop up purchase prompts unasked or repeatedly.
- Paid random items (loot boxes): Roblox requires showing the odds, and some countries restrict them. Prefer direct purchases.
- Never ask players for real money, passwords or anything outside Roblox's own purchase prompts, and don't target or pressure young players.
- Test purchases in Studio (they're free in Studio test mode) before publishing.`,

    performance: `# Performance budgets

- Mobile players are the majority: test the game on a phone-sized screen and keep it running on low-end devices.
- Fewer, bigger parts beat thousands of small ones; anchor everything that doesn't move; turn off CanCollide/CanTouch/CanQuery where unused.
- MeshParts: Roblox caps a mesh at 20,000 triangles; aim for far fewer (roblox_export_model decimates to a budget) and reuse meshes so they're instanced.
- Textures: Roblox downscales images to at most 1024x1024; use smaller ones where they're small on screen.
- StreamingEnabled for big maps; design with parts loading in (WaitForChild on the client).
- Don't run per-frame loops for things events can do (Touched, ProximityPrompt, Changed).
- Use the MicroProfiler and Developer Console (F9) during roblox_playtest when the frame rate drops.`,

    publish: `# Publishing checklist

- Clean roblox_playtest on the server and client, no errors in the output.
- Game icon (512x512) and thumbnails (1920x1080) that show the actual gameplay; a clear name and a description that says what you do in the game.
- Maturity and compliance questionnaire filled in honestly (Roblox shows the experience's content label from it).
- Game passes and developer products created on the Creator Dashboard with their IDs in a config ModuleScript, and every purchase path tested.
- Settings: allowed devices (phone, tablet, console, computer), max players, server fill, private servers.
- Test with real players (friends) before advertising; watch retention (day 1 and day 7) and session length on the Creator Dashboard analytics, then improve the core loop first.
- Update often: new content and events bring players back, and update logs in the game help.`
};

function guide(topic) {
    const key = String(topic || '').toLowerCase().trim();
    if (TOPICS[key]) return TOPICS[key];
    return `Topics: ${Object.keys(TOPICS).join(', ')}.\n\n${TOPICS.start}`;
}

module.exports = { guide, TOPICS };
