--!strict
-- Game passes and developer products, done the way Roblox requires.
--  * Monetization.OwnsPass(player, passId): checked on the server (a client check can be
--    faked), cached, and updated the moment a pass is bought in game.
--  * Monetization.OnProduct(productId, grant): grant(player) gives the item and returns true.
--    The one ProcessReceipt below calls it, remembers each receipt so nothing is granted
--    twice, and says PurchaseGranted only once the grant is saved.
-- Ids of 0 (not made yet on the Creator Dashboard) are skipped.
local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")
local PlayerData = require(script.Parent.PlayerData)

local Monetization = {}

local passCache: { [Player]: { [number]: boolean } } = {}
local products: { [number]: (Player) -> boolean } = {}

function Monetization.OwnsPass(player: Player, passId: number): boolean
	if passId == 0 then
		return false
	end
	local cache = passCache[player] or {}
	passCache[player] = cache
	if cache[passId] == nil then
		local ok, owns = pcall(function()
			return MarketplaceService:UserOwnsGamePassAsync(player.UserId, passId)
		end)
		cache[passId] = ok and owns == true
	end
	return cache[passId] == true
end

function Monetization.OnProduct(productId: number, grant: (Player) -> boolean)
	if productId ~= 0 then
		products[productId] = grant
	end
end

MarketplaceService.PromptGamePassPurchaseFinished:Connect(function(player, passId, purchased)
	if purchased then
		local cache = passCache[player] or {}
		cache[passId] = true
		passCache[player] = cache
	end
end)

Players.PlayerRemoving:Connect(function(player)
	passCache[player] = nil
end)

MarketplaceService.ProcessReceipt = function(info)
	local player = Players:GetPlayerByUserId(info.PlayerId)
	local grant = products[info.ProductId]
	local data = player and PlayerData.Get(player)
	if not player or not grant or not data then
		return Enum.ProductPurchaseDecision.NotProcessedYet -- Roblox tries again later
	end
	local receipts = data.Receipts or {}
	data.Receipts = receipts
	-- Already granted (Roblox retried because the save hadn't gone through): just save again.
	if not receipts[info.PurchaseId] then
		local ok, granted = pcall(grant, player)
		if not ok or not granted then
			return Enum.ProductPurchaseDecision.NotProcessedYet
		end
		receipts[info.PurchaseId] = true
	end
	if not PlayerData.SaveNow(player) then
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
	return Enum.ProductPurchaseDecision.PurchaseGranted
end

return Monetization
