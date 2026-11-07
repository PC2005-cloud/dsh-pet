-- Only the game confirmation button may start an equipment action.
local addonName, ns = ...
local L = ns.L or function(text) return text end
local ConfirmEquip = {}
ns.ConfirmEquip = ConfirmEquip
local owner, settings, emit, say, publishOffer, publishComparison, popupKey
local queue, current, seen = {}, nil, {}
local online, nextResult, skipped = false, 0, 0
local nextPromptAt, nextOffer = 0, 0
local slots = { INVTYPE_HEAD = { 1 }, INVTYPE_NECK = { 2 }, INVTYPE_SHOULDER = { 3 },
    INVTYPE_CHEST = { 5 }, INVTYPE_ROBE = { 5 }, INVTYPE_WAIST = { 6 }, INVTYPE_LEGS = { 7 },
    INVTYPE_FEET = { 8 }, INVTYPE_WRIST = { 9 }, INVTYPE_HAND = { 10 }, INVTYPE_FINGER = { 11, 12 },
    INVTYPE_TRINKET = { 13, 14 }, INVTYPE_CLOAK = { 15 }, INVTYPE_WEAPONMAINHAND = { 16 },
    INVTYPE_WEAPONOFFHAND = { 17 }, INVTYPE_SHIELD = { 17 }, INVTYPE_HOLDABLE = { 17 },
    INVTYPE_2HWEAPON = { 16 }, INVTYPE_RANGED = { 16 }, INVTYPE_RANGEDRIGHT = { 16 } }
local slotNames = { [1] = L("头部"), [2] = L("项链"), [3] = L("肩部"), [5] = L("胸部"), [6] = L("腰部"),
    [7] = L("腿部"), [8] = L("脚部"), [9] = L("手腕"), [10] = L("手部"), [11] = L("戒指 1"), [12] = L("戒指 2"),
    [13] = L("饰品 1"), [14] = L("饰品 2"), [15] = L("披风"), [16] = L("主手"), [17] = L("副手"), [18] = L("远程") }
local function Query(fn, ...)
    if type(fn) ~= "function" then return nil, false end
    local ok, value = pcall(fn, ...)
    if not ok or (issecretvalue and issecretvalue(value)) then return nil, false end
    if type(value) == "table" and canaccesstable and not canaccesstable(value) then return nil, false end
    return value, true
end
local function Safe(value)
    if issecretvalue and issecretvalue(value) then return nil end
    return value
end
local function String(value) return type(value) == "string" and value ~= "" end
local function Number(value) return type(value) == "number" and value == value and value >= 0 and value < math.huge end
local function Clock() local now = Query(GetTime); return Number(now) and now or 0 end
local function Location(bag, slot)
    if not ItemLocation then return nil end
    if bag == nil then return Query(ItemLocation.CreateFromEquipmentSlot, ItemLocation, slot) end
    return Query(ItemLocation.CreateFromBagAndSlot, ItemLocation, bag, slot)
end
local function TwoHands(loc)
    return loc == "INVTYPE_2HWEAPON" or loc == "INVTYPE_RANGED" or loc == "INVTYPE_RANGEDRIGHT"
end
local function Inventory(slot)
    if not C_Item then return nil end
    local location = Location(nil, slot)
    local exists = location and Query(C_Item.DoesItemExist, location)
    if exists == false then return { id = 0, slot = slot, level = -1, name = L("空槽") } end
    if exists ~= true then return nil end
    local link = Query(GetInventoryItemLink, "player", slot)
    local guid = Query(C_Item.GetItemGUID, location)
    local level = String(link) and Query(C_Item.GetDetailedItemLevelInfo, link)
    local name = String(link) and Query(C_Item.GetItemInfo, link)
    local kind
    if String(link) and type(C_Item.GetItemInfoInstant) == "function" then
        local ok, _, _, _, value = pcall(C_Item.GetItemInfoInstant, link)
        if ok then kind = Safe(value) end
    end
    local id = String(link) and tonumber(string.match(link, "item:(%d+)"))
    if not id or not String(guid) or not String(name) or not Number(level) or not String(kind) then return nil end
    return { id = id, slot = slot, link = link, guid = guid, name = name, level = level, kind = kind }
end
local function Same(a, b)
    return a and b and a.id == b.id and a.guid == b.guid and a.link == b.link
