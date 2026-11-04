-- A small stand-in for Roblox's DataModel, run by the real Luau VM (luau-web) inside the
-- stand-in Roblox Studio (fake-roblox-studio.js). It has enough of the API for CoDev's
-- sync code and a starter game: instances with Name/Parent/children, services, signals,
-- value objects, scripts with Source, require, task, ChangeHistoryService and
-- ScriptEditorService. Unknown members raise Roblox's own error text, so a script that
-- uses something wrong fails here the way it would in Studio.
-- The host passes in: jsprint(line), jsload(source, chunkName) -> function | error string.

local function emit(line) jsprint(line) end
local function fmt(...)
	local t = table.pack(...)
	for i = 1, t.n do t[i] = tostring(t[i]) end
	return table.concat(t, " ")
end
print = function(...) emit(fmt(...)) end
warn = function(...) emit("WARN: " .. fmt(...)) end

local Enum = setmetatable({}, { __index = function(_, group)
	return setmetatable({}, { __index = function(_, item) return "Enum." .. group .. "." .. item end })
end })

-- Threads that yielded (task.wait, a handler that waits); Play resumes them in steps.
local threads = {}
local function resume(co, ...)
	local ok, err = coroutine.resume(co, ...)
	if not ok then emit("ERROR: " .. tostring(err)) elseif coroutine.status(co) == "suspended" then table.insert(threads, co) end
end

-- Signals ---------------------------------------------------------------------------
local function newSignal()
	local handlers = {}
	local signal = {}
	function signal:Connect(fn)
		table.insert(handlers, fn)
		return { Disconnect = function() table.remove(handlers, table.find(handlers, fn) or 0) end, Connected = true }
	end
	signal.Once = signal.Connect
	function signal:Wait() return coroutine.yield() end
	function signal:Fire(...)
		for _, fn in table.clone(handlers) do resume(coroutine.create(fn), ...) end
	end
	return signal
end

-- Instances ---------------------------------------------------------------------------
local EVENTS = { PlayerAdded = true, PlayerRemoving = true, Heartbeat = true, Stepped = true, RenderStepped = true,
	Touched = true, TouchEnded = true, Changed = true, ChildAdded = true, ChildRemoved = true, OnServerEvent = true,
	OnClientEvent = true, Died = true, Triggered = true, MouseClick = true, CharacterAdded = true, PromptProductPurchaseFinished = true,
	PromptGamePassPurchaseFinished = true, AncestryChanged = true, MouseButton1Click = true, Activated = true,
	Equipped = true, OnInvoke = true }
local DEFAULTS = {
	IntValue = { Value = 0 }, NumberValue = { Value = 0 }, StringValue = { Value = "" }, BoolValue = { Value = false }, ObjectValue = {},
	Script = { Source = "", Enabled = true }, LocalScript = { Source = "", Enabled = true }, ModuleScript = { Source = "" },
	Part = { Anchored = false, CanCollide = true, Transparency = 0 },
}
-- Properties that exist but start out nil.
local NILABLE = { Parent = true, Character = true, PrimaryPart = true, Adornee = true, Value = true }
local SCRIPTS = { Script = true, LocalScript = true, ModuleScript = true }

local state = setmetatable({}, { __mode = "k" }) -- instance -> { props, children, signals }
local Methods = {}
local game -- set below; remotes reach Players through it
local Inst = {}

local function fullName(inst)
	local s = state[inst]
	local parent = s.props.Parent
	if parent == nil or state[parent].props.ClassName == "DataModel" then return s.props.Name end
	return fullName(parent) .. "." .. s.props.Name
end

Inst.__index = function(inst, key)
	local s = state[inst]
	if Methods[key] then return Methods[key] end
	if s.props[key] ~= nil then return s.props[key] end
	if NILABLE[key] then return nil end
	for _, child in s.children do
		if state[child].props.Name == key then return child end
	end
	if EVENTS[key] then
		s.signals[key] = s.signals[key] or newSignal()
		return s.signals[key]
	end
	if s.extra and s.extra[key] ~= nil then return s.extra[key] end
	error(("%s is not a valid member of %s \"%s\""):format(tostring(key), s.props.ClassName, fullName(inst)), 2)
