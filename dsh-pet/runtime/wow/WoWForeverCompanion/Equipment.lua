-- Read new carried equipment through public APIs. Never unwrap secret data.
local _, ns = ...
local L = ns.L or function(text) return text end
local Equipment = {}
ns.Equipment = Equipment
local Public = ns.Protocol.Public
local owner, emit, seen, maximumCounts, fallbackLinks, pending, baselineTimer, scanTimer
local active, initialized, nextID, dropped = false, false, 0, 0
local RETRIES = { 0.5, 1, 2, 4 }
local currentEmit, currentTimer, currentRequest, currentRevision, currentMissing
local currentGeneration = 0

local function Call(fn, ...)
    if type(fn) ~= "function" then return nil end
    local results = { pcall(fn, ...) }
    if not results[1] then return nil end
    for index = 2, 20 do results[index] = Public(results[index]) end
    return unpack(results, 2, 20)
end

local function Readable(value)
    value = Public(value)
    if type(value) ~= "table" then return nil end
    if canaccesstable and not canaccesstable(value) then return nil end
    return value
end

local function Number(value, minimum, maximum)
    value = Public(value)
    if type(value) ~= "number" or value ~= value or value < minimum or value > maximum then return nil end
    return value
end

local function Text(value, limit)
    value = Public(value)
    if type(value) ~= "string" then return nil end
    value = string.gsub(value, "|c%x%x%x%x%x%x%x%x", "")
    value = string.gsub(value, "|r", "")
    value = string.gsub(value, "|T.-|t", "")
    value = string.gsub(value, "|A.-|a", "")
    value = string.gsub(value, "[%z\1-\31\127]", " ")
    if value == "" then return nil end
    return ns.Protocol.UTF8Prefix(value, limit or 128), #value > (limit or 128)
end

local function Link(value)
    value = Public(value)
    if type(value) ~= "string" or not string.find(value, "item:%d+") then return nil end
    if #value > 1024 then return nil, true end
    return value
end

local function Location(bag, slot, inventory)
    if not ItemLocation then return nil end
    if inventory then return Call(ItemLocation.CreateFromEquipmentSlot, ItemLocation, slot) end
    return Call(ItemLocation.CreateFromBagAndSlot, ItemLocation, bag, slot)
end

local function ContainerInfo(bag, slot)
    if type(C_Container.GetContainerItemInfo) ~= "function" then return nil, false end
    local ok, info = pcall(C_Container.GetContainerItemInfo, bag, slot)
    if not ok or (issecretvalue and issecretvalue(info)) then return nil, false end
    if info ~= nil and not Readable(info) then return nil, false end
    return info, true
end

local function Entries()
    if not C_Container or not C_Item then return nil end
    local backpack = Number(Call(C_Container.GetContainerNumSlots, 0), 1, 200)
    if not backpack then return nil end
    local entries = {}
    local function Add(link, bag, slot, inventory, quantity)
        local valid, tooLong = Link(link)
        if not valid then return not tooLong end
        local location = Location(bag, slot, inventory)
        local itemGUID = location and Call(C_Item.GetItemGUID, location)
        if type(itemGUID) ~= "string" or itemGUID == "" or #itemGUID > 128 then itemGUID = nil end
        entries[#entries + 1] = { link = valid, bag = bag, slot = slot, inventory = inventory,
            itemGUID = itemGUID, quantity = quantity or 1 }
        return true
    end
    local lastBag = Number(NUM_TOTAL_EQUIPPED_BAG_SLOTS, 0, 20) or 5
    for bag = 0, lastBag do
        local slots = Number(Call(C_Container.GetContainerNumSlots, bag), 0, 200)
        if not slots then return nil end
        for slot = 1, slots do
            local info, accessible = ContainerInfo(bag, slot)
            if not accessible then return nil end
            if info then
                local link = Public(info.hyperlink) or Call(C_Container.GetContainerItemLink, bag, slot)
                -- An occupied slot without a public link is not a trustworthy baseline.
                if not Link(link) then
                    if type(link) == "string" and #link > 1024 then dropped = dropped + 1
                    else return nil end
                else
                    Add(link, bag, slot, false, Number(info.stackCount, 1, 100000) or 1)
                end
            end
        end
    end
    for slot = 1, 19 do Add(Call(GetInventoryItemLink, "player", slot), nil, slot, true, 1) end
    return entries
