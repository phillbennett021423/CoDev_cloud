--!strict
-- A clicker simulator: players train to gain Strength, then rebirth to reset it for a
-- permanent bonus. The client only asks ("train", "rebirth"); the server checks the cooldown
-- and the cost, does the math and saves it, so an exploiter firing the remotes gains nothing.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(ReplicatedStorage.Shared.Config)
local PlayerData = require(script.Parent.PlayerData)
local Monetization = require(script.Parent.Monetization)

local remotes = Instance.new("Folder")
remotes.Name = "Remotes"
local train = Instance.new("RemoteEvent")
train.Name = "Train"
train.Parent = remotes
local rebirth = Instance.new("RemoteEvent")
rebirth.Name = "Rebirth"
rebirth.Parent = remotes
remotes.Parent = ReplicatedStorage

local lastTrain: { [Player]: number } = {}

local function rebirthCost(rebirths: number): number
	return math.floor(Config.RebirthCost * Config.RebirthCostGrowth ^ rebirths)
end

local function show(player: Player, data: { [string]: any })
	local leaderstats = player:FindFirstChild("leaderstats")
	if not leaderstats then
		return
	end
	local strength = leaderstats:FindFirstChild("Strength")
	local rebirths = leaderstats:FindFirstChild("Rebirths")
	if strength and strength:IsA("IntValue") then
		strength.Value = data.Strength
	end
	if rebirths and rebirths:IsA("IntValue") then
		rebirths.Value = data.Rebirths
	end
	player:SetAttribute("RebirthCost", rebirthCost(data.Rebirths))
end

local function gain(player: Player, amount: number)
	local data = PlayerData.Get(player)
	if not data then
		return
	end
	data.Strength += amount
	show(player, data)
end

-- No arguments are read from the client: only the time between requests matters.
train.OnServerEvent:Connect(function(player)
	local now = os.clock()
	if now - (lastTrain[player] or 0) < Config.TrainCooldown then
		return
	end
	lastTrain[player] = now
	local data = PlayerData.Get(player)
	if not data then
		return
	end
	local perClick = Config.StrengthPerClick * (1 + data.Rebirths * Config.RebirthBonus)
	if Monetization.OwnsPass(player, Config.DoubleStrengthPassId) then
		perClick *= 2
	end
	gain(player, math.floor(perClick))
end)

rebirth.OnServerEvent:Connect(function(player)
	local data = PlayerData.Get(player)
	if not data or data.Strength < rebirthCost(data.Rebirths) then
		return
	end
	data.Strength = 0
	data.Rebirths += 1
	show(player, data)
end)

Players.PlayerRemoving:Connect(function(player)
	lastTrain[player] = nil
end)

PlayerData.OnLoaded(function(player, data)
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	for _, name in { "Strength", "Rebirths" } do
		local value = Instance.new("IntValue")
		value.Name = name
		value.Parent = leaderstats
	end
	leaderstats.Parent = player
	show(player, data)
end)

Monetization.OnProduct(Config.BoostProductId, function(player)
	if not PlayerData.Get(player) then
		return false
	end
	gain(player, Config.BoostAmount)
	return true
end)

PlayerData.Start({ Strength = 0, Rebirths = 0 })
print("Simulator ready")
