--!strict
-- The tycoon's numbers in one place. Make the pass and product on the Creator Dashboard and
-- put their ids here; 0 turns them off.
local Config = {
	DropInterval = 2, -- seconds between drops from each dropper
	-- Each upgrade: what it's called, its price, and how much cash each of its drops is worth.
	Droppers = {
		{ name = "Starter Dropper", price = 0, value = 1 },
		{ name = "Copper Dropper", price = 50, value = 3 },
		{ name = "Silver Dropper", price = 250, value = 10 },
		{ name = "Gold Dropper", price = 1000, value = 40 },
	},

	DoubleCashPassId = 0, -- game pass: every drop is worth twice as much
	CashPackProductId = 0, -- developer product: a pack of cash
	CashPackAmount = 500,
}

return Config