end
local function Identity(record)
    local guid = Query(UnitGUID, "player")
    return online and record.session == owner.session and record.guid == owner.guid and guid == record.guid
end
local function Find(record)
    if not C_Container or not C_Item then return nil, "unavailable" end
    local lastBag = Safe(NUM_TOTAL_EQUIPPED_BAG_SLOTS) or 5
    if not Number(lastBag) or lastBag > 20 then return nil, "restricted" end
    local found
    for bag = 0, lastBag do
        local count = Query(C_Container.GetContainerNumSlots, bag)
        if not Number(count) or count > 200 then return nil, "restricted" end
        for slot = 1, count do
            local info, accessible = Query(C_Container.GetContainerItemInfo, bag, slot)
            if not accessible then return nil, "restricted" end
            if info then
                local location = Location(bag, slot)
                local guid, public = Query(C_Item.GetItemGUID, location)
                if not public then return nil, "restricted" end
                if guid == record.itemGUID then
                    local link = Safe(info.hyperlink)
                    if not String(link) then link = Query(C_Container.GetContainerItemLink, bag, slot) end
                    if link ~= record.link or found then return nil, "changed" end
                    found = { bag = bag, slot = slot, location = location }
                end
            end
        end
    end
    if not found then return nil, "unavailable" end
    local locked = Query(C_Item.IsLocked, found.location)
    if locked == true then return nil, "locked" end
    if locked ~= false then return nil, "restricted" end
    return found
end
local function Eligible(record)
    if not Identity(record) or not String(record.itemGUID) or not String(record.link)
        or not record.infoComplete or not record.statsComplete or not record.tooltipComplete or record.truncated then return false end
    if not Number(record.itemLevel) or not Number(record.requiredLevel) or not String(record.name) then return false end
    local level = Query(UnitLevel, "player")
    if not Number(level) or level < record.requiredLevel then return false end
    -- Passive equipment does not need an item-use action. Capture/Validate also
    -- require current spec compatibility and complete, rechecked upgrade facts.
    return C_Item and Query(C_Item.IsEquippableItem, record.link) == true
end
local function Choose(record)
    local candidates = slots[record.equipLoc]
    local guard = {}
    if record.equipLoc == "INVTYPE_WEAPON" then
        candidates = Query(CanDualWield) == true and { 16, 17 } or { 16 }
    end
    if record.equipLoc == "INVTYPE_RANGED" or record.equipLoc == "INVTYPE_RANGEDRIGHT" then
        -- The Forever client can expose a separate ranged slot. Never infer Retail layout.
        local paper = C_PaperDollInfo
        local shown = paper and Query(paper.IsRangedSlotShown)
        if shown == true then
            local ranged = Query(paper.GetInventorySlotInfo, "RangedSlot")
            if ranged ~= 18 then return nil end
            candidates = { 18 }
        elseif shown ~= false then return nil end
    end
    if not candidates then return nil end
    if candidates[1] == 16 or candidates[1] == 17 then
        local main, off = Inventory(16), Inventory(17)
        if not main or not off then return nil end
        guard[16], guard[17] = main, off
        if TwoHands(record.equipLoc) then
            -- No removal of a second item, or Titan's Grip / dual two-hand inference.
            if off.id ~= 0 or (main.id ~= 0 and not TwoHands(main.kind)) then return nil end
        else
            if main.id ~= 0 and TwoHands(main.kind) then return nil end
            if record.equipLoc == "INVTYPE_WEAPONOFFHAND" and Query(CanDualWield) ~= true then return nil end
            if record.equipLoc == "INVTYPE_WEAPON" and #candidates == 2 and off.id ~= 0
                and off.kind ~= "INVTYPE_WEAPON" and off.kind ~= "INVTYPE_WEAPONOFFHAND" then candidates = { 16 } end
        end
    end
    local chosen
    for _, slot in ipairs(candidates) do
        local old = guard[slot] or Inventory(slot)
        if not old then return nil end
        guard[slot] = old
        if not chosen or old.level < chosen.level then chosen = old end
    end
    if not chosen or record.itemLevel < chosen.level then return nil end
    return chosen, guard
