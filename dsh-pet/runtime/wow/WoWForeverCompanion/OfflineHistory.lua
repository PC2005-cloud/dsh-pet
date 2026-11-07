local _, ns = ...
local History = {}
ns.OfflineHistory = History
local db, saved, lastTick, lastGUID, cached, encodedAt = nil, nil, nil, nil, nil, -100
local Public = ns.Protocol.Public

local function AddCopper(left, right)
    local result, carry, i, j = "", 0, #left, #right
    while i > 0 or j > 0 or carry > 0 do
        local total = (i > 0 and tonumber(string.sub(left, i, i)) or 0)
            + (j > 0 and tonumber(string.sub(right, j, j)) or 0) + carry
        result, carry, i, j = tostring(total % 10) .. result, math.floor(total / 10), i - 1, j - 1
    end
    return result
end

local function Copy(value)
    value = Public(value)
    if type(value) ~= "table" then return value end
    if canaccesstable and not canaccesstable(value) then return nil end
    local result = {}
    for key, child in pairs(value) do result[key] = Copy(child) end
    return result
end

local function JSON(value, field)
    local kind = type(value)
    if kind == "string" then
        return '"' .. string.gsub(value, '[%z\1-\31\\"]', function(c)
            if c == '"' then return '\\"' end
            if c == '\\' then return '\\\\' end
            return string.format("\\u%04x", string.byte(c))
        end) .. '"'
    end
    if kind == "number" then return value == value and value ~= math.huge and value ~= -math.huge and string.format(value == math.floor(value) and "%.0f" or "%.14g", value) or "null" end
    if kind == "boolean" then return value and "true" or "false" end
    if kind ~= "table" then return "null" end
    if field == "snapshot" then return ns.Protocol.JSON(value) end
    if field == "equipment" then return ns.Transfer.GearJSON(value) end
    local entries = {}
    if #value > 0 or field == "money" or field == "levels" or field == "stats" or field == "tooltip" or field == "slots" then
        for _, child in ipairs(value) do entries[#entries+1] = JSON(child) end
        return "[" .. table.concat(entries, ",") .. "]"
    end
    for key, child in pairs(value) do entries[#entries+1] = JSON(tostring(key)) .. ":" .. JSON(child, key) end
    table.sort(entries)
    return "{" .. table.concat(entries, ",") .. "}"
end

local function Character(guid)
    if type(guid) ~= "string" or guid == "" then return nil end
    if type(saved.characters[guid]) ~= "table" then
        saved.characters[guid] = { money = {}, levels = {}, levelSeconds = 0, levelComplete = false }
    end
    return saved.characters[guid]
end

function History.Initialize(database, game)
    db = database
    if type(db.offlineHistory) ~= "table" then
        db.offlineHistory = { version = 1, game = game, account = db.money.account, characters = {} }
    end
    saved = db.offlineHistory
    lastTick, lastGUID, cached, encodedAt = nil, nil, nil, -100
end

function History.Money(guid, delta, balance, epoch)
    if not saved then return end
    local character = Character(guid)
    if not character then return end
    local sequence = (character.moneySequence or 0) + 1
    character.moneySequence = sequence
    character.money[#character.money+1] = { id = sequence, observedAt = GetServerTime(), deltaCopper = delta,
        balanceCopper = balance, epoch = epoch, source = "addon-money-observation" }
end

function History.Equipment(record)
    if not saved or type(record) ~= "table" then return end
    local character = Character(record.guid)
    if character then character.equipment = Copy(record) end
end

function History.Observe(snapshot, payload, force)
    if not saved then return end
    local now, guid = GetTime(), snapshot.guid
    local character = Character(guid)
    if character then
        if snapshot.online and lastGUID == guid and lastTick and now >= lastTick then
            local elapsed = now - lastTick
            if elapsed <= 5 then character.levelSeconds = character.levelSeconds + elapsed
            else character.levelComplete = false end
        end
        local previous = character.snapshot
        if snapshot.level > 0 and (not previous or snapshot.level ~= previous.level) then
            local continuous = previous and snapshot.online and lastGUID == guid and snapshot.level == previous.level + 1
            character.levels[#character.levels+1] = { id = #character.levels + 1, level = snapshot.level,
                fromLevel = previous and previous.level or nil, observedAt = GetServerTime(),
                durationSeconds = continuous and math.floor(character.levelSeconds) or nil,
                durationBasis = continuous and (character.levelComplete and "complete" or "partial") or "unknown" }
            character.levelSeconds, character.levelComplete = 0, continuous and true or false
        end
        character.snapshot = Copy(snapshot)
        if character.snapshot.copper == nil and previous then character.snapshot.copper = previous.copper end
        character.lastSeen = GetServerTime()
    end
    lastGUID, lastTick = snapshot.online and guid or nil, snapshot.online and now or nil
    saved.updatedAt = GetServerTime()
    -- Only the saved JSON includes history. The screen frame retains its bounded v3 snapshot.
    if force or not cached or now - encodedAt >= 10 then
        local balance = "0"
        for _, entry in pairs(saved.characters) do
            if entry.snapshot and type(entry.snapshot.copper) == "number" then
                balance = AddCopper(balance, string.format("%.0f", entry.snapshot.copper))
            end
        end
        saved.balanceCopper = balance
        cached, encodedAt = JSON(saved), now
    end
    db.snapshotJSON = string.sub(payload, 1, -2) .. ',"offlineHistory":' .. cached .. '}'
end
