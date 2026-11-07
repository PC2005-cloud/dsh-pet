local _, ns = ...
local GroupBuffs = {}
ns.GroupBuffs = GroupBuffs
local Public = ns.Protocol.Public

-- Only long-lived, castable group buffs belong here. Passive auras and combat cooldowns do not.
local rules = {
    WARRIOR = { spell = 6673 }, MAGE = { spell = 1459 }, PRIEST = { spell = 21562 },
    DRUID = { spell = 1126 }, SHAMAN = { spell = 462854 },
    -- Bronze applies different aura IDs by recipient class. Its localized aura name matches the cast name.
    EVOKER = { spell = 364342, aura = 381748, byName = true },
}
local allowed = { party = true, raid = true, pvp = true, scenario = true }
local inWorld, context, enteredAt, entry, sequence, candidate = false, nil, 0, 0, 0, nil

local function Readable(value)
    return Public(value) ~= nil and type(value) == "table" and (not canaccesstable or canaccesstable(value))
end

local function Eligible(unit)
    if Public(UnitExists(unit)) ~= true or Public(UnitIsConnected(unit)) ~= true
        or Public(UnitIsDeadOrGhost(unit)) ~= false or Public(UnitIsVisible(unit)) ~= true then return false end
    if unit ~= "player" then
        local nearby, checked = UnitInRange(unit)
        if Public(nearby) ~= true or Public(checked) ~= true then return false end
    end
    return true
end

local function HasBuff(unit, rule, name)
    if not Eligible(unit) then return nil end
    local uncertain = false
    -- A nil lookup by spell ID can also mean restricted data. Enumerate a complete public aura list instead.
    for index = 1, 255 do
        local aura = C_UnitAuras.GetAuraDataByIndex(unit, index, "HELPFUL")
        if issecretvalue and issecretvalue(aura) then return nil end
        if aura == nil then
            if uncertain then return nil end
            return false
        end
        if not Readable(aura) then return nil end
        local id = Public(aura.spellId)
        local auraName = rule.byName and Public(aura.name)
        if type(id) ~= "number" or (rule.byName and type(auraName) ~= "string") then uncertain = true end
        if id == rule.spell or (rule.aura and id == rule.aura) or (rule.byName and auraName == name) then return true end
    end
    -- A bounded or restricted enumeration never establishes absence.
    return nil
end

local function Capture()
    local result = { e = entry, q = sequence, st = "inactive", spell = 0, name = "", missing = 0,
        checked = 0, total = 0, instanceType = "unknown", instanceID = 0 }
    local inside, instanceType = IsInInstance()
    instanceType = Public(instanceType)
    if not inWorld or Public(inside) ~= true or not allowed[instanceType or ""] or Public(IsInGroup()) ~= true then
        context, candidate = nil, nil
        return result
    end
    local _, _, _, _, _, _, _, instanceID = GetInstanceInfo()
    instanceID = ns.Protocol.InstanceID(instanceID)
    if not instanceID then candidate = nil; return result end
    local key = instanceType .. ":" .. instanceID
    local now = GetTime()
    if key ~= context then
        context, enteredAt, entry, candidate = key, now, entry + 1, nil
    end
    result.e, result.st, result.instanceType, result.instanceID = entry, "waiting", instanceType, instanceID
    if Public(InCombatLockdown()) ~= false or Public(UnitAffectingCombat("player")) ~= false
        or Public(UnitIsDeadOrGhost("player")) ~= false or now - enteredAt < 5 then candidate = nil; return result end
    local _, class = UnitClass("player")
    local rule = rules[Public(class) or ""]
    if not rule or not C_SpellBook or type(C_SpellBook.IsSpellKnown) ~= "function"
        or Public(C_SpellBook.IsSpellKnown(rule.spell)) ~= true
        or not C_UnitAuras or type(C_UnitAuras.GetAuraDataByIndex) ~= "function" then candidate = nil; return result end
    local name = Public(C_Spell.GetSpellName(rule.spell))
    if type(name) ~= "string" or #name == 0 or #name > 96 or string.find(name, "[%z\1-\31\127|]") then
        candidate = nil; return result
    end
    result.spell, result.name = rule.spell, name
    local raid = Public(IsInRaid())
    local count = Public(GetNumGroupMembers())
    if type(raid) ~= "boolean" or type(count) ~= "number" or count < 2 or count > 40 then candidate = nil; return result end
    result.total = count
    local absent = {}
    for index = 1, count do
        local unit = raid and ("raid" .. index) or (index == 1 and "player" or "party" .. (index - 1))
        local has = HasBuff(unit, rule, name)
        if has ~= nil then result.checked = result.checked + 1 end
        if has == false then
            local guid = Public(UnitGUID(unit))
            if type(guid) == "string" then absent[#absent + 1] = guid end
        end
    end
    table.sort(absent)
    result.missing = #absent
    local signature = rule.spell .. ":" .. table.concat(absent, ",")
    -- Two separated observations of the same missing members avoid alerts during loading or a buff cast.
    if #absent > 0 and candidate and candidate.signature == signature and now - candidate.at >= 2 then
        result.st = "ready"
    else
        candidate = #absent > 0 and { signature = signature, at = now } or nil
    end
    return result
end

function GroupBuffs.Next()
    sequence = sequence + 1
    local ok, result = pcall(Capture)
    if not ok then
        candidate = nil
        return { e = entry, q = sequence, st = "inactive", spell = 0, name = "", missing = 0,
            checked = 0, total = 0, instanceType = "unknown", instanceID = 0 }
    end
    result.q = sequence
    return result
end

function GroupBuffs.Initialize()
    local frame = CreateFrame("Frame")
    frame:RegisterEvent("PLAYER_ENTERING_WORLD")
    frame:RegisterEvent("PLAYER_LEAVING_WORLD")
    frame:SetScript("OnEvent", function(_, event)
        inWorld = event == "PLAYER_ENTERING_WORLD"
        if not inWorld then context, candidate = nil, nil end
    end)
end