end
Inst.__newindex = function(inst, key, value)
	local s = state[inst]
	if key == "Parent" then
		local old = s.props.Parent
		if old then
			local siblings = state[old].children
			table.remove(siblings, table.find(siblings, inst) or 0)
		end
		s.props.Parent = value
		if value then table.insert(state[value].children, inst) end
		return
	end
	if key == "ClassName" then error("ClassName is read-only", 2) end
	local before = s.props[key]
	s.props[key] = value
	if before ~= value then
		if s.signals.Changed then s.signals.Changed:Fire(key) end
		if s.signals["prop:" .. key] then s.signals["prop:" .. key]:Fire() end
	end
end
Inst.__tostring = function(inst) return state[inst].props.Name end

local function new(className, extra)
	local inst = setmetatable({}, Inst)
	local props = { Name = className, ClassName = className }
	for k, v in DEFAULTS[className] or {} do props[k] = v end
	state[inst] = { props = props, children = {}, signals = {}, extra = extra }
	return inst
end

function Methods:FindFirstChild(name)
	for _, child in state[self].children do
		if state[child].props.Name == name then return child end
	end
	return nil
end
function Methods:WaitForChild(name)
	for _ = 1, 30 do
		local found = self:FindFirstChild(name)
		if found then return found end
		if not coroutine.isyieldable() then break end
		coroutine.yield()
	end
	emit(("WARN: Infinite yield possible on '%s:WaitForChild(\"%s\")'"):format(fullName(self), name))
	return nil
end
function Methods:FindFirstChildOfClass(className)
	for _, child in state[self].children do
		if state[child].props.ClassName == className then return child end
	end
	return nil
end
function Methods:GetChildren() return table.clone(state[self].children) end
function Methods:GetDescendants()
	local out = {}
	for _, child in state[self].children do
		table.insert(out, child)
		for _, d in child:GetDescendants() do table.insert(out, d) end
	end
	return out
end
function Methods:IsA(className)
	local mine = state[self].props.ClassName
	if className == mine or className == "Instance" then return true end
	if className == "LuaSourceContainer" then return SCRIPTS[mine] == true end
	if className == "BaseScript" then return mine == "Script" or mine == "LocalScript" end
	if className == "BasePart" then return mine == "Part" or mine == "MeshPart" end
	return false
end
function Methods:FindFirstChildWhichIsA(className, recursive)
	for _, child in (if recursive then self:GetDescendants() else state[self].children) do
		if child:IsA(className) then return child end
	end
	return nil
end
-- Models: a size and a scale, enough for CoDev's insert step.
function Methods:GetExtentsSize()
	local s = state[self].props._size or { X = 4, Y = 2, Z = 4 }
	local k = state[self].props._scale or 1
	return { X = s.X * k, Y = s.Y * k, Z = s.Z * k }
end
function Methods:GetScale() return state[self].props._scale or 1 end
function Methods:ScaleTo(k) state[self].props._scale = k end
function Methods:GetFullName() return fullName(self) end
function Methods:SetAttribute(name, value)
	local s = state[self]
	s.props._attrs = s.props._attrs or {}
	s.props._attrs[name] = value
	local signal = s.signals["attr:" .. name]
	if signal then signal:Fire() end
end
function Methods:GetAttributeChangedSignal(name)
	local s = state[self]
	s.signals["attr:" .. name] = s.signals["attr:" .. name] or newSignal()
	return s.signals["attr:" .. name]
end
function Methods:GetPropertyChangedSignal(name)
	local s = state[self]
	s.signals["prop:" .. name] = s.signals["prop:" .. name] or newSignal()
	return s.signals["prop:" .. name]
end
function Methods:GetAttribute(name) local a = state[self].props._attrs; return a and a[name] end
-- Remotes: a client's FireServer reaches OnServerEvent with the local player first.
function Methods:FireServer(...)
	local players = game:GetService("Players")
	self.OnServerEvent:Fire(players.LocalPlayer, ...)
end
function Methods:FireClient(player, ...) self.OnClientEvent:Fire(...) end
function Methods:FireAllClients(...) self.OnClientEvent:Fire(...) end
function Methods:InvokeServer(...)
	local fn = state[self].props.OnServerInvoke
	if not fn then error("OnServerInvoke is not set", 2) end
	return fn(game:GetService("Players").LocalPlayer, ...)
end
function Methods:Kick(message) emit("KICKED: " .. tostring(message)) end
local closers = {}
function Methods:BindToClose(fn) table.insert(closers, fn) end
function Methods:Destroy()
	for _, child in self:GetChildren() do child:Destroy() end
	self.Parent = nil
