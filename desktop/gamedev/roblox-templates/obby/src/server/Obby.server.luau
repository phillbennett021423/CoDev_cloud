--!strict
-- An obby (obstacle course): platforms that climb, a kill brick in every gap, and a
-- checkpoint on each platform. A player's furthest stage is saved and they respawn there.
-- The course is built by this script so the template works in an empty Baseplate;
-- replace it with your own build any time (keep the "Stage" attribute on checkpoints).
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Config = require(ReplicatedStorage.Shared.Config)
local PlayerData = require(script.Parent.PlayerData)
local Monetization = require(script.Parent.Monetization)

local course = Instance.new("Folder")
course.Name = "Obby"

local checkpoints: { [number]: BasePart } = {}

local function makePart(name: string, x: number, y: number, size: { number }, color: Color3): Part
	local part = Instance.new("Part")
	part.Name = name
	part.Anchored = true
	part.Size = Vector3.new(size[1], size[2], size[3])
	part.Position = Vector3.new(x, y, 0)
	part.Color = color
	part.Parent = course
	return part
end

local start = makePart("Stage0", 0, 0, Config.PlatformSize, Color3.fromRGB(90, 200, 120))
start:SetAttribute("Stage", 0)
checkpoints[0] = start
for stage = 1, Config.StageCount do
	local platform = makePart("Stage" .. stage, stage * Config.StageSpacing, stage * Config.StageRise, Config.PlatformSize, Color3.fromRGB(240, 240, 240))
	platform:SetAttribute("Stage", stage)
	checkpoints[stage] = platform
	local lava = makePart("Kill" .. stage, (stage - 0.5) * Config.StageSpacing, (stage - 0.5) * Config.StageRise - 4, { Config.StageSpacing, 1, 12 }, Color3.fromRGB(255, 60, 40))
	lava.Material = Enum.Material.Neon
	lava:SetAttribute("Kills", true)
end
course.Parent = workspace

local function playerFromHit(hit: BasePart): Player?
	local character = hit.Parent
	if not character then
		return nil
	end
	return Players:GetPlayerFromCharacter(character)
end

local function setStage(player: Player, stage: number)
	PlayerData.Update(player, "Stage", function()
		return stage
	end)
	local leaderstats = player:FindFirstChild("leaderstats")
	local value = leaderstats and leaderstats:FindFirstChild("Stage")
	if value and value:IsA("IntValue") then
		value.Value = stage
	end
end

local function spawnAt(player: Player)
	local character = player.Character
	local data = PlayerData.Get(player)
	local checkpoint = data and checkpoints[data.Stage] or checkpoints[0]
	if character and checkpoint then
		character:PivotTo(checkpoint.CFrame + Vector3.new(0, 4, 0))
	end
end

for stage, part in checkpoints do
	part.Touched:Connect(function(hit)
		local player = playerFromHit(hit)
		local data = player and PlayerData.Get(player)
		-- Only the next stage counts, so nobody skips ahead by falling onto a later platform.
		if player and data and stage == data.Stage + 1 then
			setStage(player, stage)
		end
	end)
end

for _, part in course:GetChildren() do
	if part:GetAttribute("Kills") then
		(part :: BasePart).Touched:Connect(function(hit)
			local humanoid = hit.Parent and hit.Parent:FindFirstChildOfClass("Humanoid")
			if humanoid then
				humanoid.Health = 0
			end
		end)
	end
end

PlayerData.OnLoaded(function(player, data)
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	local stage = Instance.new("IntValue")
	stage.Name = "Stage"
	stage.Value = data.Stage
	stage.Parent = leaderstats
	leaderstats.Parent = player

	player.CharacterAdded:Connect(function(character)
		local humanoid = character:WaitForChild("Humanoid") :: Humanoid
		if Monetization.OwnsPass(player, Config.SpeedPassId) then
			humanoid.WalkSpeed = Config.SpeedPassWalkSpeed
		end
		task.defer(spawnAt, player)
	end)
	if player.Character then
		spawnAt(player)
	end
end)

Monetization.OnProduct(Config.SkipStageProductId, function(player)
	local data = PlayerData.Get(player)
	if not data or data.Stage >= Config.StageCount then
		return false
	end
	setStage(player, data.Stage + 1)
	spawnAt(player)
	return true
end)

PlayerData.Start({ Stage = 0 })
print(("Obby ready: %d stages"):format(Config.StageCount))