end
local function Offer(entry, status)
    if not publishOffer then return end
    if status == "closed" and (not entry.offer or entry.offer.st ~= "ready") then return end
    local value
    if status == "ready" then
        local remaining, serverTime = entry.expires - Clock(), Query(GetServerTime)
        if remaining < 1 or not Number(serverTime) or serverTime < 1 or serverTime + remaining > 4102444800 then return end
        entry.offerUntil = entry.offerUntil or math.floor(serverTime + remaining)
        if serverTime >= entry.offerUntil then return end
        local name = entry.record.name
        name = string.gsub(name, "|H.-|h(.-)|h", "%1")
        name = string.gsub(name, "|c%x%x%x%x%x%x%x%x", "")
        name = string.gsub(name, "|r", "")
        name = string.gsub(name, "|T.-|t", "")
        name = string.gsub(name, "|A.-|a", "")
        name = string.gsub(name, "[%z\1-\31\127|]", " ")
        name = string.gsub(name, "^%s*(.-)%s*$", "%1")
        name = ns.Protocol.UTF8Prefix(name, 96)
        value = { v = 1, kind = "offer", s = entry.record.session, g = entry.record.guid, id = entry.record.id,
            st = status, slot = entry.old.slot, item = entry.record.itemID, n = name, il = entry.record.itemLevel,
            old = entry.old.id, ol = entry.old.level, ["until"] = entry.offerUntil }
    else
        value = {}
        for key, field in pairs(entry.offer) do value[key] = field end
        value.st = status
    end
    if nextOffer >= 2147483647 then publishOffer(nil); return end
    nextOffer = nextOffer + 1
    value.q = nextOffer
    entry.offer = value
    publishOffer(value)
end
local function Hide(entry)
    if not entry then return end
    Offer(entry, "closed")
    entry.hiding = true
    if type(StaticPopup_Hide) == "function" then StaticPopup_Hide(popupKey, entry) end
    entry.hiding = nil
end
local function Finish(entry, status, reason)
    if entry.done then return end
    entry.done, entry.outcome = true, status
    -- A synchronous equipment event may finish inside StaticPopup's old click handler.
    -- Let that handler close its own dialog before showing the next one.
    nextPromptAt = Clock() + 0.1
    Hide(entry)
    if current == entry then current = nil end
    nextResult = nextResult + 1
    local at = Query(GetServerTime)
    if not Number(at) or at > 4102444800 then at = 0 end
    emit({ v = 1, kind = "swap", s = entry.record.session, g = entry.record.guid, id = nextResult,
        e = entry.record.id, st = status, r = reason, at = math.floor(at), slot = entry.old.slot,
        item = entry.record.itemID, old = entry.old.id })
    if status == "equipped" then say(L("已确认穿戴：") .. entry.record.name)
    elseif status == "failed" and reason == "timeout" then say(L("未能确认换装结果，请检查穿戴栏；不会再次自动执行。"))
    elseif status == "failed" then say(L("本次换装已停止（") .. reason .. L("），请检查装备与角色状态。")) end
end
local function Validate(entry)
    if not Identity(entry.record) then return nil, "changed" end
    if settings.confirmEquip ~= true then return nil, "disabled" end
    local combat = Query(InCombatLockdown)
    if combat == true then return nil, "combat" elseif combat ~= false then return nil, "restricted" end
    local dead = Query(UnitIsDeadOrGhost, "player")
    if dead == true then return nil, "dead" elseif dead ~= false then return nil, "restricted" end
    if not Eligible(entry.record) then return nil, "unavailable" end
    for slot, expected in pairs(entry.guard) do
        if not Same(Inventory(slot), expected) then return nil, "changed" end
        if expected.id ~= 0 then
            local locked = Query(C_Item.IsLocked, Location(nil, slot))
            if locked == true then return nil, "locked" elseif locked ~= false then return nil, "restricted" end
        end
    end
    local comparison,assessment=ns.EquipmentCompare.Capture(owner,entry.record,entry.old.slot)
    if comparison.spec~=entry.comparison.spec or comparison.primary~=entry.comparison.primary
        or comparison.class~=entry.comparison.class or not ns.EquipmentCompare.CanOffer(assessment) then return nil,"changed" end
    entry.assessment,entry.comparison=assessment,comparison
    return Find(entry.record)
