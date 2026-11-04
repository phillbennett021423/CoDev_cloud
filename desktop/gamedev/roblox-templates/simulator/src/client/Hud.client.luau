--!strict
-- The simulator's buttons: Train and Rebirth. They only ask the server; the server decides.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local player = Players.LocalPlayer
local remotes = ReplicatedStorage:WaitForChild("Remotes")
local train = remotes:WaitForChild("Train") :: RemoteEvent
local rebirth = remotes:WaitForChild("Rebirth") :: RemoteEvent

local gui = Instance.new("ScreenGui")
gui.Name = "SimulatorHud"
gui.ResetOnSpawn = false

local function button(text: string, y: number): TextButton
	local b = Instance.new("TextButton")
	b.Size = UDim2.fromOffset(200, 56)
	b.Position = UDim2.new(0.5, -100, 1, y)
	b.TextScaled = true
	b.Text = text
	b.Parent = gui
	return b
end

local trainButton = button("💪 Train", -140)
local rebirthButton = button("🔁 Rebirth", -76)
gui.Parent = player:WaitForChild("PlayerGui")

trainButton.Activated:Connect(function()
	train:FireServer()
end)

rebirthButton.Activated:Connect(function()
	rebirth:FireServer()
end)

local function showCost()
	local cost = player:GetAttribute("RebirthCost")
	rebirthButton.Text = if cost then ("🔁 Rebirth (%d)"):format(cost) else "🔁 Rebirth"
end
player:GetAttributeChangedSignal("RebirthCost"):Connect(showCost)
showCost()
