--!strict
-- Shows the player's stage at the top of the screen. The server owns the stage; this only
-- displays it.
local Players = game:GetService("Players")
local Config = require(game:GetService("ReplicatedStorage").Shared.Config)

local player = Players.LocalPlayer
local gui = Instance.new("ScreenGui")
gui.Name = "ObbyHud"
gui.ResetOnSpawn = false

local label = Instance.new("TextLabel")
label.Size = UDim2.fromOffset(220, 40)
label.Position = UDim2.new(0.5, -110, 0, 12)
label.BackgroundTransparency = 0.3
label.TextScaled = true
label.Text = "Stage 0 / " .. Config.StageCount
label.Parent = gui
gui.Parent = player:WaitForChild("PlayerGui")

local leaderstats = player:WaitForChild("leaderstats")
local stage = leaderstats:WaitForChild("Stage") :: IntValue
local function show()
	label.Text = ("Stage %d / %d"):format(stage.Value, Config.StageCount)
end
stage.Changed:Connect(show)
show()
