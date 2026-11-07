local _, ns = ...
local Warning = {}
ns.ExplorationWarning = Warning
local Public = ns.Protocol.Public
local L = ns.L or function(text) return text end
local identity, destination, pending

local function Read(fn)
    if type(fn) ~= "function" then return nil end
    local ok, value = pcall(fn)
    if ok then return Public(value) end
end

-- Runtime arrivals belong to one character. Login establishes a baseline, while
-- short loading gaps retain the previous map and discard unfinished warnings.
function Warning.Observe(state)
    if not state.online then pending = nil; return end
    if not state.guid or state.guid == "" or not state.map or state.map <= 0 then return end
    if identity ~= state.guid then
        identity, destination, pending = state.guid, state.map, nil
        return
    end
    local now = Read(GetTime)
    if type(now) ~= "number" then return end
    if destination ~= state.map then
        destination = state.map
        pending = { enteredAt = now }
    end
    if not pending then return end
    -- Let the map and territory APIs settle together after the boundary event.
    if now - pending.enteredAt < 0.25 then return end
    if now - pending.enteredAt > 5 or now < pending.enteredAt then pending = nil; return end
    if state.instanceType == "unknown" then return end
    if state.instanceType ~= "none" or state.dead then pending = nil; return end
    if state.faction ~= "Horde" and state.faction ~= "Alliance" then return end
    local territory = Read(C_PvP and C_PvP.GetZonePVPInfo)
    if territory == "friendly" or territory == "sanctuary" then pending = nil; return end
    -- Missing territory data cannot establish that this is outside friendly land.
    if territory ~= "contested" and territory ~= "hostile" and territory ~= "combat" then return end
    local level = ns.ExplorationLevels and ns.ExplorationLevels[state.map]
    if not level or type(state.level) ~= "number" or state.level <= 0 then pending = nil; return end
    pending = nil
    if state.level >= level.min then return end
    local message = L("这里对现在的你而言太早了，前面的区域，以后再来探索吧")
    if UIErrorsFrame and type(UIErrorsFrame.AddMessage) == "function" then
        UIErrorsFrame:AddMessage(message, 1, 0.82, 0, 1)
    end
    print(L("|cffefd18b[魔兽无限陪伴精灵]|r ") .. message)
    print(string.format("%s · %d–%d · 无限图鉴 wuxianwow.com · https://wuxianwow.com/atlas/%d",
        state.zone, level.min, level.max, state.map))
end