end
function Methods:ClearAllChildren() for _, child in self:GetChildren() do child:Destroy() end end
function Methods:Clone()
	local copy = new(state[self].props.ClassName)
	for k, v in state[self].props do if k ~= "Parent" and k ~= "ClassName" then state[copy].props[k] = v end end
	for _, child in state[self].children do child:Clone().Parent = copy end
	return copy
end

-- The DataModel and its services -----------------------------------------------------
game = new("DataModel")
game.Name = "Game"
game.JobId = ""
game.PlaceId = 0
local recordings = {}

local SERVICE_EXTRA = {
	Players = function(service)
		return {
			LocalPlayer = nil,
			GetPlayerFromCharacter = function(self2, character)
				for _, c in self2:GetChildren() do if c.ClassName == "Player" and c.Character == character then return c end end
				return nil
			end,
			GetPlayerByUserId = function(self2, id)
				for _, c in self2:GetChildren() do if c.ClassName == "Player" and c.UserId == id then return c end end
				return nil
			end,
			GetPlayers = function(self2)
				local out = {}
				for _, c in self2:GetChildren() do if c.ClassName == "Player" then table.insert(out, c) end end
				return out
			end,
		}
	end,
	Debris = function()
		return { AddItem = function(_, item) table.insert(threads, coroutine.create(function() coroutine.yield(); item:Destroy() end)) end }
	end,
	DataStoreService = function()
		local stores = {}
		return {
			GetDataStore = function(_, name)
				if stores[name] then return stores[name] end
				local data = {}
				local store = {}
				function store:GetAsync(key) return data[key] end
				function store:SetAsync(key, value) data[key] = value end
				function store:UpdateAsync(key, fn) local v = fn(data[key]); if v ~= nil then data[key] = v end; return v end
				function store:RemoveAsync(key) local v = data[key]; data[key] = nil; return v end
				stores[name] = store
				return store
			end,
		}
	end,
	ChangeHistoryService = function()
		return {
			TryBeginRecording = function(_, name) table.insert(recordings, { name = name }); return #recordings end,
			FinishRecording = function(_, id, operation) recordings[id].operation = operation end,
			SetWaypoint = function() end,
		}
	end,
	ScriptEditorService = function()
		return { UpdateSourceAsync = function(_, script, fn) script.Source = fn(script.Source) end }
	end,
	RunService = function()
		return { IsServer = function() return true end, IsClient = function() return false end, IsStudio = function() return true end }
	end,
	-- LoadAsset: a decal (odd ids) holds its image, one id lower; a model (even ids) is 4x10x4.
	InsertService = function()
		return {
			LoadAsset = function(_, id)
				local holder = new("Model")
				if id % 2 == 1 then
					local d = new("Decal")
					d.Texture = "rbxassetid://" .. tostring(id - 1)
					d.Parent = holder
				else
					local m = new("Model")
					m.Name = "Asset" .. tostring(id)
					state[m].props._size = { X = 4, Y = 10, Z = 4 }
					m.Parent = holder
				end
				return holder
			end,
		}
	end,
	MarketplaceService = function()
		return { UserOwnsGamePassAsync = function() return false end, PromptProductPurchase = function() end, PromptGamePassPurchase = function() end }
	end,
}

function Methods:GetService(name)
	local found = self:FindFirstChild(name)
	if found then return found end
	local service = new(name)
	if SERVICE_EXTRA[name] then state[service].extra = SERVICE_EXTRA[name](service) end
	service.Parent = self
	return service
end
for _, name in { "Workspace", "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterPlayer", "StarterGui", "Lighting", "Players" } do
	game:GetService(name)
end
do
	local sps = new("StarterPlayerScripts")
	sps.Parent = game:GetService("StarterPlayer")
end

-- Running scripts ---------------------------------------------------------------------
local modules = {}
local baseEnv

local task = {
	wait = function(n) coroutine.yield(); return n or 0 end,
	spawn = function(fn, ...) local co = coroutine.create(fn); resume(co, ...); return co end,
	defer = function(fn, ...) local co = coroutine.create(fn); table.insert(threads, co); return co end,
	delay = function(_, fn, ...) local co = coroutine.create(fn); table.insert(threads, co); return co end,
}
task.cancel = function() end

