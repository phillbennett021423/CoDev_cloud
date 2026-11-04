--!strict
-- A one-plot tycoon: step on the claim pad to own the plot, droppers make cash on a timer,
-- and buy buttons (step on them) unlock better droppers. Cash and owned droppers are saved.
-- Everything is decided on the server: prices, ownership and cash never come from a client.
-- The plot is built by this script so the template works in an empty Baseplate.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Debris = game:GetService("Debris")
local Config = require(ReplicatedStorage.Shared.Config)
local PlayerData = require(script.Parent.PlayerData)
local Monetization = require(script.Parent.Monetization)

local plot = Instance.new("Model")
plot.Name = "TycoonPlot"
local owner: Player? = nil

local function makePart(name: string, x: number, z: number, size: { number }, color: Color3): Part
	local part = Instance.new("Part")
	part.Name = name
	part.Anchored = true
	part.Size = Vector3.new(size[1], size[2], size[3])
	part.Position = Vector3.new(x, size[2] / 2, z)
	part.Color = color
	part.Parent = plot
	return part
end

local claim = makePart("ClaimPad", 0, -12, { 6, 1, 6 }, Color3.fromRGB(80, 160, 255))
local droppers: { [number]: Part } = {}
local buttons: { [number]: Part } = {}
for i, info in Config.Droppers do
	local dropper = makePart("Dropper" .. i, (i - 1) * 8, 0, { 3, 6, 3 }, Color3.fromRGB(120, 120, 120))
	dropper.Transparency = 0.8
	droppers[i] = dropper
	if info.price > 0 then
		local button = makePart("Buy" .. i, (i - 1) * 8, 8, { 4, 1, 4 }, Color3.fromRGB(60, 220, 90))
		button:SetAttribute("Price", info.price)
		buttons[i] = button
	end
end
plot.Parent = workspace

local function playerFromHit(hit: BasePart): Player?
	local character = hit.Parent
	return character and Players:GetPlayerFromCharacter(character) or nil
end

local function cashValue(player: Player): IntValue?
	local leaderstats = player:FindFirstChild("leaderstats")
	local cash = leaderstats and leaderstats:FindFirstChild("Cash")
	return if cash and cash:IsA("IntValue") then cash else nil
end

local function addCash(player: Player, amount: number)
	local total = PlayerData.Update(player, "Cash", function(cash)
		return cash + amount
	end)
	local value = cashValue(player)
	if value and total then
		value.Value = total
	end
end

local function showOwned(data: { [string]: any })
	for i, dropper in droppers do
		local owned = Config.Droppers[i].price == 0 or data.Owned[tostring(i)] == true
		dropper.Transparency = if owned then 0 else 0.8
		local button = buttons[i]
		if button then
			button.Transparency = if owned then 1 else 0
			button.CanCollide = not owned
		end
	end
end

claim.Touched:Connect(function(hit)
	local player = playerFromHit(hit)
	local data = player and PlayerData.Get(player)
	if player and data and owner == nil then
		owner = player
		claim.Color = Color3.fromRGB(255, 200, 60)
		showOwned(data)
	end
end)

for i, button in buttons do
	button.Touched:Connect(function(hit)
		local player = playerFromHit(hit)
		local data = player and PlayerData.Get(player)
		if not player or not data or player ~= owner or data.Owned[tostring(i)] then
			return
		end
		local price = Config.Droppers[i].price
		if data.Cash < price then
			return
		end
		addCash(player, -price)
		data.Owned[tostring(i)] = true
		showOwned(data)
	end)
end

-- The droppers: each owned one drops a block worth its value; the cash goes to the owner.
task.spawn(function()
	while true do
		task.wait(Config.DropInterval)
		local player = owner
		local data = player and PlayerData.Get(player)
		if player and data then
			local multiplier = if Monetization.OwnsPass(player, Config.DoubleCashPassId) then 2 else 1
			for i, info in Config.Droppers do
				if info.price == 0 or data.Owned[tostring(i)] then
					local drop = Instance.new("Part")
					drop.Size = Vector3.new(1, 1, 1)
					drop.Position = Vector3.new(droppers[i].Position.X, 8, 0)
					drop.Parent = workspace
					Debris:AddItem(drop, 3)
					addCash(player, info.value * multiplier)
				end
			end
		end
	end
end)

Players.PlayerRemoving:Connect(function(player)
	if player == owner then
		owner = nil
		claim.Color = Color3.fromRGB(80, 160, 255)
	end
end)

PlayerData.OnLoaded(function(player, data)
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	local cash = Instance.new("IntValue")
	cash.Name = "Cash"
	cash.Value = data.Cash
	cash.Parent = leaderstats
	leaderstats.Parent = player
end)

Monetization.OnProduct(Config.CashPackProductId, function(player)
	if not PlayerData.Get(player) then
		return false
	end
	addCash(player, Config.CashPackAmount)
	return true
end)

PlayerData.Start({ Cash = 0, Owned = {} })
print(("Tycoon ready: %d droppers"):format(#Config.Droppers))
