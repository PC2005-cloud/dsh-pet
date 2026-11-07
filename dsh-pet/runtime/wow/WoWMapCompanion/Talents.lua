-- Public committed class-trait observations. Never read a talent frame's preview config or mutate talents.
local addon, ns = ...
local Talents = {}
ns.Talents = Talents
local Public, Prefix = ns.Protocol.Public, ns.Protocol.UTF8Prefix
local owner, publish, busy, timer, active, dirty, invalidate
local revision, lastCapture, lastSignature, lastStatus, eventSerial = 0, nil, nil, nil, 0

local function Call(fn, ...)
    if type(fn) ~= "function" then return nil end
    local ok, a, b, c = pcall(fn, ...)
    if not ok then return nil end
    return Public(a), Public(b), Public(c)
end
local function Table(value)
    value = Public(value)
    if type(value) ~= "table" then return nil end
    if canaccesstable then
        local ok, allowed = pcall(canaccesstable, value)
        if not ok or Public(allowed) ~= true then return nil end
    end
    return value
end
local function Read(fn, ...)
    if type(fn) ~= "function" then return nil, false end
    local ok, value = pcall(fn, ...)
    if not ok or (issecretvalue and issecretvalue(value)) then return nil, false end
    value = Public(value)
    if type(value) == "table" and not Table(value) then return nil, false end
    return value, true
end
local function Integer(value, low, high)
    value = Public(value)
    return type(value) == "number" and value == value and value >= low and value <= high and value == math.floor(value) and value or nil
end
local function ID(value) return Integer(value, 1, 2147483647) end
local function Rank(value) return Integer(value, 0, 1000) end
local function Bool(value)
    value = Public(value)
    if type(value) == "boolean" then return value end
end
local function Text(value, bytes)
    value = Public(value)
    if type(value) ~= "string" then return nil end
    value = string.gsub(value, "|c%x%x%x%x%x%x%x%x", "")
    value = string.gsub(value, "|r", "")
    value = string.gsub(value, "[%z\1-\31\127]", " ")
    value = string.gsub(value, "\194[\128-\159]", " ")
    return Prefix(value, bytes)