local function load(source, chunkName, script)
	local fn = jsload(source, chunkName)
	if type(fn) == "string" then error(fn, 0) end
	setfenv(fn, setmetatable({ script = script }, { __index = baseEnv }))
	return fn
end

local function requireModule(module)
	if type(module) ~= "table" or not state[module] or module.ClassName ~= "ModuleScript" then
		error("Attempted to call require with invalid argument(s).", 2)
	end
	if modules[module] == nil then
		modules[module] = load(module.Source, module:GetFullName(), module)()
	end
	return modules[module]
end

baseEnv = setmetatable({
	game = game, workspace = game:GetService("Workspace"), Instance = { new = function(className, parent) local i = new(className); if parent then i.Parent = parent end; return i end },
	Enum = Enum, task = task, require = requireModule, print = print, warn = warn,
	wait = task.wait, spawn = task.spawn, delay = task.delay, tick = os.clock, time = os.clock,
	Vector3 = { new = function(x, y, z) return { X = x or 0, Y = y or 0, Z = z or 0 } end },
	UDim2 = { new = function(...) return { ... } end, fromScale = function(...) return { ... } end, fromOffset = function(...) return { ... } end },
	BrickColor = { new = function(n) return { Name = n } end },
	Color3 = { fromRGB = function(r, g, b) return { R = r / 255, G = g / 255, B = b / 255 } end, new = function(r, g, b) return { R = r, G = g, B = b } end },
	CFrame = { new = function(...) return { ... } end },
}, { __index = getfenv(0) })

local function runScript(script)
	local fn = load(script.Source, script:GetFullName(), script)
	local co = coroutine.create(fn)
	local ok, err = coroutine.resume(co)
	if not ok then
		emit("ERROR: " .. tostring(err))
		emit("Stack Begin")
		emit(("Script '%s'"):format(script:GetFullName()))
		emit("Stack End")
	elseif coroutine.status(co) == "suspended" then
		table.insert(threads, co)
	end
end

local function step()
	local now = threads
	threads = {}
	for _, co in now do
		if coroutine.status(co) == "suspended" then resume(co) end
	end
	game:GetService("RunService").Heartbeat:Fire(1 / 60)
end

local playing = false
local playerOne

function __codev_play()
	playing = true
	modules = {}
	local players = game:GetService("Players")
	for _, root in { game:GetService("ServerScriptService"), game:GetService("Workspace") } do
		for _, d in root:GetDescendants() do
			if d.ClassName == "Script" and d.Enabled ~= false then runScript(d) end
		end
	end
	playerOne = new("Player")
	playerOne.Name = "Player1"
	playerOne.UserId = 1
	local gui = new("PlayerGui")
	gui.Parent = playerOne
	playerOne.Parent = players
	state[players].extra.LocalPlayer = playerOne
	players.PlayerAdded:Fire(playerOne)
	local sps = game:GetService("StarterPlayer"):FindFirstChild("StarterPlayerScripts")
	if sps then for _, d in sps:GetDescendants() do if d.ClassName == "LocalScript" then runScript(d) end end end
	for _ = 1, 20 do step() end
end

function __codev_stop()
	-- Like Roblox: players leave first, then BindToClose runs as the server shuts down.
	if playerOne then game:GetService("Players").PlayerRemoving:Fire(playerOne) end
	for _ = 1, 5 do step() end
	for _, fn in closers do resume(coroutine.create(fn)) end
	for _ = 1, 5 do step() end
	playing = false
	threads = {}
	if playerOne then playerOne:Destroy(); playerOne = nil end
	state[game:GetService("Players")].extra.LocalPlayer = nil
end

function __codev_playing() return playing end

function __codev_run(source)
	local fn = load(source, "CommandBar", nil)
	return fn()
end

function __codev_recordings() return recordings end

function __codev_tree(inst, depth)
	inst = inst or game
	depth = depth or 0
	local lines = {}
	for _, child in inst:GetChildren() do
		table.insert(lines, string.rep("  ", depth) .. child.Name .. " (" .. child.ClassName .. ")")
		for _, l in __codev_tree(child, depth + 1) do table.insert(lines, l) end
	end
	return lines
end

-- Tests read a script's source back by its full name.
function __codev_source(path)
	local inst = game
	for name in string.gmatch(path, "[^%.]+") do
		inst = inst:FindFirstChild(name)
		if not inst then return nil end
	end
	return inst.Source
end