end
local function Verify(entry, fromClick)
    if entry ~= current or entry.phase ~= "await" or not Identity(entry.record) then return false end
    local location = Location(nil, entry.old.slot)
    if location and Query(C_Item.GetItemGUID, location) == entry.record.itemGUID then
        Finish(entry, "equipped", "confirmed")
        if not fromClick and Query(GetCursorInfo) ~= nil then say(L("换装已核实，鼠标上若有旧装备请自行放回背包；不会异步移动光标物品。")) end
        return true
    end
    return false
end
local function Accept(_, entry)
    if entry ~= current or entry.done or entry.phase ~= "prompt" then return end
    if Clock() >= entry.expires then Finish(entry, "expired", "timeout"); return end
    local found, reason = Validate(entry)
    if not found then Finish(entry, "failed", reason); return end
    local cursor, public = Query(GetCursorInfo)
    if not public then Finish(entry, "failed", "restricted"); return end
    if cursor ~= nil then Finish(entry, "failed", "cursor"); return end
    local paper = C_PaperDollInfo
    local cursorCanGo = paper and (paper.CursorCanGoInSlot or paper.CanCursorCanGoInSlot)
    if type(C_Container.PickupContainerItem) ~= "function" or type(PickupInventoryItem) ~= "function"
        or type(cursorCanGo) ~= "function" or type(IsInventoryItemLocked) ~= "function" then
        Finish(entry, "failed", "unavailable"); return
    end
    -- Set this before either action to guard synchronous events and a second click.
    entry.phase, entry.awaitUntil = "await", Clock() + 45
    Offer(entry, "closed")
    local ok = pcall(C_Container.PickupContainerItem, found.bag, found.slot)
    if not ok then Finish(entry, "failed", "restricted"); return end
    -- Pickup can synchronously dispatch events or hooks that cancel this request.
    if entry ~= current or entry.done or entry.phase ~= "await" then return end
    if not Identity(entry.record) then Finish(entry, "failed", "changed"); return end
    if settings.confirmEquip ~= true then Finish(entry, "failed", "disabled"); return end
    local combat, dead = Query(InCombatLockdown), Query(UnitIsDeadOrGhost, "player")
    if combat ~= false or dead ~= false then
        Finish(entry, "failed", combat == true and "combat" or dead == true and "dead" or "restricted"); return
    end
    for slot, expected in pairs(entry.guard) do
        if not Same(Inventory(slot), expected) then Finish(entry, "failed", "changed"); return end
    end
    local got, kind, itemID, link = pcall(GetCursorInfo)
    kind, itemID, link = Safe(kind), Safe(itemID), Safe(link)
    if not got or kind ~= "item" or itemID ~= entry.record.itemID or link ~= entry.record.link then
        Finish(entry, "failed", "cursor"); return
    end
    local canGo = Query(cursorCanGo, entry.old.slot)
    if canGo ~= true then Finish(entry, "failed", canGo == false and "unavailable" or "restricted"); return end
    local locked = Query(IsInventoryItemLocked, entry.old.slot)
    if locked ~= false then Finish(entry, "failed", locked == true and "locked" or "restricted"); return end
    if entry ~= current or entry.done then return end
    if not Identity(entry.record) then Finish(entry, "failed", "changed"); return end
    if settings.confirmEquip ~= true then Finish(entry, "failed", "disabled"); return end
    combat, dead = Query(InCombatLockdown), Query(UnitIsDeadOrGhost, "player")
    if combat ~= false or dead ~= false then
        Finish(entry, "failed", combat == true and "combat" or dead == true and "dead" or "restricted"); return
    end
    ok = pcall(PickupInventoryItem, entry.old.slot)
    if not ok then Finish(entry, "failed", "restricted"); return end
    -- Native binding, refund and trade dialogs remain entirely player controlled.
    if not entry.done and not Verify(entry, true) then say(L("已提交换装，请处理游戏原生确认（如有）；正在核对穿戴结果。")) end
    -- Only this same click can return the approved old item to the now-empty source.
    -- If a native confirmation completes later, never manipulate its cursor in an event.
    if entry.outcome == "equipped" and entry.old.id ~= 0 and Identity(entry.record)
        and settings.confirmEquip == true and Query(InCombatLockdown) == false and Query(UnitIsDeadOrGhost, "player") == false then
        local cursorOK, cursorKind, cursorID, cursorLink = pcall(GetCursorInfo)
        cursorKind, cursorID, cursorLink = Safe(cursorKind), Safe(cursorID), Safe(cursorLink)
        local empty, readable = Query(C_Container.GetContainerItemInfo, found.bag, found.slot)
        if cursorOK and cursorKind == "item" and cursorID == entry.old.id and cursorLink == entry.old.link
            and readable and empty == nil and Query(C_Item.GetItemGUID, Location(nil, entry.old.slot)) == entry.record.itemGUID then
            pcall(C_Container.PickupContainerItem, found.bag, found.slot)
        end
    end
    if Query(GetCursorInfo) ~= nil then say(L("若鼠标上仍有装备，请自行放回背包；插件不会清理或丢弃光标物品。")) end
