-- Read-only task observations. Coverage is not completion; only TURNED_IN records prove a session turn-in.
local _, ns = ...
local Quests = {}
ns.Quests = Quests
local Public, Prefix = ns.Protocol.Public, ns.Protocol.UTF8Prefix
local owner, publish, busy, timer, active, dirty
local revision, lastCapture, lastSignature = 0, nil, nil
local turnIns, turnInTruncated, identity = {}, false, nil

local function Call(fn, ...)
    if type(fn) ~= "function" then return nil end
    local ok, a, b = pcall(fn, ...)
    if not ok then return nil end
    return Public(a), Public(b)
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
local function Integer(value, low, high)
    value = Public(value)
    return type(value) == "number" and value == value and value >= low and value <= high
        and value == math.floor(value) and value or nil
end
local function Bool(value)
    value = Public(value)
    if type(value) == "boolean" then return value end
end
local function Text(value, bytes)
    value = Public(value)
    if type(value) ~= "string" then return nil, false end
    value = string.gsub(value, "|c%x%x%x%x%x%x%x%x", "")
    value = string.gsub(value, "|r", "")
    value = string.gsub(value, "[%z\1-\31\127]", " ")
    value = string.gsub(value, "\194[\128-\159]", " ")
    return Prefix(value, bytes), #value > bytes
end
local function Identity()
    local guid = Call(UnitGUID, "player")
    return owner and type(owner.session) == "string" and owner.session ~= "" and type(guid) == "string"
        and guid ~= "" and guid == owner.guid and owner.session .. "/" .. guid or nil
end
local function ResetIdentity(key)
    if key ~= identity then
        identity, turnIns, turnInTruncated, lastSignature, lastCapture = key, {}, false, nil, nil
    end
end
local function Schedule()
    dirty = true
    if not active or timer then return end
    timer = C_Timer.NewTimer(0.5, function() Quests.Scan() end)
end

