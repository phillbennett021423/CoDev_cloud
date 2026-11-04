--!strict
-- The obby's numbers in one place. Make the game pass and product on the Creator Dashboard
-- (Monetization > Passes / Developer Products) and put their ids here; 0 turns them off.
local Config = {
	StageCount = 10,
	StageSpacing = 14, -- studs between platforms
	StageRise = 3, -- studs each platform climbs
	PlatformSize = { 8, 1, 8 },

	SkipStageProductId = 0, -- developer product: skip one stage
	SpeedPassId = 0, -- game pass: faster walking
	SpeedPassWalkSpeed = 24,
}

return Config
