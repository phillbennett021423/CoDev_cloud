--!strict
-- Shows the player's cash. The server owns the cash; this only displays it.
local Players = game:GetService("Players")

local player = Players.LocalPlayer
local gui = Instance.new("ScreenGui")
gui.Name = "TycoonHud"
gui.ResetOnSpawn = false

local label = Instance.new("TextLabel")
label.Size = UDim2.fromOffset(240, 40)
label.Position = UDim2.new(0, 12, 0, 12)
label.BackgroundTransparency = 0.3
label.TextScaled = true
label.Text = "$0"
label.Parent = gui
gui.Parent = player:WaitForChild("PlayerGui")

local cash = player:WaitForChild("leaderstats"):WaitForChild("Cash") :: IntValue
local function show()
	label.Text = "$" .. cash.Value
end
cash.Changed:Connect(show)
show()
