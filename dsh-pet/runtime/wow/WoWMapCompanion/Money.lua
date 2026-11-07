-- Account-local identity and per-character copper counters survive reloads.
local _, ns = ...
local L = ns.L or function(text) return text end
local Money = {}
ns.Money = Money
local MAX_INTEGER = 9007199254740991
local saved, currentGUID, currentLedger, previousCopper

local function Integer(value)
    value = ns.Protocol.Public(value)
    if type(value) ~= "number" or value ~= value or value < 0 or value > MAX_INTEGER or value ~= math.floor(value) then return nil end
    return value
end

local function Identity(value)
    return type(value) == "string" and #value > 0 and #value <= 40 and string.match(value, "^[%w%-_]+$")
end

local function NewIdentity()
    local ok, value = false, nil
    if type(GetServerTime) == "function" then ok, value = pcall(GetServerTime) end
    local timestamp = ok and Integer(value) or 0
    return string.format("%.0f-%06d-%06d", timestamp or 0, math.random(100000, 999999), math.random(100000, 999999))
end

local function NewLedger()
    return { epoch = NewIdentity(), earned = 0, spent = 0 }
end

function Money.Initialize(db)
    if type(db.money) ~= "table" then db.money = {} end
    saved = db.money
    if not Identity(saved.account) then saved.account = NewIdentity() end
    if type(saved.characters) ~= "table" then saved.characters = {} end
    currentGUID, currentLedger, previousCopper = nil, nil, nil
end

function Money.Sample(guid, online)
    if type(guid) ~= "string" or guid == "" then
        previousCopper = nil
        return saved.account, currentLedger and currentLedger.epoch or "", nil,
            currentLedger and currentLedger.earned or 0, currentLedger and currentLedger.spent or 0
    end
    if guid ~= currentGUID then
        local record = saved.characters[guid]
        if type(record) ~= "table" or not Identity(record.epoch) or not Integer(record.earned) or not Integer(record.spent) then
            record = NewLedger()
            saved.characters[guid] = record
        end
        currentGUID, currentLedger, previousCopper = guid, record, nil
    end
    local copper
    if online and type(GetMoney) == "function" then
        local ok, value = pcall(GetMoney)
        if ok then copper = Integer(value) end
    end
    -- Loading, inaccessible values and new sessions break continuity. Never infer a transaction across that gap.
    if copper and previousCopper then
        local delta = copper - previousCopper
        local key, amount = delta >= 0 and "earned" or "spent", math.abs(delta)
        if currentLedger[key] > MAX_INTEGER - amount then
            currentLedger = NewLedger()
            saved.characters[guid] = currentLedger
        end
        currentLedger[key] = currentLedger[key] + amount
        if delta ~= 0 and ns.OfflineHistory then ns.OfflineHistory.Money(guid, delta, copper, currentLedger.epoch) end
    end
    previousCopper = copper
    return saved.account, currentLedger.epoch, copper, currentLedger.earned, currentLedger.spent
end

function Money.Format(copper)
    if copper == nil then return L("金币暂不可用") end
    return string.format(L("%.0f金 %d银 %d铜"), math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100)
end
