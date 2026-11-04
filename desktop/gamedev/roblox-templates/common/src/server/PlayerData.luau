--!strict
-- Player data that doesn't get lost: the ProfileService idea, kept small enough to read.
--  * Loads with retries, and locks each player's save to one server at a time, so two
--    servers can't overwrite each other when a player hops servers.
--  * Autosaves every two minutes, and saves when the player leaves and when the server
--    shuts down (BindToClose).
--  * Every save goes through UpdateAsync inside pcall, with backoff.
--
-- PlayerData.Start(defaults)          call once from a server Script
-- PlayerData.Get(player)              the player's data table, or nil while loading
-- PlayerData.Update(player, key, fn)  data[key] = fn(data[key]); returns the new value
-- PlayerData.OnLoaded(fn)             fn(player, data) when a player's data is ready
-- PlayerData.SaveNow(player)          save right away (after a purchase); true when it saved
--
-- Studio playtests need Game Settings > Security > "Enable Studio Access to API Services".
local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")

local STORE_NAME = "PlayerData_v1"
local AUTOSAVE_SECONDS = 120
local LOCK_SECONDS = 300

local PlayerData = {}

type Session = { data: { [string]: any }, key: string }
local sessions: { [Player]: Session } = {}
local loadedCallbacks: { (Player, { [string]: any }) -> () } = {}
local defaults: { [string]: any } = {}
local store = DataStoreService:GetDataStore(STORE_NAME)

local function deepCopy(value: any): any
	if type(value) ~= "table" then
		return value
	end
	local copy = {}
	for k, v in value do
		copy[k] = deepCopy(v)
	end
	return copy
end

-- Runs fn in pcall up to five times, waiting longer after each failure.
local function retry(what: string, fn: () -> any): (boolean, any)
	for attempt = 1, 5 do
		local ok, result = pcall(fn)
		if ok then
			return true, result
		end
		warn(("PlayerData: %s failed (attempt %d): %s"):format(what, attempt, tostring(result)))
		task.wait(2 ^ attempt)
	end
	return false, nil
end

local function load(player: Player)
	local key = "player_" .. player.UserId
	local record = nil
	for _ = 1, 6 do
		local ok, result = retry("load", function()
			return store:UpdateAsync(key, function(old)
				local saved = old or { data = {} }
				local lock = saved.lock
				if lock and lock.job ~= game.JobId and os.time() - lock.time < LOCK_SECONDS then
					return nil -- another server still has it; try again shortly
				end
				saved.lock = { job = game.JobId, time = os.time() }
				return saved
			end)
		end)
		if not ok then
			break
		end
		if result then
			record = result
			break
		end
		task.wait(5)
	end
	if not player.Parent then
		return -- left while loading
	end
	if not record then
		player:Kick("Your data couldn't be loaded. Please rejoin in a moment.")
		return
	end
	local data = deepCopy(record.data or {})
	for k, v in defaults do
		if data[k] == nil then
			data[k] = deepCopy(v)
		end
	end
	sessions[player] = { data = data, key = key }
	for _, fn in loadedCallbacks do
		task.spawn(fn, player, data)
	end
end

local function save(player: Player, release: boolean): boolean
	local session = sessions[player]
	if not session then
		return false
	end
	local snapshot = deepCopy(session.data)
	local ok = retry("save", function()
		return store:UpdateAsync(session.key, function(old)
			local saved = old or {}
			if saved.lock and saved.lock.job ~= game.JobId then
				return nil -- another server took over; don't overwrite its newer data
			end
			saved.data = snapshot
			saved.lock = if release then nil else { job = game.JobId, time = os.time() }
			return saved
		end)
	end)
	if release then
		sessions[player] = nil
	end
	return ok
end

function PlayerData.SaveNow(player: Player): boolean
	return save(player, false)
end

function PlayerData.Get(player: Player): { [string]: any }?
	local session = sessions[player]
	return session and session.data
end

function PlayerData.Update(player: Player, key: string, fn: (any) -> any): any
	local session = sessions[player]
	if not session then
		return nil
	end
	session.data[key] = fn(session.data[key])
	return session.data[key]
end

function PlayerData.OnLoaded(fn: (Player, { [string]: any }) -> ())
	table.insert(loadedCallbacks, fn)
	for player, session in sessions do
		task.spawn(fn, player, session.data)
	end
end

function PlayerData.Start(newDefaults: { [string]: any })
	defaults = newDefaults
	Players.PlayerAdded:Connect(load)
	for _, player in Players:GetPlayers() do
		task.spawn(load, player)
	end
	Players.PlayerRemoving:Connect(function(player)
		save(player, true)
	end)
	game:BindToClose(function()
		for _, player in Players:GetPlayers() do
			task.spawn(save, player, true)
		end
		task.wait(3)
	end)
	task.spawn(function()
		while true do
			task.wait(AUTOSAVE_SECONDS)
			for player in sessions do
				task.spawn(save, player, false)
			end
		end
	end)
end

return PlayerData
