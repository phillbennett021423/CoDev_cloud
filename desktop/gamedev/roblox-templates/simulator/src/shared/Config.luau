--!strict
-- The simulator's numbers in one place. Make the pass and product on the Creator Dashboard
-- and put their ids here; 0 turns them off.
local Config = {
	TrainCooldown = 0.25, -- seconds between counted clicks (faster clicks are ignored)
	StrengthPerClick = 1,
	RebirthCost = 100, -- strength needed for the first rebirth
	RebirthCostGrowth = 2.5, -- each rebirth costs this many times the last
	RebirthBonus = 0.5, -- each rebirth adds +50% strength per click

	DoubleStrengthPassId = 0, -- game pass: 2x strength per click
	BoostProductId = 0, -- developer product: instant strength
	BoostAmount = 250,
}

return Config