end
local function Cancel(_, entry, reason)
    if entry ~= current or entry.done or entry.hiding or entry.phase ~= "prompt" then return end
    if reason == "timeout" then Finish(entry, "expired", "timeout")
    elseif reason == "clicked" then Finish(entry, "declined", "user")
    else Finish(entry, "failed", "unavailable") end
end
function ConfirmEquip.Initialize(state, config, callback, printer, proposalCallback, comparisonCallback)
    owner, settings, emit, say, publishOffer = state, config, callback, printer, proposalCallback
    publishComparison=comparisonCallback
    queue, current, seen, online, nextResult, skipped = {}, nil, {}, false, 0, 0
    nextPromptAt, nextOffer = 0, 0
    if type(settings.confirmEquip) ~= "boolean" then settings.confirmEquip = true end
    popupKey = string.upper(addonName) .. "_CONFIRM_EQUIP"
    if type(StaticPopupDialogs) ~= "table" then return end
    StaticPopupDialogs[popupKey] = { text = "%s", button1 = L("确认换装"), button2 = L("保留原装备"), timeout = 120,
        whileDead = false, hideOnEscape = true, enterClicksFirstButton = false, preferredIndex = 3,
        OnAccept = Accept, OnCancel = Cancel,
        OnHide = function(_, entry)
            if entry then Offer(entry, "closed") end
            if entry == current and not entry.hiding and entry.phase == "prompt" then
                -- OnCancel can run after OnHide. Tick handles an unexplained hide later.
                entry.hidden = true
            end
        end }
