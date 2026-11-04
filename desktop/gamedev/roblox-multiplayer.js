// Multiplayer playtests in Roblox Studio: a local server with 2 to 8 player clients, run
// through StudioTestService:ExecuteMultiplayerTestAsync (the API behind Test > Clients and
// Servers), so CoDev can see what breaks when several players join at once: errors that
// only show up on the second player, remotes that fire to the wrong client, data saved
// under the wrong key.
//
// How it works (all through Studio's execute_luau in the edit data model):
//   1. Two small scripts go into the place: a server Script that waits for the players,
//      lets the game run, asks every client for its output and ends the test with a report,
//      and a LocalScript that collects each client's output and answers.
//   2. ExecuteMultiplayerTestAsync starts the server and clients and returns the report
//      that the server script passed to StudioTestService:EndTest.
//   3. The two scripts are removed again, whatever happened.
//
//   multiplayerLuau({ players, seconds, nonce }) -> Luau for execute_luau
//   parseMultiplayer(output, nonce) -> { ok, error, joined, wanted, server: [line], clients: { name: [line] } }

const HARNESS = 'CodevTestHarness';
const CLIENT = 'CodevTestClient';
const REMOTE = 'CodevTestReport';

// Runs on the test server.
const SERVER_SOURCE = `-- Made by CoDev for one multiplayer test; CoDev removes it when the test ends.
local Players = game:GetService("Players")
local LogService = game:GetService("LogService")
local StudioTestService = game:GetService("StudioTestService")
local args = StudioTestService:GetTestArgs() or {}
local wanted = tonumber(args.players) or 2
local seconds = tonumber(args.seconds) or 5
local clients, answered = {}, 0
local report = Instance.new("RemoteEvent")
report.Name = "${REMOTE}"
report.OnServerEvent:Connect(function(player, name, lines)
	if typeof(lines) ~= "table" then return end
	local key = if typeof(name) == "string" then name else player.Name
	if clients[key] == nil then answered += 1 end
	clients[key] = lines
end)
report.Parent = game:GetService("ReplicatedStorage")
local waited = 0
while #Players:GetPlayers() < wanted and waited < 90 do waited += task.wait(0.5) end
local joined = #Players:GetPlayers()
task.wait(seconds)
report:FireAllClients()
waited = 0
while answered < joined and waited < 10 do waited += task.wait(0.25) end
-- The server's whole output since it started (LogService keeps it), newest 300 lines.
local server = {}
for _, entry in LogService:GetLogHistory() do
	local kind = if entry.messageType == Enum.MessageType.MessageError then "ERROR" elseif entry.messageType == Enum.MessageType.MessageWarning then "WARN" else "OUT"
	table.insert(server, kind .. " " .. entry.message)
end
while #server > 300 do table.remove(server, 1) end
StudioTestService:EndTest({ joined = joined, wanted = wanted, server = server, clients = clients })
`;

// Runs on every test client.
const CLIENT_SOURCE = `-- Made by CoDev for one multiplayer test; CoDev removes it when the test ends.
local Players = game:GetService("Players")
local LogService = game:GetService("LogService")
local me = Players.LocalPlayer
local report = game:GetService("ReplicatedStorage"):WaitForChild("${REMOTE}", 90)
if report then
	report.OnClientEvent:Connect(function()
		-- This client's whole output since it joined, newest 300 lines.
		local lines = {}
		for _, entry in LogService:GetLogHistory() do
			local kind = if entry.messageType == Enum.MessageType.MessageError then "ERROR" elseif entry.messageType == Enum.MessageType.MessageWarning then "WARN" else "OUT"
			table.insert(lines, kind .. " " .. entry.message)
		end
		while #lines > 300 do table.remove(lines, 1) end
		report:FireServer(me.Name, lines)
	end)
end
`;

function luauString(value) {
    // A long string whose level can't appear in the value.
    let eq = '';
    while (String(value).includes(`]${eq}]`)) eq += '=';
    return `[${eq}[\n${value}]${eq}]`;
}

function multiplayerLuau({ players = 2, seconds = 5, nonce }) {
    return `local out = "${nonce}"
local function say(...) print(out, ...) end
local function flat(s) return (string.gsub(tostring(s), "[\\r\\n]+", " / ")) end
local StudioTestService = game:GetService("StudioTestService")
local sss = game:GetService("ServerScriptService")
local sps = game:GetService("StarterPlayer"):FindFirstChildOfClass("StarterPlayerScripts")
for _, old in { sss:FindFirstChild("${HARNESS}"), sps and sps:FindFirstChild("${CLIENT}") } do old:Destroy() end
local server = Instance.new("Script")
server.Name = "${HARNESS}"
server.Source = ${luauString(SERVER_SOURCE)}
server.Parent = sss
local client = Instance.new("LocalScript")
client.Name = "${CLIENT}"
client.Source = ${luauString(CLIENT_SOURCE)}
client.Parent = sps
local ok, result = pcall(function()
	return StudioTestService:ExecuteMultiplayerTestAsync(${Number(players)}, { players = ${Number(players)}, seconds = ${Number(seconds)} })
end)
server:Destroy()
client:Destroy()
if not ok then say("failed", flat(result)) return end
if typeof(result) ~= "table" then say("failed", "the test ended without a report (it was stopped by hand, or the server script didn't run)") return end
say("joined", result.joined, result.wanted)
for _, line in result.server or {} do say("server", flat(line)) end
for name, lines in result.clients or {} do
	say("client", name, #lines)
	for _, line in lines do say("line", name, flat(line)) end
end
say("end")`;
}

function parseMultiplayer(output, nonce) {
    const out = { ok: false, error: '', joined: 0, wanted: 0, server: [], clients: {} };
    let ended = false;
    for (const raw of String(output).split(/\r?\n/)) {
        const at = raw.indexOf(nonce);
        if (at < 0) continue;
        const rest = raw.slice(at + nonce.length).replace(/^[\s\t]+/, '');
        const word = rest.split(/\s/, 1)[0];
        const after = rest.slice(word.length).replace(/^[ \t]/, '');
        if (word === 'failed') out.error = after.trim();
        else if (word === 'joined') { const [j, w] = after.trim().split(/\s+/).map(Number); out.joined = j || 0; out.wanted = w || 0; } else if (word === 'server') out.server.push(after);
        else if (word === 'client') { const name = after.trim().split(/\s+/)[0]; out.clients[name] = out.clients[name] || []; } else if (word === 'line') {
            const name = after.split(/[ \t]/, 1)[0];
            (out.clients[name] = out.clients[name] || []).push(after.slice(name.length).replace(/^[ \t]/, ''));
        } else if (word === 'end') ended = true;
    }
    out.ok = ended && !out.error;
    if (!ended && !out.error) out.error = 'Studio gave no report from the test.';
    return out;
}

module.exports = { multiplayerLuau, parseMultiplayer, SERVER_SOURCE, CLIENT_SOURCE, HARNESS, CLIENT, REMOTE };