end
local function IDs(value, maximum)
    value = Table(value)
    if not value then return {}, false end
    local result, seen, complete, read = {}, {}, true, 0
    for _, raw in pairs(value) do
        read = read + 1
        if read > 4096 then complete = false; break end
        local id = ID(raw)
        if not id or seen[id] then complete = false
        else seen[id] = true; result[#result + 1] = id end
    end
    table.sort(result)
    while #result > maximum do table.remove(result); complete = false end
    return result, complete
end
local function Identity()
    local guid = Call(UnitGUID, "player")
    return owner and type(owner.session) == "string" and owner.session ~= "" and type(guid) == "string"
        and guid ~= "" and guid == owner.guid and owner.session .. "/" .. guid or nil
end
local function ClassSpec()
    local _, class, classID = Call(UnitClass, "player")
    class = Text(class, 20)
    if not class or not string.match(class, "^[A-Z][A-Z_]+$") then class = nil end
    local api = C_SpecializationInfo or {}
    local index = Integer(Call(api.GetSpecialization or GetSpecialization), 1, 20)
    local spec = index and ID(Call(api.GetSpecializationInfo or GetSpecializationInfo, index)) or nil
    return class, ID(classID), spec
end
local function Build()
    local version, build = Call(GetBuildInfo)
    if type(version) == "string" and string.match(version, "^%d+%.%d+%.%d+$") then
        if type(build) == "number" and Integer(build, 1, 2147483647) then build = tostring(build) end
        if type(build) == "string" and string.match(build, "^%d+$") and #version + #build < 40 then return version .. "." .. build end
    end
end
local function Metadata()
    local class, classID, specID = ClassSpec()
    local configID, readable = Read(C_ClassTalents and C_ClassTalents.GetActiveConfigID)
    configID = ID(configID)
    local record = { v = 1, id = 1, session = owner.session, guid = owner.guid, observedAt = 1, source = "class-traits",
        clientBuild = Build(), locale = Text(Call(GetLocale), 4), class = class, classID = classID, specID = specID, configID = configID,
        status = readable and "unknown" or "inaccessible", scope = "selected-nodes", complete = false, truncated = false,
        treeIDs = {}, knownZeroNodes = {}, nodes = {} }
    if not record.locale or not string.match(record.locale, "^[a-z][a-z][A-Z][A-Z]$") then record.locale = nil end
    if not configID then return record end
    local raw, stagedReadable = Read(C_Traits and C_Traits.ConfigHasStagedChanges, configID)
    record.hasStagedChanges = Bool(raw)
    if not stagedReadable then record.status = "inaccessible"; return record end
    if record.hasStagedChanges == true then record.status = "staged"; return record end
    if record.hasStagedChanges ~= false then return record end
    local info, infoReadable = Read(C_Traits and C_Traits.GetConfigInfo, configID)
    info = Table(info)
    if not info or not infoReadable then record.status = "inaccessible"; return record end
    record.configName, record.configType = Text(info.name, 128), Integer(info.type, 0, 1000)
    local enum = Enum and Table(Enum.TraitConfigType) or nil
    local combat = enum and ID(enum.Combat) or 1
    local camelot = addon == "WoWForeverCompanion" and enum and ID(enum.CamelotCombat) or nil
    local trees, covered = IDs(info.treeIDs, 8)
    record.treeIDs = trees
    if ID(info.ID) == configID and #trees > 0 and (record.configType == combat or (camelot and record.configType == camelot)) then
        record.status, record.complete, record.truncated = "active", covered, not covered
    end
    return record
end

local function Critical(info)
    local entries, covered = IDs(info.entryIDsWithCommittedRanks, 8)
    local selected = Table(info.activeEntry)
    return table.concat({ tostring(ID(info.ID)), tostring(Rank(info.ranksPurchased)), tostring(Rank(info.activeRank)), tostring(selected and ID(selected.entryID)),
        tostring(selected and Rank(selected.rank)), tostring(covered), table.concat(entries, ",") }, ":")
end
local function Capture()
    local record = Metadata()
    if record.status ~= "active" then return record end
    local api, samples, scanned = C_Traits or {}, {}, 0
    local serial = eventSerial
    for _, treeID in ipairs(record.treeIDs) do
        local nodes, covered = IDs(Call(api.GetTreeNodes, treeID), 2048)
        if not covered then record.complete, record.truncated = false, true end
        if #nodes == 0 then record.complete = false end
        for _, nodeID in ipairs(nodes) do
            scanned = scanned + 1
            if scanned > 2048 then record.complete, record.truncated = false, true; break end
            local info = Table(Call(api.GetNodeInfo, record.configID, nodeID))
            if not info or ID(info.ID) ~= nodeID then record.complete = false
            else
                samples[#samples + 1] = { nodeID = nodeID, fingerprint = Critical(info) }
                local purchased, activeRank = Rank(info.ranksPurchased), Rank(info.activeRank)
                if purchased == 0 and activeRank == 0 then
                    if #record.knownZeroNodes < 1024 then record.knownZeroNodes[#record.knownZeroNodes + 1] = { treeID = treeID, nodeID = nodeID }
                    else record.complete, record.truncated = false, true end
                elseif (purchased and purchased > 0) or (activeRank and activeRank > 0) then
                    if #record.nodes >= 128 then record.complete, record.truncated = false, true
                    else
                        local entries, entriesComplete = IDs(info.entryIDsWithCommittedRanks, 8)
                        local conditionIDs, conditionsComplete = IDs(info.conditionIDs, 8)
                        local selected = Table(info.activeEntry)
                        local selectedID = selected and ID(selected.entryID)
                        local node = { treeID = treeID, nodeID = nodeID, ranksPurchased = purchased, activeRank = activeRank, maxRanks = Rank(info.maxRanks),
                            isAvailable = Bool(info.isAvailable), isVisible = Bool(info.isVisible), meetsEdgeRequirements = Bool(info.meetsEdgeRequirements),
                            entriesComplete = entriesComplete, entries = {}, conditionsComplete = conditionsComplete, conditions = {} }
                        for _, entryID in ipairs(entries) do
                            local entryInfo = Table(Call(api.GetEntryInfo, record.configID, entryID))
                            local definitionID = entryInfo and ID(entryInfo.definitionID)
                            local definition = definitionID and Table(Call(api.GetDefinitionInfo, definitionID)) or nil
                            local isActive
                            if selectedID then isActive = entryID == selectedID end
                            node.entries[#node.entries + 1] = { entryID = entryID, definitionID = definitionID, spellID = definition and ID(definition.spellID),
                                rank = entryID == selectedID and Rank(selected.rank) or nil, isActive = isActive }
                            if not entryInfo or (definitionID and not definition)
                                or (entryInfo and issecretvalue and issecretvalue(entryInfo.definitionID))
                                or (definition and issecretvalue and issecretvalue(definition.spellID)) then node.entriesComplete = false end
                        end
                        if #entries == 0 or not selectedID then node.entriesComplete = false end
                        for _, conditionID in ipairs(conditionIDs) do
                            local condition = Table(Call(api.GetConditionInfo, record.configID, conditionID))
                            if condition and ID(condition.condID) ~= conditionID then condition = nil end
                            node.conditions[#node.conditions + 1] = { conditionID = conditionID, isMet = condition and Bool(condition.isMet),
                                playerLevel = condition and Integer(condition.playerLevel, 0, 255),
                                spentAmountRequired = condition and Integer(condition.spentAmountRequired, 0, 2147483647), traitCurrencyID = condition and ID(condition.traitCurrencyID) }
                            if not condition or Bool(condition.isMet) == nil then node.conditionsComplete = false end
                        end
                        if purchased == nil or activeRank == nil or not node.entriesComplete or not node.conditionsComplete then record.complete = false end
                        record.nodes[#record.nodes + 1] = node
                    end
                else record.complete = false end
            end
        end
    end
    -- Rank and committed-entry fingerprints are sampled twice; a shared config ID alone is insufficient.
    for _, sample in ipairs(samples) do
        local info = Table(Call(api.GetNodeInfo, record.configID, sample.nodeID))
        if not info or Critical(info) ~= sample.fingerprint then
            local unknown = Metadata()
            unknown.status, unknown.complete = unknown.hasStagedChanges == true and "staged" or "unknown", false
            return unknown
        end
    end
    local after = Metadata()
    if serial ~= eventSerial or after.status ~= "active" or after.configID ~= record.configID or after.configType ~= record.configType
        or after.class ~= record.class or after.classID ~= record.classID or after.specID ~= record.specID or after.clientBuild ~= record.clientBuild
        or table.concat(after.treeIDs, ",") ~= table.concat(record.treeIDs, ",") then
        after.status, after.complete, after.nodes, after.knownZeroNodes = after.hasStagedChanges == true and "staged" or "unknown", false, {}, {}
        return after
    end
    return record
end

function Talents.Scan()
    timer = nil
    local key = Identity()
    if not active or not key then return end
    if busy() and not (invalidate and lastStatus == "active") then dirty = true; return end
    local observedAt, now = Integer(Call(GetServerTime), 1, 4102444800), Call(GetTime)
    if not observedAt or type(now) ~= "number" or now ~= now or now < 0 or now > 1e10 then return end
    local record
    if busy() then
        record = Metadata()
        record.status, record.complete = record.hasStagedChanges == true and "staged" or "unknown", false
        dirty = true
    else record = Capture(); dirty = false end
    if key ~= Identity() then return end
    local body = ns.Transfer.TalentsJSON(record)
    if #body > 65460 then
        record.complete, record.truncated = false, true
        -- A binary prefix budget avoids re-encoding a large tree once per discarded zero-rank node.
        for _, field in ipairs({ "knownZeroNodes", "nodes" }) do
            local original = record[field]
            record[field] = {}
            body = ns.Transfer.TalentsJSON(record)
            if #body <= 65460 then
                local low, high = 0, #original
                local function PrefixList(count)
                    local result = {}
                    for index = 1, count do result[index] = original[index] end
                    return result
                end
                while low < high do
                    local middle = math.ceil((low + high) / 2)
                    record[field] = PrefixList(middle)
                    if #ns.Transfer.TalentsJSON(record) <= 65460 then low = middle else high = middle - 1 end
                end
                record[field] = PrefixList(low)
                body = ns.Transfer.TalentsJSON(record)
                break
            end
        end
    end
    if body == lastSignature and lastCapture and now - lastCapture < 60 and not invalidate then return end
    revision = revision + 1
    record.id, record.observedAt = revision, observedAt
    if publish(record) then lastCapture, lastSignature, lastStatus, invalidate = now, body, record.status, false end
end
local function Schedule()
    dirty = true
    if not active or timer then return end
    timer = C_Timer.NewTimer(0.5, Talents.Scan)
end
function Talents.Initialize(state, callback, pending) owner, publish, busy = state, callback, pending end
function Talents.OnEvent(event, unit)
    if event == "PLAYER_LOGOUT" or event == "PLAYER_LEAVING_WORLD" then
        active = false
        if timer then timer:Cancel(); timer = nil end
        publish(nil)
    elseif event == "PLAYER_ENTERING_WORLD" then active = true; lastSignature = nil; Schedule()
    elseif event == "PLAYER_SPECIALIZATION_CHANGED" and Public(unit) ~= "player" then return
    elseif event == "PLAYER_SPECIALIZATION_CHANGED" or event == "PLAYER_TALENT_UPDATE" or event == "TRAIT_CONFIG_UPDATED"
        or event == "TRAIT_CONFIG_LIST_UPDATED" or event == "TRAIT_NODE_CHANGED" or event == "TRAIT_TREE_CHANGED" or event == "PLAYER_LEVEL_UP" then
        eventSerial, invalidate = eventSerial + 1, true
        Schedule()
    end
end
function Talents.Tick()
    local now = Call(GetTime)
    if active and not timer and type(now) == "number" and (dirty or not lastCapture or now - lastCapture >= 60)
        and (not busy() or (invalidate and lastStatus == "active")) then Schedule() end
end