end
function ConfirmEquip.Add(record)
    if seen[record.id] then return end
    seen[record.id] = true
    local comparison,assessment=ns.EquipmentCompare.Capture(owner,record)
    local published=publishComparison and publishComparison(comparison)
    if settings.confirmEquip ~= true or published~=true or not ns.EquipmentCompare.CanOffer(assessment) then skipped=skipped+1; return false end
    if not Eligible(record) then skipped = skipped + 1; return false end
    local old, guard = Choose(record)
    if not old or old.slot~=comparison.slot or not Find(record) then skipped = skipped + 1; return false end
    if #queue + (current and 1 or 0) >= 6 then skipped = skipped + 1; return false end
    queue[#queue + 1] = { record = record, old = old, guard = guard, comparison=comparison, assessment=assessment, phase = "queued", expires = Clock() + 120 }
    ConfirmEquip.Tick()
    return true
end
function ConfirmEquip.Tick()
    if current and current.phase == "await" then
        if not Identity(current.record) then Finish(current, "failed", "changed"); return end
        if not Verify(current) and Clock() >= current.awaitUntil then Finish(current, "failed", "timeout") end
        return
    end
    if current and current.hidden then Finish(current, "failed", "unavailable"); return end
    if not current then
        if Clock() < nextPromptAt then return end
        current = table.remove(queue, 1)
    end
    local entry = current
    if not entry then return end
    if Clock() >= entry.expires then Finish(entry, "expired", "timeout"); return end
    if not online or settings.confirmEquip ~= true then Hide(entry); return end
    if Query(InCombatLockdown) ~= false or Query(UnitIsDeadOrGhost, "player") ~= false then
        entry.phase, entry.hidden = "queued", nil
        Hide(entry)
        return
    end
    if entry.phase == "prompt" then
        local found, reason = Validate(entry)
        if not found then Finish(entry, "failed", reason) end
        return
    end
    if type(StaticPopup_IsAnyDialogShown) == "function" and StaticPopup_IsAnyDialogShown() then return end
    local found, reason = Validate(entry)
    if not found then Finish(entry, "failed", reason); return end
    if type(StaticPopup_Show) ~= "function" then Finish(entry, "failed", "unavailable"); return end
    entry.phase, entry.hidden = "prompt", nil
    local remaining = entry.expires - Clock()
    StaticPopupDialogs[popupKey].timeout = math.min(120, remaining)
    local tradeoff=entry.assessment.reason=="primary_upgrade_tradeoff"
    local explanation=tradeoff and L("装等和当前主属性提高，但副属性有取舍，综合收益未确定。请核对后决定。")
        or L("已核对专精、类型及量化属性：无属性下降且至少一项提升，或对应栏位为空。")
    local text = string.format(L("%s，是否换装？\n\n%s：%s（装等 %s）\n替换为：%s（装等 %s）\n\n%s\n%s\n套装、特效、附魔仍需自行复核。\n点击后可能仍需处理游戏原生绑定、退款或交易确认。\n剩余最多 %d 秒，请在游戏内点击确认。"),
        tradeoff and L("发现主属性提高但副属性有取舍的装备") or L("发现同类属性明确提升或可用空槽装备"),
        slotNames[entry.old.slot], entry.old.name, entry.old.id == 0 and "—" or tostring(entry.old.level), entry.record.name, tostring(entry.record.itemLevel),
        explanation,ns.EquipmentCompare.Describe(entry.comparison),math.floor(remaining))
    local dialog = StaticPopup_Show(popupKey, text, nil, entry)
    if not dialog and not entry.done then Finish(entry, "failed", "unavailable")
    elseif dialog and entry == current and not entry.done and entry.phase == "prompt" and not entry.hidden then
        if Query(dialog.IsShown, dialog) ~= true then Finish(entry, "failed", "unavailable")
        else
            local confirmed, failure = Validate(entry)
            if confirmed then Offer(entry, "ready") else Finish(entry, "failed", failure) end
        end
    end
end
local function CancelAll(reason)
    if current then Finish(current, "failed", reason) end
    for _, entry in ipairs(queue) do Finish(entry, "failed", reason) end
    queue = {}
end
function ConfirmEquip.OnEvent(event)
    if event == "PLAYER_ENTERING_WORLD" then online = true
    elseif event == "PLAYER_LEAVING_WORLD" or event == "PLAYER_LOGOUT" then online = false; CancelAll("left_world")
    elseif event == "PLAYER_REGEN_DISABLED" or event == "PLAYER_DEAD" then
        if current and current.phase == "await" then Finish(current, "failed", event == "PLAYER_DEAD" and "dead" or "combat")
        elseif current then current.phase = "queued"; current.hidden = nil; Hide(current) end
    elseif event == "PLAYER_EQUIPMENT_CHANGED" and current and current.phase == "await" then Verify(current) end
    if event ~= "PLAYER_REGEN_DISABLED" and event ~= "PLAYER_DEAD" then ConfirmEquip.Tick() end
end
function ConfirmEquip.Command(arg)
    local target=string.match(arg,"^check%s+(%d+)$")
    if arg=="check" or target then
        if settings.confirmEquip~=true then say(L("确认换装询问已关闭，请先使用 equip on。")); return end
        local accepted,unready=ns.Equipment.Review(ConfirmEquip.Add,target and tonumber(target))
        say(string.format(L("背包装备复查：提出 %d 件，资料未就绪 %d 件；未写入新的装备获取历史。"),accepted,unready))
        return
    elseif arg == "on" then settings.confirmEquip = true; say(L("确认换装询问已开启，只处理此后新观察到的装备。"))
    elseif arg == "off" then settings.confirmEquip = false; CancelAll("disabled"); say(L("确认换装询问已关闭。"))
    elseif arg ~= "status" then say(L("用法：equip on | off | status | check [物品ID]")); return end
    say(ConfirmEquip.Status())
end
function ConfirmEquip.Status()
    return string.format(L("确认换装：%s · 等待 %d/6 · 条件不足跳过 %d · 仅游戏内逐件确认"), settings.confirmEquip and L("开启") or L("关闭"), #queue + (current and 1 or 0), skipped)
end
