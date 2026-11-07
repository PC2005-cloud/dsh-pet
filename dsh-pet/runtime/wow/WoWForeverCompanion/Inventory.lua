-- Read-only carried materials. Bank contents remain unknown and never enter this snapshot.
local _, ns = ...
local Inventory = {}
ns.Inventory = Inventory
local Public = ns.Protocol.Public
local owner, publish, busy, timer, active
local revision, lastSignature, lastCapture = 0, nil, nil

local function Read(fn, ...)
    if type(fn) ~= "function" then return nil, false end
    local ok, value = pcall(fn, ...)
    if not ok or (issecretvalue and issecretvalue(value)) then return nil, false end
    value = Public(value)
    if type(value) == "table" and canaccesstable then
        local allowed, accessible = pcall(canaccesstable, value)
        if not allowed or Public(accessible) ~= true then return nil, false end
    end
    return value, true
end

local function Integer(value, minimum, maximum)
    value = Public(value)
    return type(value) == "number" and value == value and value >= minimum and value <= maximum
        and value == math.floor(value) and value or nil
end

local function Identity()
    local guid, readable = Read(UnitGUID, "player")
    return readable and type(guid) == "string" and owner and guid == owner.guid
        and type(owner.session) == "string" and owner.session ~= "" and guid ~= ""
end

function Inventory.Scan(force)
    timer = nil
    if not active or not Identity() then return end
    local session, guid, counts, complete = owner.session, owner.guid, {}, true
    -- Only equipped bags are eligible. Missing bag metadata makes the capture partial.
    local lastBag = Integer(NUM_TOTAL_EQUIPPED_BAG_SLOTS, 0, 5)
    if not lastBag then lastBag, complete = 0, false end
    for bag = 0, lastBag do
        local value, readable = Read(C_Container and C_Container.GetContainerNumSlots, bag)
        local slots = readable and Integer(value, 0, 200)
        if not slots then complete = false
        else
            for slot = 1, slots do
                local info, accessible = Read(C_Container and C_Container.GetContainerItemInfo, bag, slot)
                if not accessible then complete = false
                elseif info ~= nil then
                    if type(info) ~= "table" then complete = false
                    else
                        local id = Integer(info.itemID, 1, 2147483647)
                        local quantity = Integer(info.stackCount, 1, 2147483647)
                        if not id or not quantity or (counts[id] or 0) + quantity > 2147483647 then complete = false
                        else counts[id] = (counts[id] or 0) + quantity end
                    end
                end
            end
        end
    end
    if not Identity() or session ~= owner.session or guid ~= owner.guid then return end
    local ids, items, signature = {}, {}, {}
    for id in pairs(counts) do ids[#ids + 1] = id end
    table.sort(ids)
    if #ids > 1000 then complete = false end
    for index = 1, math.min(1000, #ids) do
        local id = ids[index]
        items[#items + 1] = { itemID = id, quantity = counts[id] }
        signature[#signature + 1] = id .. ":" .. counts[id]
    end
    local observedAt = Integer(Read(GetServerTime), 1, 4102444800)
    if not observedAt then return end
    local stamp = session .. "/" .. guid .. "/" .. tostring(complete) .. "/" .. table.concat(signature, ",")
    local now = Read(GetTime)
    if type(now) ~= "number" or now ~= now or now < 0 or now > 1e10 then return end
    if not force and stamp == lastSignature and lastCapture and now - lastCapture < 30 then return end
    revision = revision + 1
    if publish({ v = 1, id = revision, session = session, guid = guid, observedAt = observedAt,
        source = "bags", bank = "unknown", complete = complete, items = items }) then
        lastSignature, lastCapture = stamp, now
    end
end

local function Schedule()
    if not active or timer then return end
    timer = C_Timer.NewTimer(0.4, function() Inventory.Scan(false) end)
end

function Inventory.Initialize(state, callback, pending)
    owner, publish, busy = state, callback, pending
end

function Inventory.OnEvent(event)
    if event == "PLAYER_LEAVING_WORLD" or event == "PLAYER_LOGOUT" then
        active = false
        if timer then timer:Cancel(); timer = nil end
        lastSignature, lastCapture = nil, nil
        publish(nil)
    elseif event == "PLAYER_ENTERING_WORLD" then
        active = true
        Schedule()
    elseif event == "BAG_UPDATE_DELAYED" or event == "ITEM_PUSH" then Schedule() end
end

function Inventory.Tick()
    local now = Read(GetTime)
    -- Refresh a quiet inventory only after its first transmission, so large revisions can finish.
    if active and not timer and type(now) == "number" and (not lastCapture or now - lastCapture >= 30)
        and not busy() then Schedule() end
end
