-- Equipment fragments share the existing grid with normal state frames.
local _, ns = ...
local L = ns.L or function(text) return text end
local Transfer = {}
ns.Transfer = Transfer
local Protocol = ns.Protocol
local records, cursor, current, currentPart, equipmentPhase = {}, 0, nil, 0, false
local heldFrame, dropped = nil, 0
local swaps, swapCursor, dataOpportunity = {}, 0, 0
local offer, offerOpportunity = nil, 0
local gear, gearPart, gearReplay = nil, 0, false
local inventory, inventoryPart = nil, 0
local quests, questPart, snapshotOpportunity = nil, 0, 0
local talents, talentPart, snapshotCursor = nil, 0, 0
local comparisons, comparisonCursor, currentComparison, comparisonPart, comparisonReplay = {}, 0, nil, 0, false
local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local keys = { "v", "id", "session", "guid", "itemID", "itemGUID", "link", "name", "type", "subtype", "equipLoc", "quality", "itemLevel", "requiredLevel", "stats", "tooltip", "quantity", "observedAt", "source", "infoComplete", "statsComplete", "tooltipComplete", "truncated" }

local function Escape(value)
    return '"' .. string.gsub(value, '[%z\1-\31\\"]', function(char)
        if char == '"' then return '\\"' end
        if char == '\\' then return '\\\\' end
        return string.format("\\u%04x", string.byte(char))
    end) .. '"'
end

local function Value(value)
    value = Protocol.Public(value)
    if type(value) == "string" then return Escape(value) end
    if type(value) == "boolean" then return value and "true" or "false" end
    if type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge then
        return string.format("%.14g", value)
    end
    return "null"
end