end

local function ItemType(entry)
    if not C_Item then return nil end
    local id, itemType, subtype, equipLoc, _, classID = Call(C_Item.GetItemInfoInstant, entry.link)
    id = Number(id, 1, 2147483647)
    local equipCut
    equipLoc, equipCut = Text(equipLoc)
    classID = Number(classID, 0, 100)
    if classID and classID ~= 2 and classID ~= 4 then return false end
    if equipLoc == "INVTYPE_BAG" or equipLoc == "INVTYPE_QUIVER" then return false end
    if not id or not equipLoc then return nil end
    local safeType, typeCut = Text(itemType)
    local safeSubtype, subtypeCut = Text(subtype)
    return { id = math.floor(id), type = safeType, subtype = safeSubtype, equipLoc = equipLoc,
        truncated = not not (typeCut or subtypeCut or equipCut) }
end

local function Tooltip(entry, record)
    if not C_TooltipInfo then return false end
    local data
    -- A moved slot must never supply another item's tooltip.
    local current = entry.inventory and Call(GetInventoryItemLink, "player", entry.slot)
        or Call(C_Container and C_Container.GetContainerItemLink, entry.bag, entry.slot)
    if Link(current) == entry.link then
        if entry.inventory then data = Call(C_TooltipInfo.GetInventoryItem, "player", entry.slot)
        else data = Call(C_TooltipInfo.GetBagItem, entry.bag, entry.slot) end
    end
    if not Readable(data) and entry.itemGUID then data = Call(C_TooltipInfo.GetItemByGUID, entry.itemGUID) end
    if not Readable(data) then data = Call(C_TooltipInfo.GetHyperlink, entry.link) end
    data = Readable(data)
    local lines = data and Readable(data.lines)
    if not lines then return false end
    local complete = true
    for _, line in ipairs(lines) do
        line = Readable(line)
        if not line then complete = false
        else
            local left, leftCut = Text(line.leftText, 256)
            local right, rightCut = Text(line.rightText, 256)
            if issecretvalue and (issecretvalue(line.leftText) or issecretvalue(line.rightText)) then complete = false end
            local text = left and right and (left .. " · " .. right) or left or right
            if text then
                if #record.tooltip >= 48 then record.truncated = true; complete = false; break end
                record.tooltip[#record.tooltip + 1] = ns.Protocol.UTF8Prefix(text, 256)
                if leftCut or rightCut or #text > 256 then record.truncated = true; complete = false end
            end
        end
    end
    return complete and #record.tooltip > 0
end

local function Collect(entry, basic)
    local name, _, quality, _, requiredLevel, itemType, subtype, _, equipLoc = Call(C_Item.GetItemInfo, entry.link)
    local safeName, nameCut = Text(name)
    local safeType, typeCut = Text(itemType)
    local safeSubtype, subtypeCut = Text(subtype)
    local safeEquipLoc, equipCut = Text(equipLoc)
    local record = { v = 1, id = entry.id, session = owner.session, guid = owner.guid,
        itemID = basic.id, itemGUID = entry.itemGUID, link = entry.link, name = safeName,
        type = safeType or basic.type, subtype = safeSubtype or basic.subtype,
        equipLoc = safeEquipLoc or basic.equipLoc, quality = Number(quality, 0, 8),
        itemLevel = Number(Call(C_Item.GetDetailedItemLevelInfo, entry.link), 0, 100000),
        requiredLevel = Number(requiredLevel, 0, 255), stats = {}, tooltip = {},
        quantity = entry.quantity, observedAt = entry.observedAt, source = "bag_added",
        infoComplete = false, statsComplete = false, tooltipComplete = false,
        truncated = not not (nameCut or typeCut or subtypeCut or equipCut or basic.truncated) }
    record.infoComplete = record.name ~= nil and record.type ~= nil and record.subtype ~= nil
        and record.equipLoc ~= nil and record.quality ~= nil and record.itemLevel ~= nil and record.requiredLevel ~= nil and not record.truncated
    local stats = Readable(Call(C_Item.GetItemStats, entry.link))
    if stats then
        record.statsComplete = true
        for key, value in pairs(stats) do
            key, value = Public(key), Number(value, -1000000000000, 1000000000000)
            if type(key) == "string" and #key <= 64 and value then
                if #record.stats == 32 then record.truncated = true; record.statsComplete = false; break end
                record.stats[#record.stats + 1] = { key = key, value = value }
            else record.statsComplete = false end
        end
        table.sort(record.stats, function(a, b) return a.key < b.key end)
    end
    record.tooltipComplete = Tooltip(entry, record)
    return record
end

local Attempt
Attempt = function(entry)
    if not active or pending[entry.id] ~= entry then return end
    if entry.timer then entry.timer:Cancel(); entry.timer = nil end
    local basic = ItemType(entry)
    if basic == false then pending[entry.id] = nil; return end
    local record = basic and Collect(entry, basic)
    if record and record.infoComplete and record.statsComplete and record.tooltipComplete then
        pending[entry.id] = nil; emit(record); Equipment.RequestCurrent("equipment_acquired"); return
    end
    entry.attempt = entry.attempt + 1
    if entry.attempt > #RETRIES then
        pending[entry.id] = nil
        if record then emit(record); Equipment.RequestCurrent("equipment_acquired") else dropped = dropped + 1 end
        return
    end
    Call(C_Item and C_Item.RequestLoadItemDataByID, tonumber(string.match(entry.link, "item:(%d+)")))
    entry.timer = C_Timer.NewTimer(RETRIES[entry.attempt], function() Attempt(entry) end)
end

function Equipment.Scan()
    if not active then return end
    local entries = Entries()
    if not entries then return end
    local counts, additions, fallbackEntries = {}, {}, {}
    for _, entry in ipairs(entries) do
        if not entry.itemGUID then fallbackLinks[entry.link] = true end
    end
    for _, entry in ipairs(entries) do
        local key = entry.itemGUID
        counts[entry.link] = (counts[entry.link] or 0) + entry.quantity
        if key then
            if not fallbackLinks[entry.link] and not seen[key] and initialized and not entry.inventory then additions[#additions + 1] = entry end
            seen[key] = true
        end
        if fallbackLinks[entry.link] and not entry.inventory then fallbackEntries[entry.link] = entry end
    end
    for link, entry in pairs(fallbackEntries) do
        if initialized and counts[link] > (maximumCounts[link] or 0) then
            entry.quantity = counts[link] - (maximumCounts[link] or 0)
            additions[#additions + 1] = entry
        end
    end
    for link, count in pairs(counts) do maximumCounts[link] = math.max(maximumCounts[link] or 0, count) end
    for _, entry in ipairs(additions) do
        local pendingCount = 0
        for _ in pairs(pending) do pendingCount = pendingCount + 1 end
        if pendingCount >= 64 then dropped = dropped + 1
        else
            nextID = nextID + 1
            entry.id, entry.attempt = nextID, 0
            entry.observedAt = math.floor(Number(Call(GetServerTime), 0, 4102444800) or 0)
            pending[entry.id] = entry
            Attempt(entry)
        end
    end
    return true
end

-- A deliberate review shares IDs with acquisitions, but never emits a new acquisition or changes its baseline.
function Equipment.Review(callback,targetItemID)
    if not active or not initialized or type(callback)~="function" then return 0,0 end
    local entries=Entries()
    if not entries then return 0,1 end
    local candidates,unready={},0
    for _, entry in ipairs(entries) do
        if not entry.inventory and entry.itemGUID then
            local basic=ItemType(entry)
            if basic and (not targetItemID or basic.id==targetItemID) then
                entry.id,entry.observedAt=0,math.floor(Number(Call(GetServerTime),0,4102444800) or 0)
                local record=Collect(entry,basic)
                if record.infoComplete and record.statsComplete and record.tooltipComplete and not record.truncated then
                    local _,assessment=ns.EquipmentCompare.Capture(owner,record)
                    if ns.EquipmentCompare.CanOffer(assessment) then candidates[#candidates+1]=record end
                else
                    unready=unready+1
                    Call(C_Item and C_Item.RequestLoadItemDataByID,basic.id)
                end
            end
        end
    end
    table.sort(candidates,function(a,b)
        if a.itemLevel~=b.itemLevel then return a.itemLevel>b.itemLevel end
        return a.itemGUID<b.itemGUID
    end)
    local accepted=0
    for _, record in ipairs(candidates) do
        if accepted>=6 or nextID>=2147483647 then break end
        nextID=nextID+1; record.id=nextID
        if callback(record)==true then accepted=accepted+1 end
    end
    return accepted,unready
end

local function CurrentText(value, limit)
    return type(value) == "string" and value ~= "" and #value <= limit
        and not string.find(value, "[%z\1-\31\127]") and not string.find(value, "\194[\128-\159]")
end
local function CurrentItem(record)
    for _, key in ipairs({ "name", "type", "subtype", "equipLoc" }) do
        if not CurrentText(record[key], 128) then record[key], record.infoComplete = nil, false end
    end
    for _, key in ipairs({ "quality", "requiredLevel" }) do
        local value = record[key]
        if type(value) ~= "number" or value ~= math.floor(value) then record[key], record.infoComplete = nil, false end
    end
    for index = #record.stats, 1, -1 do
        if not CurrentText(record.stats[index].key, 64) then table.remove(record.stats, index); record.statsComplete = false end
    end
    for index = #record.tooltip, 1, -1 do
        if not CurrentText(record.tooltip[index], 256) then table.remove(record.tooltip, index); record.tooltipComplete = false end
    end
    return record
end

-- Read one public inventory instant. Unknown is distinct from an explicitly empty slot.
local function InventoryEntry(slot)
    local location = Location(nil, slot, true)
    local exists = location and Call(C_Item and C_Item.DoesItemExist, location)
    if exists == false then return { slot = slot, state = "empty" }, "empty" end
    if exists ~= true then return { slot = slot, state = "unknown" }, "unknown" end
    local link = Link(Call(GetInventoryItemLink, "player", slot))
    if not CurrentText(link, 1024) then return { slot = slot, state = "unknown" }, "unknown" end
    local guid = Call(C_Item and C_Item.GetItemGUID, location)
    if not CurrentText(guid, 128) then guid = nil end
    return { slot = slot, state = "equipped", inventory = true, link = link, itemGUID = guid, quantity = 1 }, link .. "\0" .. (guid or "")
end

local function CurrentIdentity(request)
    return active and request and owner.session == request.session and owner.guid == request.guid
        and Call(UnitGUID, "player") == request.guid
end

local function ReadCurrent(request)
    if not CurrentIdentity(request) then return nil end
    local slots, fingerprints, missing, complete = {}, {}, {}, true
    local observedAt = math.floor(Number(Call(GetServerTime), 0, 4102444800) or 0)
    for slot = 1, 19 do
        local entry, fingerprint = InventoryEntry(slot)
        fingerprints[slot] = fingerprint
        local result = { slot = slot, state = entry.state }
        if entry.state == "equipped" then
            local itemID = Number(tonumber(string.match(entry.link, "item:(%d+)")), 1, 2147483647)
            if itemID then
                local basic = ItemType(entry)
                if type(basic) ~= "table" then basic = { id = itemID } end
                entry.observedAt = observedAt
                result.item = CurrentItem(Collect(entry, basic))
                if not result.item.infoComplete or not result.item.statsComplete or not result.item.tooltipComplete then
                    missing[itemID], complete = true, false
                end
            else result.state, complete = "unknown", false end
        elseif entry.state == "unknown" then complete = false end
        slots[slot] = result
    end
    for slot = 1, 19 do
        local _, fingerprint = InventoryEntry(slot)
        if fingerprint ~= fingerprints[slot] then return nil end
    end
    if not CurrentIdentity(request) then return nil end
    return { v = 1, session = request.session, guid = request.guid, observedAt = observedAt,
        reason = request.reason, slots = slots }, complete, missing
end

local AttemptCurrent
AttemptCurrent = function(request)
    if currentRequest ~= request or request.generation ~= currentGeneration or not CurrentIdentity(request) then return end
    currentTimer = nil
    local record, complete, missing = ReadCurrent(request)
    request.attempt = request.attempt + 1
    if record and (complete or request.attempt > #RETRIES) then
        if currentRevision >= 2147483647 then currentRequest = nil; dropped = dropped + 1; return end
        currentRevision = currentRevision + 1
        record.id, currentMissing, currentRequest = currentRevision, missing, nil
        currentEmit(record)
        return
    end
    if request.attempt > #RETRIES then currentRequest = nil; return end
    for itemID in pairs(missing or {}) do Call(C_Item and C_Item.RequestLoadItemDataByID, itemID) end
    currentTimer = C_Timer.NewTimer(RETRIES[request.attempt], function() AttemptCurrent(request) end)
end

-- Requests coalesce by event. The finished full inventory owns a separate revision from acquisition IDs.
function Equipment.RequestCurrent(reason)
    if not active or type(currentEmit) ~= "function" or not owner or type(owner.guid) ~= "string" or owner.guid == "" then return end
    if currentTimer then currentTimer:Cancel(); currentTimer = nil end
    currentGeneration = currentGeneration + 1
    local request = { generation = currentGeneration, session = owner.session, guid = owner.guid,
        observedAt = math.floor(Number(Call(GetServerTime), 0, 4102444800) or 0), reason = reason, attempt = 0 }
    currentRequest = request
    currentTimer = C_Timer.NewTimer(0.2, function() AttemptCurrent(request) end)
end

function Equipment.Initialize(state, callback, currentCallback)
    if currentTimer then currentTimer:Cancel() end
    currentEmit, currentTimer, currentRequest, currentRevision, currentMissing = currentCallback, nil, nil, 0, {}
    currentGeneration = currentGeneration + 1
    owner, emit, seen, maximumCounts, fallbackLinks, pending = state, callback, {}, {}, {}, {}
    nextID, dropped, initialized, active = 0, 0, false, false
end

function Equipment.EnterWorld()
    active = true
    Equipment.RequestCurrent("login")
    if not initialized then
        Equipment.Scan()
        if baselineTimer then baselineTimer:Cancel() end
        baselineTimer = C_Timer.NewTimer(2, function()
            if active and Equipment.Scan() then initialized = true end
        end)
    else Equipment.Scan() end
    for _, entry in pairs(pending) do Attempt(entry) end
end

function Equipment.OnEvent(event, itemID, success)
    if event == "PLAYER_LEAVING_WORLD" or event == "PLAYER_LOGOUT" then
        active = false
        currentGeneration = currentGeneration + 1
        currentRequest = nil
        if ns.Transfer and ns.Transfer.SetGear then ns.Transfer.SetGear(nil) end
        if currentTimer then currentTimer:Cancel(); currentTimer = nil end
        if scanTimer then scanTimer:Cancel() end
    elseif event == "PLAYER_ENTERING_WORLD" then Equipment.EnterWorld()
    elseif event == "BAG_UPDATE_DELAYED" or event == "PLAYER_EQUIPMENT_CHANGED" or event == "ITEM_PUSH" then
        if not active then return end
        if event == "PLAYER_EQUIPMENT_CHANGED" then Equipment.RequestCurrent("equipment_changed") end
        if scanTimer then scanTimer:Cancel() end
        scanTimer = C_Timer.NewTimer(0.2, function()
            if not initialized then Equipment.EnterWorld() else Equipment.Scan() end
        end)
    elseif event == "GET_ITEM_INFO_RECEIVED" or event == "ITEM_DATA_LOAD_RESULT" then
        itemID, success = Number(itemID, 1, 2147483647), Public(success)
        if not itemID or success ~= true then return end
        if currentRequest and active then
            if currentTimer then currentTimer:Cancel() end
            local request = currentRequest
            currentTimer = C_Timer.NewTimer(0.05, function() AttemptCurrent(request) end)
        elseif currentMissing and currentMissing[itemID] then Equipment.RequestCurrent("refresh") end
        for _, entry in pairs(pending) do
            if tonumber(string.match(entry.link, "item:(%d+)")) == itemID then Attempt(entry) end
        end
    end
end

function Equipment.Status()
    local count = 0
    for _ in pairs(pending) do count = count + 1 end
    return string.format(L("装备：%s · 等待资料 %d · 跳过 %d"), initialized and L("观察新增") or L("建立背包基线"), count, dropped)
end