function Quests.Scan()
    timer = nil
    local key = Identity()
    if not active or not key then return end
    ResetIdentity(key)
    if busy() then dirty = true; return end
    local observedAt = Integer(Call(GetServerTime), 1, 4102444800)
    local now = Call(GetTime)
    if not observedAt or type(now) ~= "number" or now ~= now or now < 0 or now > 1e10 then return end
    local api = C_QuestLog or {}
    local shown, total = Call(api.GetNumQuestLogEntries)
    shown, total = Integer(shown, 0, 1000), Integer(total, 0, 1000)
    local log = { complete = shown ~= nil and total ~= nil, truncated = false, total = total, entries = {} }
    local seen, header, found = {}, nil, 0
    for index = 1, math.min(shown or 0, 600) do
        local info = Table(Call(api.GetInfo, index))
        if not info then log.complete = false
        elseif Bool(info.isHeader) == true then header = Text(info.title, 128)
        elseif Bool(info.isHeader) == false then
            local id = Integer(info.questID, 1, 2147483647)
            if not id or seen[id] then log.complete = false
            else
                seen[id], found = true, found + 1
                if #log.entries >= 50 then log.complete, log.truncated = false, true
                else
                    local title, cut = Text(info.title, 128)
                    local entry = { questID = id, title = title, level = Integer(info.level, 0, 255), header = header,
                        readyForTurnIn = Bool(Call(api.ReadyForTurnIn, id)), failed = Bool(Call(api.IsFailed, id)),
                        objectivesComplete = true, objectives = {} }
                    if cut then log.truncated = true end
                    local objectives = Table(Call(api.GetQuestObjectives, id))
                    if not objectives then entry.objectivesComplete = false
                    else
                        if #objectives > 8 then entry.objectivesComplete, log.truncated = false, true end
                        for objectiveIndex = 1, math.min(#objectives, 8) do
                            local value = Table(objectives[objectiveIndex])
                            if not value then entry.objectivesComplete = false
                            else
                                local text, clipped = Text(value.text, 256)
                                local kind, kindClipped = Text(value.type, 40)
                                local objective = { index = objectiveIndex, text = text, type = kind,
                                    fulfilled = Integer(value.numFulfilled, 0, 2147483647), required = Integer(value.numRequired, 0, 2147483647), finished = Bool(value.finished) }
                                if clipped or kindClipped then log.truncated = true; entry.objectivesComplete = false end
                                if text == nil or kind == nil or objective.fulfilled == nil or objective.required == nil or objective.finished == nil then entry.objectivesComplete = false end
                                entry.objectives[#entry.objectives + 1] = objective
                            end
                        end
                    end
                    log.entries[#log.entries + 1] = entry
                end
            end
        else log.complete = false end
    end
    if (shown or 0) > 600 then log.truncated = true end
    table.sort(log.entries, function(a, b) return a.questID < b.questID end)
    log.complete = log.complete and not log.truncated and total == found and total == #log.entries
    local completion = { source = "unknown", scope = "unknown", complete = false, truncated = turnInTruncated, total = nil, ids = {}, turnIns = turnIns }
    local completed = Table(Call(api.GetAllCompletedQuestIDs))
    if completed then
        completion.source, completion.complete, completion.total = "completed-api", true, 0
        local unique, read = {}, 0
        for _, value in pairs(completed) do
            read = read + 1
            if read > 100000 then completion.complete, completion.truncated = false, true; break end
            local id = Integer(value, 1, 2147483647)
            if not id then completion.complete = false
            elseif not unique[id] then unique[id] = true; completion.ids[#completion.ids + 1] = id end
        end
        table.sort(completion.ids)
        completion.total = #completion.ids
        while #completion.ids > 512 do table.remove(completion.ids); completion.truncated = true end
        completion.complete = completion.complete and not completion.truncated
    elseif #turnIns > 0 then completion.source = "session-events" end
    if key ~= Identity() then return end
    local record = { v = 1, id = 1, session = owner.session, guid = owner.guid, observedAt = 1, source = "quest-log", log = log, completion = completion }
    -- Trim only explicit coverage, not the main heartbeat or other transfer queues.
    local body = ns.Transfer.QuestsJSON(record)
    -- Reserve room for the real revision and epoch replacing the one-byte signature placeholders.
    while #body > 32700 and #log.entries > 0 do
        table.remove(log.entries)
        log.complete, log.truncated = false, true
        body = ns.Transfer.QuestsJSON(record)
    end
    local signature = body
    if signature == lastSignature and lastCapture and now - lastCapture < 60 then dirty = false; return end
    revision = revision + 1
    record.id, record.observedAt = revision, observedAt
    if publish(record) then lastCapture, lastSignature, dirty = now, signature, false end
end

function Quests.Initialize(state, callback, pending) owner, publish, busy = state, callback, pending end
function Quests.OnEvent(event, questID)
    if event == "PLAYER_LOGOUT" or event == "PLAYER_LEAVING_WORLD" then
        active = false
        if timer then timer:Cancel(); timer = nil end
        publish(nil)
    elseif event == "PLAYER_ENTERING_WORLD" then
        active = true
        ResetIdentity(Identity())
        Schedule()
    elseif event == "QUEST_TURNED_IN" then
        local key, id, now = Identity(), Integer(questID, 1, 2147483647), Integer(Call(GetServerTime), 1, 4102444800)
        if not active or not key or not id or not now then return end
        ResetIdentity(key)
        for index = #turnIns, 1, -1 do if turnIns[index].questID == id then table.remove(turnIns, index) end end
        turnIns[#turnIns + 1] = { questID = id, observedAt = now }
        if #turnIns > 32 then table.remove(turnIns, 1); turnInTruncated = true end
        Schedule()
    elseif event == "QUEST_LOG_UPDATE" or event == "QUEST_ACCEPTED" or event == "QUEST_REMOVED" or event == "QUEST_WATCH_UPDATE" then Schedule() end
end
function Quests.Tick()
    local now = Call(GetTime)
    if active and not timer and not busy() and type(now) == "number" and (dirty or not lastCapture or now - lastCapture >= 60) then Schedule() end
end