local function FieldsJSON(record, fieldKeys)
    local result = {}
    for _, key in ipairs(fieldKeys) do
        local value = record[key]
        local encoded
        if key == "stats" then
            local items = {}
            for _, stat in ipairs(value) do items[#items + 1] = '{"key":' .. Value(stat.key) .. ',"value":' .. Value(stat.value) .. '}' end
            encoded = "[" .. table.concat(items, ",") .. "]"
        elseif key == "tooltip" then
            local items = {}
            for _, line in ipairs(value) do items[#items + 1] = Value(line) end
            encoded = "[" .. table.concat(items, ",") .. "]"
        elseif key == "items" then
            local items = {}
            for _, item in ipairs(value) do
                items[#items + 1] = '{"itemID":' .. Value(item.itemID) .. ',"quantity":' .. Value(item.quantity) .. '}'
            end
            encoded = "[" .. table.concat(items, ",") .. "]"
        else encoded = Value(value) end
        result[#result + 1] = Escape(key) .. ":" .. encoded
    end
    return "{" .. table.concat(result, ",") .. "}"
end


function Transfer.JSON(record) return FieldsJSON(record, keys) end

function Transfer.InventoryJSON(record)
    return FieldsJSON(record, { "v", "id", "session", "guid", "observedAt", "source", "bank", "complete", "items" })
end

function Transfer.EncodeInventory(record)
    local body = Transfer.InventoryJSON(record)
    if #body > 65536 then return nil, "inventory exceeds 65536 bytes" end
    local count, frames = math.ceil(#body / 240), {}
    for part = 1, count do
        local payload = '{"v":1,"kind":"inv","s":' .. Value(record.session) .. ',"g":' .. Value(record.guid)
            .. ',"id":' .. Value(record.id) .. ',"p":' .. part .. ',"n":' .. count
            .. ',"d":' .. Escape(Transfer.Base64(string.sub(body, (part - 1) * 240 + 1, part * 240))) .. '}'
        if #payload > 504 then return nil, "inventory fragment exceeds 504 bytes" end
        frames[part] = Protocol.Frame(payload)
    end
    return frames, body
end

function Transfer.SetInventory(record)
    if not record then inventory, inventoryPart = nil, 0; return true end
    local frames = Transfer.EncodeInventory(record)
    if not frames then dropped = dropped + 1; return false end
    inventory, inventoryPart = { frames = frames, fresh = true }, 0
    return true
end

function Transfer.InventoryBusy() return inventory and inventory.fresh or false end

local function NextInventory()
    inventoryPart = inventoryPart % #inventory.frames + 1
    heldFrame = inventory.frames[inventoryPart]
    if inventoryPart == #inventory.frames then inventory.fresh = false end
end

function Transfer.QuestsJSON(record)
    local entries = {}
    for _, entry in ipairs(record.log.entries) do
        local objectives = {}
        for _, objective in ipairs(entry.objectives) do
            objectives[#objectives + 1] = FieldsJSON(objective, {"index", "text", "type", "fulfilled", "required", "finished"})
        end
        local fields = FieldsJSON(entry, {"questID", "title", "level", "header", "readyForTurnIn", "failed", "objectivesComplete"})
        entries[#entries + 1] = string.sub(fields, 1, -2) .. ',"objectives":[' .. table.concat(objectives, ",") .. ']}'
    end
    local ids, turnIns = {}, {}
    for _, id in ipairs(record.completion.ids) do ids[#ids + 1] = Value(id) end
    for _, entry in ipairs(record.completion.turnIns) do turnIns[#turnIns + 1] = FieldsJSON(entry, {"questID", "observedAt"}) end
    local log = FieldsJSON(record.log, {"complete", "truncated", "total"})
    local completion = FieldsJSON(record.completion, {"source", "scope", "complete", "truncated", "total"})
    local root = FieldsJSON(record, {"v", "id", "session", "guid", "observedAt", "source"})
    return string.sub(root, 1, -2) .. ',"log":' .. string.sub(log, 1, -2) .. ',"entries":[' .. table.concat(entries, ",") .. ']},"completion":'
        .. string.sub(completion, 1, -2) .. ',"ids":[' .. table.concat(ids, ",") .. '],"turnIns":[' .. table.concat(turnIns, ",") .. ']}}'
end
function Transfer.EncodeQuests(record)
    local body = Transfer.QuestsJSON(record)
    if #body > 32768 then return nil, "quests exceed 32768 bytes" end
    local count, frames = math.ceil(#body / 240), {}
    for part = 1, count do
        local payload = '{"v":1,"kind":"qlog","s":' .. Value(record.session) .. ',"g":' .. Value(record.guid)
            .. ',"id":' .. Value(record.id) .. ',"p":' .. part .. ',"n":' .. count
            .. ',"d":' .. Escape(Transfer.Base64(string.sub(body, (part - 1) * 240 + 1, part * 240))) .. '}'
        if #payload > 504 then return nil, "quest fragment exceeds 504 bytes" end
        frames[part] = Protocol.Frame(payload)
    end
    return frames, body
end
function Transfer.SetQuests(record)
    if not record then quests, questPart = nil, 0; return true end
    local frames = Transfer.EncodeQuests(record)
    if not frames then dropped = dropped + 1; return false end
    quests, questPart = { frames = frames, fresh = true }, 0
    return true
end
function Transfer.QuestsBusy() return quests and quests.fresh or false end
local function NextQuests()
    questPart = questPart % #quests.frames + 1
    heldFrame = quests.frames[questPart]
    if questPart == #quests.frames then quests.fresh = false end
end

function Transfer.TalentsJSON(record)
    local trees, zeros, nodes = {}, {}, {}
    for _, id in ipairs(record.treeIDs) do trees[#trees + 1] = Value(id) end
    for _, node in ipairs(record.knownZeroNodes) do zeros[#zeros + 1] = FieldsJSON(node, {"treeID", "nodeID"}) end
    for _, node in ipairs(record.nodes) do
        local entries, conditions = {}, {}
        for _, entry in ipairs(node.entries) do
            entries[#entries + 1] = FieldsJSON(entry, {"entryID", "definitionID", "spellID", "rank", "isActive"})
        end
        for _, condition in ipairs(node.conditions) do
            conditions[#conditions + 1] = FieldsJSON(condition, {"conditionID", "isMet", "playerLevel", "spentAmountRequired", "traitCurrencyID"})
        end
        local fields = FieldsJSON(node, {"treeID", "nodeID", "ranksPurchased", "activeRank", "maxRanks", "isAvailable", "isVisible", "meetsEdgeRequirements", "entriesComplete", "conditionsComplete"})
        nodes[#nodes + 1] = string.sub(fields, 1, -2) .. ',"entries":[' .. table.concat(entries, ",") .. '],"conditions":[' .. table.concat(conditions, ",") .. ']}'
    end
    local fields = FieldsJSON(record, {"v", "id", "session", "guid", "observedAt", "source", "clientBuild", "locale", "class", "classID", "specID", "configID", "configName", "configType", "status", "hasStagedChanges", "scope", "complete", "truncated"})
    return string.sub(fields, 1, -2) .. ',"treeIDs":[' .. table.concat(trees, ",") .. '],"knownZeroNodes":[' .. table.concat(zeros, ",") .. '],"nodes":[' .. table.concat(nodes, ",") .. ']}'
end
function Transfer.EncodeTalents(record)
    local body = Transfer.TalentsJSON(record)
    if #body > 65536 then return nil, "talents exceed 65536 bytes" end
    local count, frames = math.ceil(#body / 240), {}
    for part = 1, count do
        local payload = '{"v":1,"kind":"traits","s":' .. Value(record.session) .. ',"g":' .. Value(record.guid)
            .. ',"id":' .. Value(record.id) .. ',"p":' .. part .. ',"n":' .. count
            .. ',"d":' .. Escape(Transfer.Base64(string.sub(body, (part - 1) * 240 + 1, part * 240))) .. '}'
        if #payload > 504 then return nil, "talent fragment exceeds 504 bytes" end
        frames[part] = Protocol.Frame(payload)
    end
    return frames, body
end
function Transfer.SetTalents(record)
    if not record then talents, talentPart = nil, 0; return true end
    local frames = Transfer.EncodeTalents(record)
    if not frames then dropped = dropped + 1; return false end
    talents, talentPart = { frames = frames, fresh = true }, 0
    return true
end
function Transfer.TalentsBusy() return talents and talents.fresh or false end
local function NextTalents()
    talentPart = talentPart % #talents.frames + 1
    heldFrame = talents.frames[talentPart]
    if talentPart == #talents.frames then talents.fresh = false end
end

function Transfer.Base64(bytes)
    local result = {}
    for index = 1, #bytes, 3 do
        local a, b, c = string.byte(bytes, index, index + 2)
        local value = a * 65536 + (b or 0) * 256 + (c or 0)
        local p, q, r, s = math.floor(value / 262144) % 64, math.floor(value / 4096) % 64, math.floor(value / 64) % 64, value % 64
        result[#result + 1] = string.sub(alphabet, p + 1, p + 1) .. string.sub(alphabet, q + 1, q + 1)
            .. (b and string.sub(alphabet, r + 1, r + 1) or "=") .. (c and string.sub(alphabet, s + 1, s + 1) or "=")
    end
    return table.concat(result)
end

function Transfer.Encode(record)
    local body = Transfer.JSON(record)
    while #body > 8192 and #record.tooltip > 0 do
        table.remove(record.tooltip)
        record.truncated, record.tooltipComplete = true, false
        body = Transfer.JSON(record)
    end
    while #body > 8192 and #record.stats > 0 do
        table.remove(record.stats)
        record.truncated, record.statsComplete = true, false
        body = Transfer.JSON(record)
    end
    if #body > 8192 then return nil, "equipment exceeds 8192 bytes" end
    local count, frames = math.ceil(#body / 240), {}
    for part = 1, count do
        local payload = '{"v":1,"kind":"eq","s":' .. Value(record.session) .. ',"g":' .. Value(record.guid)
            .. ',"id":' .. Value(record.id) .. ',"p":' .. part .. ',"n":' .. count
            .. ',"d":' .. Escape(Transfer.Base64(string.sub(body, (part - 1) * 240 + 1, part * 240))) .. '}'
        if #payload > 504 then return nil, "equipment fragment exceeds 504 bytes" end
        frames[part] = Protocol.Frame(payload)
    end
    return frames, body
end

function Transfer.Add(record)
    local frames = Transfer.Encode(record)
    if not frames then dropped = dropped + 1; return end
    local entry = { id = record.id, frames = frames, fresh = true, expires = (GetTime() or 0) + 600 }
    records[#records + 1] = entry
    if #records > 6 then
        local removed = table.remove(records, 1)
        if current == removed then current, currentPart = nil, 0 end
        cursor = math.max(0, cursor - 1)
        dropped = dropped + 1
    end
end

local gearItemKeys = { "itemID", "itemGUID", "link", "name", "type", "subtype", "equipLoc", "quality", "itemLevel", "requiredLevel", "stats", "tooltip", "infoComplete", "statsComplete", "tooltipComplete", "truncated" }
local function GearItemJSON(item)
    return FieldsJSON(item, gearItemKeys)
end
function Transfer.GearJSON(record)
    local slots = {}
    for _, entry in ipairs(record.slots) do
        slots[#slots + 1] = '{"slot":' .. Value(entry.slot) .. ',"state":' .. Value(entry.state)
            .. ',"item":' .. (entry.item and GearItemJSON(entry.item) or "null") .. '}'
    end
    return '{"v":1,"id":' .. Value(record.id) .. ',"session":' .. Value(record.session)
        .. ',"guid":' .. Value(record.guid) .. ',"observedAt":' .. Value(record.observedAt)
        .. ',"reason":' .. Value(record.reason) .. ',"slots":[' .. table.concat(slots, ",") .. ']}'
end
function Transfer.EncodeGear(record)
    if type(record) ~= "table" or type(record.slots) ~= "table" or #record.slots ~= 19 then return nil, "invalid gear slots" end
    for slot, entry in ipairs(record.slots) do
        if entry.slot ~= slot or (entry.state ~= "equipped" and entry.state ~= "empty" and entry.state ~= "unknown")
            or ((entry.state == "equipped") ~= (type(entry.item) == "table")) then return nil, "invalid gear slot state" end
        local item = entry.item
        if item then
            local body = GearItemJSON(item)
            while #body > 8192 and #item.tooltip > 0 do
                table.remove(item.tooltip)
                item.truncated, item.tooltipComplete = true, false
                body = GearItemJSON(item)
            end
            while #body > 8192 and #item.stats > 0 do
                table.remove(item.stats)
                item.truncated, item.statsComplete = true, false
                body = GearItemJSON(item)
            end
            if #body > 8192 then return nil, "gear item exceeds 8192 bytes" end
        end
    end
    local body = Transfer.GearJSON(record)
    if #body > 196608 then return nil, "gear snapshot exceeds 196608 bytes" end
    local count, frames = math.ceil(#body / 240), {}
    for part = 1, count do
        local payload = '{"v":1,"kind":"gear","s":' .. Value(record.session) .. ',"g":' .. Value(record.guid)
            .. ',"id":' .. Value(record.id) .. ',"p":' .. part .. ',"n":' .. count
            .. ',"d":' .. Escape(Transfer.Base64(string.sub(body, (part - 1) * 240 + 1, part * 240))) .. '}'
        if #payload > 504 then return nil, "gear fragment exceeds 504 bytes" end
        frames[part] = Protocol.Frame(payload)
    end
    return frames, body
end
function Transfer.SetGear(record)
    if not record then gear, gearPart, gearReplay = nil, 0, false; return end
    local frames = Transfer.EncodeGear(record)
    if not frames then dropped = dropped + 1; return false end
    -- Only the latest coherent loadout is kept. Its fragments replay until a newer capture replaces it.
    gear, gearPart, gearReplay = { frames = frames, fresh = true }, 0, false
    -- Restart only interrupted old replay streams, so their later pass cannot resume beyond a receiver TTL.
    if current and not current.fresh then current, currentPart = nil, 0 end
    if currentComparison and not currentComparison.fresh then currentComparison, comparisonPart = nil, 0 end
    return true
end
local function NextGear()
    gearPart = gearPart % #gear.frames + 1
    heldFrame = gear.frames[gearPart]
    if gearPart == #gear.frames then gear.fresh = false; gearReplay = false end
end

local comparisonKeys = { "v", "id", "session", "guid", "class", "spec", "primary", "observedAt", "slot", "usable", "specMatch", "current", "candidate" }
local comparisonItemKeys = { "itemID", "name", "itemLevel", "equipLoc", "type", "subtype", "stats", "complex", "complete" }
local function ComparisonItem(item)
    if not item then return "null" end
    local values = {}
    for _, key in ipairs(comparisonItemKeys) do
        local encoded = Value(item[key])
        if key == "stats" then
            local entries = {}
            for _, stat in ipairs(item.stats) do entries[#entries+1] = '{"key":'..Value(stat.key)..',"value":'..Value(stat.value)..'}' end
            encoded = "["..table.concat(entries,",").."]"
        end
        values[#values+1] = Escape(key)..":"..encoded
    end
    return "{"..table.concat(values,",").."}"
end
function Transfer.ComparisonJSON(record)
    local values = {}
    for _, key in ipairs(comparisonKeys) do
        local encoded = (key=="current" or key=="candidate") and ComparisonItem(record[key]) or Value(record[key])
        values[#values+1] = Escape(key)..":"..encoded
    end
    return "{"..table.concat(values,",").."}"
end
local function ComparisonText(value,maximum)
    if type(value)~="string" or #value>maximum or string.find(value,"[%z\1-\31\127]") or string.find(value,"\194[\128-\159]") then return false end
    local index=1
    while index<=#value do
        local first,second=string.byte(value,index,index+1)
        local width=first<128 and 1 or first>=194 and first<=223 and 2 or first>=224 and first<=239 and 3 or first>=240 and first<=244 and 4
        if not width or index+width-1>#value then return false end
        for offset=1,width-1 do local byte=string.byte(value,index+offset); if byte<128 or byte>191 then return false end end
        if (first==224 and second<160) or (first==237 and second>=160) or (first==240 and second<144) or (first==244 and second>=144) then return false end
        index=index+width
    end
    return true
end
local function ComparisonNumber(value,minimum,maximum,integer)
    return type(value)=="number" and value==value and value>=minimum and value<=maximum and (not integer or value==math.floor(value))
end
local function ValidComparisonItem(item,candidate)
    if type(item)~="table" or not ComparisonNumber(item.itemID,candidate and 1 or 0,2147483647,true)
        or not ComparisonNumber(item.itemLevel,item.itemID==0 and -1 or 0,100000)
        or type(item.complete)~="boolean" or type(item.complex)~="boolean" or type(item.stats)~="table" or #item.stats>32 then return false end
    for _,key in ipairs({"name","equipLoc","type","subtype"}) do
        if not ComparisonText(item[key],128) or (item.complete and item.itemID~=0 and item[key]=="") then return false end
    end
    if candidate and item.name=="" then return false end
    if item.itemID==0 and (item.itemLevel~=-1 or #item.stats~=0) then return false end
    local seen={}
    for _,stat in ipairs(item.stats) do
        if not ComparisonText(stat.key,64) or stat.key=="" or seen[stat.key] or not ComparisonNumber(stat.value,-1e12,1e12) then return false end
        seen[stat.key]=true
    end
    return true
end
function Transfer.EncodeComparison(record)
    if type(record)~="table" or record.v~=1 or not ComparisonNumber(record.id,1,2147483647,true)
        or not ComparisonText(record.session,40) or not string.match(record.session,"^[A-Za-z0-9_-]+$")
        or not ComparisonText(record.guid,48) or not string.match(record.guid,"^[A-Za-z0-9_-]+$")
        or not ComparisonText(record.class,32) or not string.match(record.class,"^[A-Z_]+$")
        or not ComparisonNumber(record.spec,0,2147483647,true) or (record.primary~=0 and record.primary~=1 and record.primary~=2 and record.primary~=4)
        or not ComparisonNumber(record.observedAt,0,4102444800,true) or not ComparisonNumber(record.slot,0,19,true)
        or type(record.usable)~="boolean" or (record.specMatch~=nil and type(record.specMatch)~="boolean")
        or not ValidComparisonItem(record.candidate,true) or (record.slot==0)~=(record.current==nil)
        or (record.current and not ValidComparisonItem(record.current,false)) then return nil,"invalid comparison facts" end
    local body=Transfer.ComparisonJSON(record)
    if #body>4096 then return nil,"comparison exceeds 4096 bytes" end
    local frames,count={},math.ceil(#body/240)
    for part=1,count do
        local payload='{"v":1,"kind":"cmp","s":'..Value(record.session)..',"g":'..Value(record.guid)
            ..',"id":'..Value(record.id)..',"p":'..part..',"n":'..count
            ..',"d":'..Escape(Transfer.Base64(string.sub(body,(part-1)*240+1,part*240)))..'}'
        if #payload>504 then return nil,"comparison fragment exceeds 504 bytes" end
        frames[part]=Protocol.Frame(payload)
    end
    return frames,body
end
function Transfer.AddComparison(record)
    local frames=Transfer.EncodeComparison(record)
    if not frames then dropped=dropped+1; return false end
    -- Fresh comparisons precede new acquisition details. Never strand an old partial stream beyond the receiver TTL.
    if current and current.id~=record.id and currentPart>0 then
        for index,entry in ipairs(records) do if entry==current then table.remove(records,index); break end end
        current,currentPart=nil,0
        cursor=math.max(0,cursor-1)
        dropped=dropped+1
    end
    comparisons[#comparisons+1]={id=record.id,frames=frames,fresh=true,expires=(GetTime() or 0)+600}
    if #comparisons>6 then
        local index=currentComparison==comparisons[1] and 2 or 1
        table.remove(comparisons,index); dropped=dropped+1
        comparisonCursor=math.max(0,comparisonCursor-1)
    end
    return true
end

local swapKeys = { "v", "kind", "s", "g", "id", "e", "st", "r", "at", "slot", "item", "old" }
local failedReasons = { timeout = true, combat = true, changed = true, unavailable = true, locked = true,
    cursor = true, dead = true, restricted = true, disabled = true, left_world = true }
local function Integer(value, low, high)
    return type(value) == "number" and value == math.floor(value) and value >= low and value <= high
end
local function Identity(value, maximum)
    return type(value) == "string" and #value >= 1 and #value <= maximum and not string.find(value, "[^A-Za-z0-9_-]")
end
function Transfer.EncodeSwap(result)
    if result.v ~= 1 or result.kind ~= "swap" or not Identity(result.s, 40) or not Identity(result.g, 48)
        or not Integer(result.id, 1, 2147483647) or not Integer(result.e, 1, 2147483647)
        or not Integer(result.at, 0, 4102444800) or not Integer(result.slot, 1, 19)
        or not Integer(result.item, 1, 2147483647) or not Integer(result.old, 0, 2147483647) then return nil end
    local valid = (result.st == "equipped" and result.r == "confirmed") or (result.st == "declined" and result.r == "user")
        or (result.st == "expired" and result.r == "timeout") or (result.st == "failed" and failedReasons[result.r])
    if not valid then return nil end
    local values, allowed = {}, {}
    for _, key in ipairs(swapKeys) do values[#values + 1] = Escape(key) .. ":" .. Value(result[key]); allowed[key] = true end
    for key in pairs(result) do if not allowed[key] then return nil end end
    local json = "{" .. table.concat(values, ",") .. "}"
    if #json > 504 then return nil end
    return Protocol.Frame(json), json
end
function Transfer.AddSwap(result)
    for _, entry in ipairs(swaps) do if entry.id == result.id then return end end
    local frame = Transfer.EncodeSwap(result)
    if not frame then dropped = dropped + 1; return end
    swaps[#swaps + 1] = { id = result.id, frame = frame, fresh = true, expires = (GetTime() or 0) + 600 }
    if #swaps > 10 then table.remove(swaps, 1); swapCursor = math.max(0, swapCursor - 1) end
end

local offerKeys = { "v", "kind", "s", "g", "id", "q", "st", "slot", "item", "n", "il", "old", "ol", "until" }
local function Level(value, minimum)
    return type(value) == "number" and value == value and value >= minimum and value <= 100000
end
local function PlainName(value)
    if type(value) ~= "string" or #value == 0 or #value > 96 or string.find(value, "[%z\1-\31\127|]") then return false end
    local index = 1
    while index <= #value do
        local first, second = string.byte(value, index, index + 1)
        local width = first < 128 and 1 or first >= 194 and first <= 223 and 2
            or first >= 224 and first <= 239 and 3 or first >= 240 and first <= 244 and 4
        if not width or index + width - 1 > #value then return false end
        for offset = 1, width - 1 do
            local byte = string.byte(value, index + offset)
            if byte < 128 or byte > 191 then return false end
        end
        if (first == 224 and second < 160) or (first == 237 and second >= 160)
            or (first == 240 and second < 144) or (first == 244 and second >= 144) then return false end
        index = index + width
    end
    return string.find(value, "%S") ~= nil
end
function Transfer.EncodeOffer(result)
    if type(result) ~= "table" or result.v ~= 1 or result.kind ~= "offer" or not Identity(result.s, 40) or not Identity(result.g, 48)
        or not Integer(result.id, 1, 2147483647) or not Integer(result.q, 1, 2147483647)
        or (result.st ~= "ready" and result.st ~= "closed") or not Integer(result.slot, 1, 19)
        or not Integer(result.item, 1, 2147483647) or not Integer(result.old, 0, 2147483647)
        or not PlainName(result.n) or not Level(result.il, 0) or not Level(result.ol, -1)
        or (result.old == 0 and result.ol ~= -1) or (result.old ~= 0 and result.ol < 0)
        or result.il < result.ol
        or not Integer(result["until"], 1, 4102444800) then return nil end
    local values, allowed = {}, {}
    for _, key in ipairs(offerKeys) do values[#values + 1] = Escape(key) .. ":" .. Value(result[key]); allowed[key] = true end
    for key in pairs(result) do if not allowed[key] then return nil end end
    local json = "{" .. table.concat(values, ",") .. "}"
    if #json > 504 then return nil end
    return Protocol.Frame(json), json
end
function Transfer.SetOffer(result)
    local previous = offer and offer.frame
    local frame = result and Transfer.EncodeOffer(result)
    if result and not frame then dropped = dropped + 1 end
    -- A close replaces even a frame already held on the grid. No old ready frame is queued for replay.
    offer = frame and { frame = frame, expires = (GetTime() or 0) + 180 } or nil
    if previous and heldFrame == previous then heldFrame = frame end
end

local macroState, macroOpportunity
function Transfer.SetMacroState(state) macroState, macroOpportunity = state, 0 end

function Transfer.Advance()
    equipmentPhase = not equipmentPhase
    heldFrame = nil
    if not equipmentPhase then return end
    macroOpportunity = (macroOpportunity or 0) + 1
    local importer = WoWCompanionMacroImport
    if macroState and importer and type(importer.Telemetry) == "function" and macroOpportunity % 2 == 0 then
        local ok, value = pcall(importer.Telemetry)
        if ok and type(value) == "table" then
            value.v, value.kind, value.s, value.g = 1, "macro", macroState.session, macroState.guid
            local payload = FieldsJSON(value, {"v", "kind", "s", "g", "q", "id", "st", "r", "hash", "bytes", "focus", "input", "chat", "combat"})
            if #payload <= 504 then heldFrame = Protocol.Frame(payload); return end
        end
    end
    -- Buffs and calendar share their existing quarter of data slots. Equipment bandwidth stays unchanged.
    if macroState and ns.GroupBuffs and macroOpportunity % 8 == 5 then
        local ok, value = pcall(ns.GroupBuffs.Next)
        if ok and value then
            value.v, value.kind, value.s, value.g = 1, "buff", macroState.session, macroState.guid
            local payload = FieldsJSON(value, {"v", "kind", "s", "g", "e", "q", "st", "spell", "name", "missing", "checked", "total", "instanceType", "instanceID"})
            if #payload <= 504 then heldFrame = Protocol.Frame(payload); return end
        end
    end
    if macroState and ns.Calendar and macroOpportunity % 8 == 1 then
        local ok, value = pcall(ns.Calendar.Next)
        if ok and value then
            value.v, value.kind, value.s, value.g = 1, "calendar", macroState.session, macroState.guid
            local payload = FieldsJSON(value, {"v", "kind", "s", "g", "day", "p", "n", "title", "action", "when"})
            if #payload <= 504 then heldFrame = Protocol.Frame(payload); return end
        end
    end
    local now = GetTime() or 0
    for index=#comparisons,1,-1 do
        if comparisons[index].expires<=now then
            if currentComparison==comparisons[index] then currentComparison,comparisonPart=nil,0 end
            table.remove(comparisons,index); comparisonCursor=math.max(0,comparisonCursor-1)
        end
    end
    for index = #swaps, 1, -1 do
        if swaps[index].expires <= now then table.remove(swaps, index); swapCursor = math.max(0, swapCursor - 1) end
    end
    for index = #records, 1, -1 do
        if records[index].expires <= now then
            if current == records[index] then current, currentPart = nil, 0 end
            table.remove(records, index)
            cursor = math.max(0, cursor - 1)
        end
    end
    if offer and offer.expires <= now then offer = nil end
    offerOpportunity = offerOpportunity + 1
    -- Offers use one in three data slots. Results use one in four of the remaining slots.
    -- Even with both, 35 equipment parts finish within 140 seconds, below the 180s receiver TTL.
    if offer and (offerOpportunity % 3 == 1 or (#records == 0 and #swaps == 0 and #comparisons == 0 and not gear)) then
        heldFrame = offer.frame
        return
    end
    dataOpportunity = dataOpportunity + 1
    if #swaps > 0 and ((#records == 0 and #comparisons == 0 and not gear) or dataOpportunity % 4 == 0) then
        local nextSwap
        for _, entry in ipairs(swaps) do if entry.fresh then nextSwap = entry; break end end
        if not nextSwap then
            swapCursor = swapCursor % #swaps + 1
            nextSwap = swaps[swapCursor]
        end
        heldFrame, nextSwap.fresh = nextSwap.frame, false
        return
    end
    local freshComparison = false
    for _, entry in ipairs(comparisons) do if entry.fresh then freshComparison = true; break end end
    if freshComparison and currentComparison and not currentComparison.fresh then currentComparison, comparisonPart = nil, 0 end
    local freshEquipment = current and current.fresh or false
    for _, entry in ipairs(records) do if entry.fresh then freshEquipment = true; break end end
    -- Fresh observation streams rotate fairly; their replays take only one quarter of background slots.
    if not freshComparison and not freshEquipment then
        snapshotOpportunity = snapshotOpportunity + 1
        local pending = {}
        if inventory and inventory.fresh then pending[#pending + 1] = NextInventory end
        if quests and quests.fresh then pending[#pending + 1] = NextQuests end
        if talents and talents.fresh then pending[#pending + 1] = NextTalents end
        if #pending > 0 and not (gear and gear.fresh and snapshotOpportunity % 4 == 0) then
            snapshotCursor = snapshotCursor % #pending + 1
            pending[snapshotCursor]()
            return
        elseif #pending == 0 and snapshotOpportunity % 4 == 1 then
            if inventory then pending[#pending + 1] = NextInventory end
            if quests then pending[#pending + 1] = NextQuests end
            if talents then pending[#pending + 1] = NextTalents end
            if #pending > 0 then
                snapshotCursor = snapshotCursor % #pending + 1
                pending[snapshotCursor]()
                return
            end
        end
    end
    if gear and not freshComparison and not freshEquipment then
        -- Gear gets all remaining data slots for its first pass, then alternates with ordinary replays.
        if gear.fresh or gearReplay or (#records == 0 and #comparisons == 0) then
            NextGear()
            if not gear.fresh then gearReplay = false end
            return
        end
        gearReplay = true
    end
    if not currentComparison then
        for _,entry in ipairs(comparisons) do if entry.fresh then currentComparison=entry; break end end
        local freshEquipment=false
        for _,entry in ipairs(records) do if entry.fresh then freshEquipment=true; break end end
        if not currentComparison and not current and not freshEquipment and #comparisons>0 and (comparisonReplay or #records==0) then
            comparisonCursor=comparisonCursor % #comparisons+1
            currentComparison=comparisons[comparisonCursor]
            comparisonReplay=false
        end
        if currentComparison then comparisonPart=0 end
    end
    if currentComparison then
        comparisonPart=comparisonPart+1
        heldFrame=currentComparison.frames[comparisonPart]
        if comparisonPart>=#currentComparison.frames then currentComparison.fresh=false; currentComparison,comparisonPart=nil,0 end
        return
    end
    if not current then
        for _, record in ipairs(records) do if record.fresh then current = record; break end end
        if not current and #records > 0 then
            cursor = cursor % #records + 1
            current = records[cursor]
        end
        currentPart = 0
    end
    if not current then return end
    currentPart = currentPart + 1
    heldFrame = current.frames[currentPart]
    if currentPart >= #current.frames then current.fresh = false; current, currentPart = nil, 0; comparisonReplay=true end
end

function Transfer.Current(stateFrame) return heldFrame or stateFrame end

function Transfer.Status()
    return string.format(L("装备传输：缓存 %d/6 · 比较 %d/6 · 换装结果 %d/10 · 全身装备 %s · 过载/编码跳过 %d · 状态与数据每0.25秒交替"), #records, #comparisons, #swaps, gear and (gearPart .. "/" .. #gear.frames) or L("无"), dropped)
end
