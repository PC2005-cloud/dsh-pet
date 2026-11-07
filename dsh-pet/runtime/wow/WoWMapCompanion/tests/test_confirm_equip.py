"""Run the actual confirmation callback and item APIs in Lua 5.1."""
import binascii
import json
import struct
import unittest

from test_addon import LuaRuntime, MOCK, ROOT
from test_equipment import EQUIPMENT_MOCK

CONFIRM_MOCK = r'''
Model.level=90
function GetSpecializationInfo() return Model.spec,"Spec","Description",123,"DAMAGER",4 end
if C_SpecializationInfo then C_SpecializationInfo.GetSpecializationInfo=function(...) return GetSpecializationInfo(...) end end
local BaseNewItem=NewItem
function NewItem(id,guid,name)
 local item=BaseNewItem(id,guid,name)
 Catalog[item.link]=nil
 item.link="|Hitem:"..id..":0:0:0:0:0:0:0:90|h["..name.."]|h"
 item.lines={{leftText=name},{leftText="物品等级 150"},{leftText="灵魂绑定"}}
 Catalog[item.link]=item
 return item
end
C_Item.GetItemSpecInfo=function() return {Model.spec} end
C_Item.GetItemStats=function(link)
 local item=Catalog[link]
 return item and item.loaded and (item.compareStats or {ITEM_MOD_INTELLECT_SHORT=item.level or 140.5,ITEM_MOD_HASTE_RATING_SHORT=42}) or nil
end
TooltipReads={hyperlink={},bag={},inventory={}}
local function TooltipData(item,path)
 if not item or not item.loaded or item.noTooltip then return nil end
 TooltipReads[path][item.link]=(TooltipReads[path][item.link] or 0)+1
 return {lines=item[path.."Lines"] or item.lines}
end
C_TooltipInfo.GetHyperlink=function(link) return TooltipData(Catalog[link],"hyperlink") end
C_TooltipInfo.GetBagItem=function(bag,slot) return TooltipData(Bags[bag] and Bags[bag][slot],"bag") end
C_TooltipInfo.GetInventoryItem=function(unit,slot) return TooltipData(Inventory[slot],"inventory") end
Results, Offers, Actions, StaticPopupDialogs = {}, {}, {}, {}
Cursor, Visible, Native, PendingNative = nil,nil,false,nil
function GetServerTime() return 1700000000 + math.floor(Now) end
function GetCursorInfo() if Cursor then return "item",Cursor.id,Cursor.link end end
function CanDualWield() return DualWield==true end
C_PaperDollInfo={IsRangedSlotShown=function() return false end,GetInventorySlotInfo=function(name) return name=="RangedSlot" and 18 or nil end,CursorCanGoInSlot=function() return true end}
function IsInventoryItemLocked(slot) return Inventory[slot] and Inventory[slot].locked or false end
C_Item.DoesItemExist=function(location) return Inventory[location.slot]~=nil end
C_Item.IsLocked=function(location)
 local item=location.inventory and Inventory[location.slot] or Bags[location.bag] and Bags[location.bag][location.slot]
 return item and item.locked or false
end
C_Item.IsEquippableItem=function(link) return Catalog[link].equippable~=false end
C_Item.IsUsableItem=function(link) return Catalog[link].usable~=false end
C_Item.GetDetailedItemLevelInfo=function(link) local item=Catalog[link]; return item and item.loaded and (item.level or 140.5) end
C_Item.GetItemInfoInstant=function(link) local item=Catalog[link]; if item and item.loaded then return item.id,"Armor","Plate",item.kind or "INVTYPE_CHEST",123,4,4 end end
C_Item.GetItemInfo=function(link) local item=Catalog[link]; if item and item.loaded then return item.name,link,4,item.level or 140.5,item.requiredLevel or 80,item.itemType or "Armor",item.subtype or "Plate",1,item.kind or "INVTYPE_CHEST" end end
function StaticPopup_IsAnyDialogShown() return Visible~=nil or Native end
function StaticPopup_Show(key,text,unused,data)
 local dialog={key=key,text=text,data=data}
 dialog.IsShown=function(self) return Visible==self end
 Visible=dialog
 return dialog
end
function StaticPopup_Hide(key,data)
 local dialog=Visible
 if dialog and dialog.key==key and dialog.data==data then
  Visible=nil
  StaticPopupDialogs[key].OnHide(dialog,data)
 end
end
function AcceptPopup()
 local dialog=Visible
 if not dialog then error("no visible confirmation") end
 StaticPopupDialogs[dialog.key].OnAccept(dialog,dialog.data)
 StaticPopup_Hide(dialog.key,dialog.data)
end
function CancelPopup(reason,hideFirst)
 local dialog=Visible
 if hideFirst then StaticPopup_Hide(dialog.key,dialog.data) end
 StaticPopupDialogs[dialog.key].OnCancel(dialog,dialog.data,reason)
 StaticPopup_Hide(dialog.key,dialog.data)
end
C_Container.PickupContainerItem=function(bag,slot)
 Actions[#Actions+1]={kind="pickup",bag=bag,slot=slot}
 local old=Cursor; Cursor=Bags[bag][slot]; Bags[bag][slot]=old
 PickedBag,PickedSlot=bag,slot
end
function CommitCursor(slot)
 local old=Inventory[slot]; Inventory[slot]=Cursor; Cursor=nil
 Bags[PickedBag][PickedSlot]=old
end
function PickupInventoryItem(slot)
 Actions[#Actions+1]={kind="equip",slot=slot}
 if Binding then Native=true; PendingNative=slot; return end
 if NoChange then return end
 CommitCursor(slot)
end
function ConfirmNative()
 CommitCursor(PendingNative); Native=false; PendingNative=nil
 NS.ConfirmEquip.OnEvent("PLAYER_EQUIPMENT_CHANGED")
end
function SetupOld(slot,id,name,level,kind)
 local item=NewItem(id,"old-"..slot,name); item.level=level; item.kind=kind or "INVTYPE_CHEST"; Inventory[slot]=item; return item
end
'''.encode()


class ConfirmEquipTest(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        self.lua.execute(MOCK)
        self.lua.execute(EQUIPMENT_MOCK)
        self.lua.execute(CONFIRM_MOCK)
        self.ns = self.lua.table()
        load = self.lua.eval(b"function(source,name,ns) assert(loadstring(source))(name,ns) end")
        for filename in ("Protocol.lua", "Equipment.lua", "Transfer.lua", "EquipmentCompare.lua", "ConfirmEquip.lua"):
            load((ROOT / filename).read_bytes(), ROOT.name.encode(), self.ns)
        self.g = self.lua.globals()
        self.g.NS = self.ns
        self.lua.execute(b'''Owner={session="1700000000-12500-123456",guid=Model.guid,class=Model.class,spec=Model.spec}; Settings={}
NS.ConfirmEquip.Initialize(Owner,Settings,function(result) Results[#Results+1]=result; NS.Transfer.AddSwap(result) end,print,
function(offer) Offers[#Offers+1]=offer; NS.Transfer.SetOffer(offer) end,NS.Transfer.AddComparison)
NS.Equipment.Initialize(Owner,function(record) Records[#Records+1]=record; NS.Transfer.Add(record); NS.ConfirmEquip.Add(record) end)
NS.ConfirmEquip.OnEvent("PLAYER_ENTERING_WORLD")
NS.Equipment.EnterWorld(); AdvanceTime(2)''')

    def add(self, kind="INVTYPE_CHEST", level=150, name="新装备", guid="new-guid"):
        self.g.New = self.g.NewItem(12345, guid.encode(), name.encode())
        self.g.New[b"kind"] = kind.encode()
        self.g.New[b"level"] = level
        self.g.Bags[0][2] = self.g.New
        self.ns[b"Equipment"][b"Scan"]()

    def result(self, index=1):
        return json.loads(self.ns[b"Transfer"][b"EncodeSwap"](self.g.Results[index])[1])

    def offer(self, index=None):
        record = self.g.Offers[index or len(self.g.Offers)]
        return json.loads(self.ns[b"Transfer"][b"EncodeOffer"](record)[1])

    def tick(self, seconds=0):
        self.g.AdvanceTime(seconds)
        self.ns[b"ConfirmEquip"][b"Tick"]()

    def test_real_accept_click_equips_exact_instance_and_emits_only_verified_success(self):
        self.g.SetupOld(5, 100, b"old chest", 100)
        self.add()
        self.assertEqual(len(self.g.Actions), 0)
        self.assertIn("已核对专精", self.g.Visible[b"text"].decode())
        self.g.AcceptPopup()
        self.assertEqual(self.g.Inventory[5][b"guid"], b"new-guid")
        self.assertEqual([self.g.Actions[i][b"kind"] for i in (1, 2)], [b"pickup", b"equip"])
        self.assertEqual(self.result()["st"], "equipped")
        self.assertEqual(self.result()["old"], 100)
        self.assertEqual(self.result()["r"], "confirmed")

    def test_moved_bag_item_relocates_by_guid_and_does_not_pick_same_name_copy(self):
        self.add()
        self.lua.execute(b'Bags[0][7]=New; Bags[0][2]=NewItem(12345,"other-copy",New.name)')
        self.g.AcceptPopup()
        self.assertEqual(self.g.Actions[1][b"slot"], 7)
        self.assertEqual(self.g.Inventory[5][b"guid"], b"new-guid")
        self.assertEqual(self.g.Bags[0][2][b"guid"], b"other-copy")

    def test_same_guid_with_changed_instance_link_fails(self):
        self.add()
        self.lua.execute(b'Bags[0][2].link=Bags[0][2].link..":modified"')
        self.g.AcceptPopup()
        self.assertEqual(len(self.g.Actions), 0)
        self.assertEqual(self.result()["r"], "changed")

    def test_missing_candidate_and_changed_target_fail_before_action(self):
        for change, reason in ((b'Bags[0][2]=nil', "unavailable"), (b'SetupOld(5,999,"replacement",140)', "changed")):
            with self.subTest(reason=reason):
                self.setUp(); self.add(); self.lua.execute(change); self.g.AcceptPopup()
                self.assertEqual(len(self.g.Actions), 0)
                self.assertEqual(self.result()["r"], reason)

    def test_cursor_locked_dead_and_restricted_states_fail_before_action(self):
        cases = [(b'Cursor=NewItem(9,"cursor","cursor")', "cursor"), (b'New.locked=true', "locked"),
                 (b'Model.dead=true', "dead"), (b'Model.combat=Secret', "restricted"),
                 (b'C_Container.GetContainerItemInfo=function() return Secret end', "restricted"),
                 (b'C_Item.IsLocked=function() return Secret end', "restricted")]
        for change, reason in cases:
            with self.subTest(reason=reason, change=change):
                self.setUp(); self.add(); self.lua.execute(change); self.g.AcceptPopup()
                self.assertEqual(len(self.g.Actions), 0)
                self.assertEqual(self.result()["r"], reason)

    def test_locked_equipped_target_fails(self):
        self.g.SetupOld(5, 100, b"old", 100)
        self.add(); self.g.Inventory[5][b"locked"] = True
        self.g.AcceptPopup()
        self.assertEqual(self.result()["r"], "locked")
        self.assertEqual(len(self.g.Actions), 0)

    def test_character_or_session_change_rejects_stale_confirmation(self):
        for change in (b'Model.guid="Player-other"', b'Owner.session="different"'):
            self.setUp(); self.add(); self.lua.execute(change); self.g.AcceptPopup()
            self.assertEqual(self.result()["r"], "changed")
            self.assertEqual(len(self.g.Actions), 0)

    def test_cancel_escape_and_timeout_never_act_or_ask_again(self):
        for reason, expected in ((b"clicked", "declined"), (b"timeout", "expired"), (b"override", "failed")):
            with self.subTest(reason=reason):
                self.setUp(); self.add(); self.g.CancelPopup(reason, True); self.tick(1)
                self.ns[b"ConfirmEquip"][b"Add"](self.g.Records[1])
                self.assertIsNone(self.g.Visible)
                self.assertEqual(len(self.g.Actions), 0)
                self.assertEqual(self.result()["st"], expected)
                self.assertEqual(len(self.g.Results), 1)

    def test_combat_hides_then_reasks_without_reusing_acceptance(self):
        self.add()
        self.g.Model[b"combat"] = True
        self.ns[b"ConfirmEquip"][b"OnEvent"](b"PLAYER_REGEN_DISABLED")
        self.assertIsNone(self.g.Visible)
        self.tick(2)
        self.g.Model[b"combat"] = False
        self.ns[b"ConfirmEquip"][b"OnEvent"](b"PLAYER_REGEN_ENABLED")
        self.assertIsNotNone(self.g.Visible)
        self.assertEqual(len(self.g.Actions), 0)
        self.g.AcceptPopup()
        self.assertEqual(self.result()["st"], "equipped")

    def test_combat_race_at_accept_is_failure_without_action(self):
        self.add(); self.g.Model[b"combat"] = True; self.g.AcceptPopup()
        self.assertEqual(len(self.g.Actions), 0)
        self.assertEqual(self.result()["r"], "combat")
        self.g.Model[b"combat"] = False; self.tick(1)
        self.assertIsNone(self.g.Visible)

    def test_native_confirmation_waits_without_success_or_next_prompt(self):
        self.add(); self.g.Binding = True; self.g.AcceptPopup(); self.tick(20)
        self.assertEqual(len(self.g.Results), 0)
        self.assertIsNone(self.g.Visible)
        self.assertTrue(self.g.Native)
        self.g.ConfirmNative()
        self.assertEqual(self.result()["st"], "equipped")

    def test_native_timeout_reports_unconfirmed_and_never_repeats_action(self):
        self.add(); self.g.Binding = True; self.g.AcceptPopup(); self.tick(46)
        self.assertEqual(self.result()["st"], "failed")
        self.assertEqual(self.result()["r"], "timeout")
        self.assertTrue(self.g.Native)
        self.tick(10)
        self.assertEqual(len(self.g.Actions), 2)
        self.assertEqual(len(self.g.Results), 1)

    def test_double_click_and_onhide_after_accept_do_not_repeat_or_decline(self):
        self.add()
        dialog = self.g.Visible
        accept = self.g.StaticPopupDialogs[dialog[b"key"]][b"OnAccept"]
        accept(dialog, dialog[b"data"])
        accept(dialog, dialog[b"data"])
        self.g.StaticPopupDialogs[dialog[b"key"]][b"OnHide"](dialog, dialog[b"data"])
        self.assertEqual(len(self.g.Actions), 2)
        self.assertEqual(len(self.g.Results), 1)
        self.assertEqual(self.result()["st"], "equipped")

    def test_nonclick_tick_never_performs_actions(self):
        self.add()
        for _ in range(20): self.tick(1)
        self.assertEqual(len(self.g.Actions), 0)

    def test_synchronous_finish_defers_next_prompt_until_old_click_handler_has_returned(self):
        self.add()
        self.lua.execute(b'''Bags[0][3]=NewItem(12346,"next-guid","next"); Bags[0][3].kind="INVTYPE_HEAD"; NS.Equipment.Scan()
OriginalEquip=PickupInventoryItem
PickupInventoryItem=function(slot)
 OriginalEquip(slot)
 NS.ConfirmEquip.OnEvent("PLAYER_EQUIPMENT_CHANGED")
 assert(Visible==nil,"next dialog must not appear inside old click")
end''')
        self.g.AcceptPopup()
        self.assertIsNone(self.g.Visible)
        self.tick(1)
        self.assertIsNotNone(self.g.Visible)
        self.assertEqual(self.g.Visible[b"data"][b"record"][b"itemID"], 12346)

    def test_disabled_and_world_exit_cancel_and_ignore_late_click(self):
        for mode in ("off", "leave"):
            self.setUp(); self.add(); dialog = self.g.Visible
            if mode == "off": self.ns[b"ConfirmEquip"][b"Command"](b"off")
            else: self.ns[b"ConfirmEquip"][b"OnEvent"](b"PLAYER_LEAVING_WORLD")
            self.g.StaticPopupDialogs[dialog[b"key"]][b"OnAccept"](dialog, dialog[b"data"])
            self.assertEqual(self.result()["r"], "disabled" if mode == "off" else "left_world")
            self.assertEqual(len(self.g.Actions), 0)

    def test_equal_level_unequippable_missing_guid_and_partial_records_are_not_prompted(self):
        for mode in ("equal", "unequippable", "guidless", "partial"):
            self.setUp()
            if mode == "equal": self.g.SetupOld(5, 100, b"old", 150)
            self.g.New = self.g.NewItem(12345, b"new", b"new")
            self.g.New[b"level"] = 150
            if mode == "unequippable": self.g.New[b"equippable"] = False
            if mode == "guidless": self.g.New[b"guid"] = None
            if mode == "partial": self.g.New[b"noTooltip"] = True
            self.g.Bags[0][2] = self.g.New
            self.ns[b"Equipment"][b"Scan"](); self.tick(10)
            self.assertIsNone(self.g.Visible)
            self.assertEqual(len(self.g.Actions), 0)

    def test_rings_choose_lower_slot_and_guard_other_ring_identity(self):
        self.g.SetupOld(11, 100, b"ring1", 120, b"INVTYPE_FINGER")
        self.g.SetupOld(12, 101, b"ring2", 100, b"INVTYPE_FINGER")
        self.add("INVTYPE_FINGER")
        self.g.AcceptPopup()
        self.assertEqual(self.result()["slot"], 12)
        self.setUp()
        self.g.SetupOld(11, 100, b"ring1", 120, b"INVTYPE_FINGER")
        self.g.SetupOld(12, 101, b"ring2", 100, b"INVTYPE_FINGER")
        self.add("INVTYPE_FINGER")
        self.g.SetupOld(11, 999, b"changed", 130, b"INVTYPE_FINGER")
        self.g.AcceptPopup()
        self.assertEqual(self.result()["r"], "changed")

    def test_single_dual_and_two_hand_weapon_choices(self):
        self.add("INVTYPE_WEAPON"); self.g.AcceptPopup()
        self.assertEqual(self.result()["slot"], 16)
        self.setUp(); self.g.DualWield = True
        self.g.SetupOld(16, 100, b"main", 140, b"INVTYPE_WEAPON")
        self.g.SetupOld(17, 101, b"off", 100, b"INVTYPE_WEAPON")
        self.add("INVTYPE_WEAPON"); self.g.AcceptPopup()
        self.assertEqual(self.result()["slot"], 17)
        self.setUp()
        self.g.SetupOld(16, 100, b"two hand", 100, b"INVTYPE_2HWEAPON")
        self.add("INVTYPE_2HWEAPON"); self.g.AcceptPopup()
        self.assertEqual(self.result()["slot"], 16)

    def test_multi_slot_weapon_layout_and_unsupported_offhand_are_skipped(self):
        for kind, main, off, dual in (("INVTYPE_2HWEAPON", "INVTYPE_WEAPON", "INVTYPE_SHIELD", False),
                ("INVTYPE_WEAPON", "INVTYPE_2HWEAPON", None, True),
                ("INVTYPE_WEAPONOFFHAND", "INVTYPE_WEAPON", None, False)):
            self.setUp(); self.g.DualWield = dual
            self.g.SetupOld(16, 100, b"main", 100, main.encode())
            if off: self.g.SetupOld(17, 101, b"off", 100, off.encode())
            self.add(kind)
            self.assertIsNone(self.g.Visible)

    def test_ranged_slot_is_queried_for_client_layout_and_unknown_is_skipped(self):
        self.lua.execute(b'C_PaperDollInfo.IsRangedSlotShown=function() return true end')
        self.g.SetupOld(18, 100, b"ranged", 100, b"INVTYPE_RANGED")
        self.g.SetupOld(16, 101, b"main", 150, b"INVTYPE_WEAPON")
        self.add("INVTYPE_RANGED"); self.g.AcceptPopup()
        self.assertEqual(self.result()["slot"], 18)
        self.setUp(); self.add("INVTYPE_RANGED"); self.g.AcceptPopup()
        self.assertEqual(self.result()["slot"], 16)
        self.setUp(); self.lua.execute(b'C_PaperDollInfo=nil'); self.add("INVTYPE_RANGED")
        self.assertIsNone(self.g.Visible)

    def test_missing_equip_api_never_picks_up_item(self):
        for removal in (b'PickupInventoryItem=nil', b'C_PaperDollInfo.CursorCanGoInSlot=nil', b'IsInventoryItemLocked=nil'):
            self.setUp(); self.add(); self.lua.execute(removal); self.g.AcceptPopup()
            self.assertEqual(self.result()["r"], "unavailable")
            self.assertEqual(len(self.g.Actions), 0)

    def test_pickup_reentry_cancellation_prevents_second_action(self):
        for mutation in (b'NS.ConfirmEquip.OnEvent("PLAYER_LEAVING_WORLD")',
                         b'Model.combat=true; NS.ConfirmEquip.OnEvent("PLAYER_REGEN_DISABLED")',
                         b'Model.dead=true; NS.ConfirmEquip.OnEvent("PLAYER_DEAD")',
                         b'NS.ConfirmEquip.Command("off")', b'Model.combat=true',
                         b'Model.dead=true', b'Model.guid="Player-new"',
                         b'SetupOld(5,777,"changed",140)'):
            with self.subTest(mutation=mutation):
                self.setUp(); self.add()
                self.lua.execute(b'OriginalPickup=C_Container.PickupContainerItem; C_Container.PickupContainerItem=function(bag,slot) OriginalPickup(bag,slot); '+mutation+b' end')
                self.g.AcceptPopup()
                self.assertEqual(len(self.g.Actions), 1)
                self.assertEqual(len(self.g.Results), 1)
                self.assertEqual(self.result()["st"], "failed")
                self.assertIsNotNone(self.g.Cursor)

    def test_old_cursor_item_is_returned_only_to_empty_source_in_same_click(self):
        self.g.SetupOld(5, 100, b"old chest", 100)
        self.add()
        self.lua.execute(b'''PickupInventoryItem=function(slot)
 local old=Inventory[slot]; Inventory[slot]=Cursor; Cursor=old
end
ClearCursor=function() error("must not clear cursor") end''')
        self.g.AcceptPopup()
        self.assertEqual(self.result()["st"], "equipped")
        self.assertIsNone(self.g.Cursor)
        self.assertEqual(self.g.Bags[0][2][b"id"], 100)

    def test_wrong_cursor_or_occupied_source_is_never_modified(self):
        for mutation in (b'Cursor=NewItem(999,"other","other")',
                         b'Bags[0][2]=NewItem(777,"other","other")'):
            self.setUp(); self.g.SetupOld(5, 100, b"old chest", 100); self.add()
            self.lua.execute(b'''PickupInventoryItem=function(slot)
 local old=Inventory[slot]; Inventory[slot]=Cursor; Cursor=old; '''+mutation+b''' end
ClearCursor=function() error("must not clear cursor") end''')
            self.g.AcceptPopup()
            self.assertEqual(self.result()["st"], "equipped")
            self.assertIsNotNone(self.g.Cursor)
            self.assertEqual(len(self.g.Actions), 1)

    def test_native_later_success_does_not_move_old_cursor_item(self):
        self.g.SetupOld(5, 100, b"old chest", 100); self.add(); self.g.Binding = True
        self.g.AcceptPopup()
        self.lua.execute(b'''local old=Inventory[5]; Inventory[5]=Cursor; Cursor=old
Native=false; NS.ConfirmEquip.OnEvent("PLAYER_EQUIPMENT_CHANGED")''')
        self.assertEqual(self.result()["st"], "equipped")
        self.assertEqual(self.g.Cursor[b"id"], 100)
        self.assertEqual(len(self.g.Actions), 2)
        self.tick(2)
        self.assertEqual(self.g.Cursor[b"id"], 100)

    def test_cursor_slot_incompatible_and_equipped_lock_race_stop_after_pickup(self):
        for code, reason in ((b'C_PaperDollInfo.CursorCanGoInSlot=function() return false end', "unavailable"),
                             (b'IsInventoryItemLocked=function() return true end', "locked")):
            self.setUp(); self.add(); self.lua.execute(code); self.g.AcceptPopup()
            self.assertEqual(self.result()["r"], reason)
            self.assertEqual(len(self.g.Actions), 1)
            self.assertIsNotNone(self.g.Cursor)

    def test_awaiting_action_enters_combat_and_cannot_execute_again_after_combat(self):
        self.add(); self.g.Binding = True; self.g.AcceptPopup()
        self.g.Model[b"combat"] = True
        self.ns[b"ConfirmEquip"][b"OnEvent"](b"PLAYER_REGEN_DISABLED")
        self.assertEqual(self.result()["r"], "combat")
        self.g.Model[b"combat"] = False
        self.ns[b"ConfirmEquip"][b"OnEvent"](b"PLAYER_REGEN_ENABLED")
        self.assertEqual(len(self.g.Actions), 2)
        self.assertEqual(len(self.g.Results), 1)

    def test_hidden_popup_without_cancel_cannot_later_execute(self):
        self.add(); dialog = self.g.Visible
        self.g.StaticPopup_Hide(dialog[b"key"], dialog[b"data"])
        self.tick(1)
        self.g.StaticPopupDialogs[dialog[b"key"]][b"OnAccept"](dialog, dialog[b"data"])
        self.assertEqual(len(self.g.Actions), 0)
        self.assertEqual(self.result()["r"], "unavailable")

    def test_queue_is_bounded_and_combat_queue_expires(self):
        self.g.Model[b"combat"] = True
        self.lua.execute(b'for i=1,10 do local item=NewItem(100+i,"new-"..i,"new"); Bags[0][i]=item end')
        self.ns[b"Equipment"][b"Scan"]()
        self.assertIn(b"6/6", self.ns[b"ConfirmEquip"][b"Status"]())
        for _ in range(7): self.tick(121 if _ == 0 else 1)
        self.assertEqual(len(self.g.Results), 6)
        self.assertEqual(len(self.g.Actions), 0)
        self.assertTrue(all(self.result(i)["st"] == "expired" for i in range(1, 7)))

    def test_swap_frame_round_trip_crc_and_limits(self):
        self.add(); self.g.AcceptPopup()
        frame, body = self.ns[b"Transfer"][b"EncodeSwap"](self.g.Results[1])
        length, crc = struct.unpack("<HH", frame[4:8])
        self.assertEqual(len(frame), 512)
        self.assertEqual(body, frame[8:8 + length])
        self.assertEqual(crc, binascii.crc_hqx(body, 0xffff))
        self.assertEqual(set(json.loads(body)), {"v", "kind", "s", "g", "id", "e", "st", "r", "at", "slot", "item", "old"})
        self.g.Results[1][b"r"] = b"user"
        self.assertIsNone(self.ns[b"Transfer"][b"EncodeSwap"](self.g.Results[1]))

    def test_swap_replay_dedup_ttl_and_equipment_bandwidth(self):
        self.add(); self.g.AcceptPopup()
        self.ns[b"Transfer"][b"SetOffer"](None)
        self.ns[b"Transfer"][b"AddSwap"](self.g.Results[1])
        self.assertIn(b"1/10", self.ns[b"Transfer"][b"Status"]())
        kinds, parts = [], []
        for tick in range(16):
            self.ns[b"Transfer"][b"Advance"]()
            frame = self.ns[b"Transfer"][b"Current"](b"state")
            if tick % 2:
                self.assertEqual(frame, b"state")
            else:
                length = struct.unpack("<H", frame[4:6])[0]
                data = json.loads(frame[8:8 + length]); kinds.append(data["kind"])
                if data["kind"] == "eq": parts.append(data["p"])
        self.assertEqual(kinds, ["cmp", "cmp", "cmp", "swap", "eq", "eq", "eq", "swap"])
        self.assertEqual(parts[:3], [1, 2, 3])
        self.tick(601); self.ns[b"Transfer"][b"Advance"]()
        self.assertEqual(self.ns[b"Transfer"][b"Current"](b"state"), b"state")

    def test_maximum_35_fragment_item_finishes_before_receiver_timeout_with_results(self):
        self.add(); self.g.AcceptPopup()
        record = self.g.Records[1]
        record[b"tooltip"] = self.lua.table()
        while True:
            index = len(record[b"tooltip"]) + 1
            before = len(self.ns[b"Transfer"][b"JSON"](record))
            record[b"tooltip"][index] = b"x" * 256
            after = len(self.ns[b"Transfer"][b"JSON"](record))
            if after > 8190:
                record[b"tooltip"][index] = b"x" * (256 - (after - 8190))
                break
        self.assertEqual(len(self.ns[b"Transfer"][b"Encode"](record)[0]), 35)
        load = self.lua.eval(b"function(source,name,ns) assert(loadstring(source))(name,ns) end")
        load((ROOT / "Transfer.lua").read_bytes(), ROOT.name.encode(), self.ns)
        self.ns[b"Transfer"][b"Add"](record)
        self.ns[b"Transfer"][b"AddSwap"](self.g.Results[1])
        parts, results = [], 0
        for second in range(1, 181):
            self.ns[b"Transfer"][b"Advance"]()
            frame = self.ns[b"Transfer"][b"Current"](b"state")
            if second % 2 == 0: self.assertEqual(frame, b"state")
            if frame == b"state": continue
            length = struct.unpack("<H", frame[4:6])[0]
            data = json.loads(frame[8:8 + length])
            if data["kind"] == "swap": results += 1
            else:
                parts.append(data["p"])
                if data["p"] == 35: break
        self.assertEqual(parts, list(range(1, 36)))
        self.assertLess(second, 180)
        self.assertLessEqual(second, 94)
        self.assertGreater(results, 0)

    def test_new_result_is_first_broadcast_before_old_result_replays(self):
        self.add(); self.g.AcceptPopup()
        self.ns[b"Transfer"][b"SetOffer"](None)
        self.lua.execute(b'''for i=2,10 do local result={}; for key,value in pairs(Results[1]) do result[key]=value end; result.id=i; NS.Transfer.AddSwap(result) end''')
        for _ in range(80): self.ns[b"Transfer"][b"Advance"]()
        self.lua.execute(b'''local result={}; for key,value in pairs(Results[1]) do result[key]=value end; result.id=11; NS.Transfer.AddSwap(result)''')
        result_id = None
        for _ in range(8):
            self.ns[b"Transfer"][b"Advance"]()
            frame = self.ns[b"Transfer"][b"Current"](b"state")
            if frame != b"state":
                length = struct.unpack("<H", frame[4:6])[0]
                data = json.loads(frame[8:8 + length])
                if data["kind"] == "swap": result_id = data["id"]; break
        self.assertEqual(result_id, 11)
        self.assertIn(b"10/10", self.ns[b"Transfer"][b"Status"]())

    def test_main_wires_acquisition_accept_and_pixel_result(self):
        self.setUp()
        load = self.lua.eval(b"function(source,name,ns) assert(loadstring(source))(name,ns) end")
        for filename in ("Money.lua", "Inventory.lua", "Quests.lua", "Talents.lua", "Telemetry.lua", ROOT.name + ".lua"):
            load((ROOT / filename).read_bytes(), ROOT.name.encode(), self.ns)
        self.g.Fire(b"ADDON_LOADED", ROOT.name.encode()); self.g.Fire(b"PLAYER_ENTERING_WORLD")
        self.g.AdvanceTime(2)
        self.add(); self.g.AcceptPopup()
        frame_name = b"WoWForeverCompanionTelemetry" if ROOT.name == "WoWForeverCompanion" else b"WoWCompanionTelemetry"
        textures = self.g.Objects[frame_name][b"textures"]
        kinds = []
        for _ in range(14):
            self.g.Heartbeat()
            frame = bytes(sum(int(textures[byte * 8 + bit + 1][b"color"][1]) << (7 - bit) for bit in range(8)) for byte in range(512))
            length = struct.unpack("<H", frame[4:6])[0]
            data = json.loads(frame[8:8 + length])
            kinds.append(data.get("kind", "state"))
            if data.get("kind") == "swap": self.assertEqual(data["st"], "equipped")
        self.assertIn("swap", kinds)

    def test_offer_is_published_only_for_visible_current_popup_with_actual_deadline(self):
        self.g.Native = True
        self.add()
        self.assertEqual(len(self.g.Offers), 0)
        self.tick(20)
        self.g.Native = False
        self.tick()
        offered = self.offer()
        self.assertEqual((offered["st"], offered["id"], offered["q"]), ("ready", 1, 1))
        self.assertEqual((offered["slot"], offered["old"], offered["ol"]), (5, 0, -1))
        self.assertEqual(offered["until"], 1700000122)
        self.assertEqual(self.g.StaticPopupDialogs[self.g.Visible[b"key"]][b"timeout"], 100)
        self.assertIn("100 秒", self.g.Visible[b"text"].decode())
        self.assertEqual(len(self.g.Actions), 0)

    def test_offer_waits_up_to_original_120_seconds_without_automatic_acceptance(self):
        self.add()
        self.assertEqual(self.g.StaticPopupDialogs[self.g.Visible[b"key"]][b"timeout"], 120)
        self.tick(119)
        self.assertIsNotNone(self.g.Visible)
        self.assertEqual(self.offer()["st"], "ready")
        self.tick(1)
        self.assertIsNone(self.g.Visible)
        self.assertEqual(self.offer()["st"], "closed")
        self.assertEqual(self.result()["st"], "expired")
        self.assertEqual(len(self.g.Actions), 0)

    def test_offer_closes_immediately_on_accept_and_waits_for_native_confirmation(self):
        self.add(); self.g.Binding = True
        offered = self.offer()
        self.g.AcceptPopup()
        self.assertEqual(self.offer()["st"], "closed")
        self.assertEqual(self.offer()["q"], offered["q"] + 1)
        self.assertEqual(self.offer()["until"], offered["until"])
        self.assertEqual(len(self.g.Results), 0)
        self.assertTrue(self.g.Native)

    def test_offer_closes_on_hide_cancel_disable_and_world_exit_without_waiting_for_tick(self):
        changes = (b'local d=Visible; StaticPopup_Hide(d.key,d.data)', b'CancelPopup("clicked",true)',
                   b'NS.ConfirmEquip.Command("off")', b'NS.ConfirmEquip.OnEvent("PLAYER_LEAVING_WORLD")')
        for change in changes:
            with self.subTest(change=change):
                self.setUp(); self.add(); self.lua.execute(change)
                self.assertEqual(self.offer()["st"], "closed")
                self.assertEqual(self.offer()["q"], 2)
                self.assertEqual(len(self.g.Actions), 0)

    def test_combat_or_death_closes_offer_and_reopening_has_new_revision_same_deadline(self):
        for field, event, recovery in ((b"combat", b"PLAYER_REGEN_DISABLED", b"PLAYER_REGEN_ENABLED"),
                                       (b"dead", b"PLAYER_DEAD", b"PLAYER_ALIVE")):
            with self.subTest(field=field):
                self.setUp(); self.add(); original = self.offer()
                self.g.Model[field] = True
                self.ns[b"ConfirmEquip"][b"OnEvent"](event)
                self.assertEqual(self.offer()["st"], "closed")
                self.assertEqual(self.offer()["q"], 2)
                self.tick(12)
                self.g.Model[field] = False
                self.ns[b"ConfirmEquip"][b"OnEvent"](recovery)
                reopened = self.offer()
                self.assertEqual((reopened["st"], reopened["q"]), ("ready", 3))
                self.assertEqual(reopened["until"], original["until"])
                self.assertEqual(self.g.StaticPopupDialogs[self.g.Visible[b"key"]][b"timeout"], 108)
                self.assertEqual(len(self.g.Actions), 0)

    def test_offer_closes_when_candidate_target_or_combat_changes_without_callback(self):
        for change in (b'Bags[0][2]=nil', b'SetupOld(5,999,"changed",140)', b'Model.combat=true', b'Model.dead=true'):
            with self.subTest(change=change):
                self.setUp(); self.add(); self.lua.execute(change); self.tick()
                self.assertEqual(self.offer()["st"], "closed")
                self.assertIsNone(self.g.Visible)
                self.assertEqual(len(self.g.Actions), 0)

    def test_failed_or_nonvisible_popup_never_publishes_offer(self):
        for show in (b'StaticPopup_Show=function() return nil end',
                     b'StaticPopup_Show=function() return {IsShown=function() return false end} end',
                     b'StaticPopup_Show=function() Model.combat=true; return {IsShown=function() return true end} end'):
            with self.subTest(show=show):
                self.setUp(); self.lua.execute(show); self.add()
                self.assertEqual(len(self.g.Offers), 0)
                self.assertEqual(len(self.g.Actions), 0)

    def test_queued_candidates_never_replace_current_offer_until_their_popup_opens(self):
        self.add(); original = self.offer()
        self.lua.execute(b'Bags[0][3]=NewItem(12346,"next-guid","next"); Bags[0][3].kind="INVTYPE_HEAD"; NS.Equipment.Scan()')
        self.assertEqual(len(self.g.Offers), 1)
        self.assertEqual(self.offer(), original)
        self.g.CancelPopup(b"clicked", True)
        self.assertEqual(self.offer()["id"], 1)
        self.assertEqual(self.offer()["st"], "closed")
        self.tick(1)
        self.assertEqual((self.offer()["id"], self.offer()["st"], self.offer()["q"]), (2, "ready", 3))
        self.ns[b"ConfirmEquip"][b"Command"](b"off")
        self.assertEqual(self.offer()["id"], 2)
        self.assertEqual(self.offer()["st"], "closed")

    def test_offer_name_is_plain_utf8_and_bounded_without_cutting_chinese_characters(self):
        self.add(name="|cffaabbcc" + "装备名" * 14 + "|r")
        offered = self.offer()
        self.assertEqual(offered["n"], ("装备名" * 14)[:32])
        self.assertEqual(len(offered["n"].encode()), 96)
        self.setUp(); self.add(name="|Hitem:12345|h装备|h\n|Timage|t|Aicon|a")
        self.assertEqual(self.offer()["n"], "装备")

    def test_unavailable_server_time_skips_desktop_offer_but_keeps_game_confirmation(self):
        for clock in (b'GetServerTime=nil', b'GetServerTime=function() return Secret end', b'GetServerTime=function() return 0 end'):
            with self.subTest(clock=clock):
                self.setUp(); self.lua.execute(clock); self.add()
                self.assertIsNotNone(self.g.Visible)
                self.assertEqual(len(self.g.Offers), 0)
                self.g.AcceptPopup()
                self.assertEqual(self.result()["st"], "equipped")

    def test_offer_encoding_crc_limits_and_strict_fields(self):
        self.add()
        frame, body = self.ns[b"Transfer"][b"EncodeOffer"](self.g.Offers[1])
        length, crc = struct.unpack("<HH", frame[4:8])
        self.assertEqual(len(frame), 512)
        self.assertEqual(body, frame[8:8 + length])
        self.assertEqual(crc, binascii.crc_hqx(body, 0xffff))
        self.assertEqual(set(json.loads(body)), {"v", "kind", "s", "g", "id", "q", "st", "slot", "item", "n", "il", "old", "ol", "until"})
        self.lua.execute(b'''Extreme={v=1,kind="offer",s=string.rep("s",40),g=string.rep("g",48),id=2147483647,q=2147483647,st="closed",slot=19,item=2147483647,n=string.rep('"',96),il=99999.9999999,old=2147483647,ol=99999.9999998,["until"]=4102444800}''')
        extreme_frame, extreme_json = self.ns[b"Transfer"][b"EncodeOffer"](self.g.Extreme)
        self.assertLessEqual(len(extreme_json), 504)
        self.assertEqual(len(extreme_frame), 512)
        for field, value in ((b"extra", True), (b"q", 0), (b"q", 2147483648), (b"st", b"equipped"),
                             (b"n", b"bad\nname"), (b"n", b"|Hitem:1|hname|h"), (b"n", b"x" * 97),
                             (b"n", b"\xff"), (b"n", b"\xed\xa0\x80"), (b"n", b"\xf4\x90\x80\x80"),
                             (b"until", 0), (b"il", -1), (b"ol", 0), (b"old", 1)):
            with self.subTest(field=field, value=value):
                candidate = self.lua.table_from({key: val for key, val in self.g.Offers[1].items()})
                candidate[field] = value
                self.assertIsNone(self.ns[b"Transfer"][b"EncodeOffer"](candidate))

    def test_closing_offer_replaces_a_held_ready_frame_immediately_and_never_replays_it(self):
        self.add(); self.ns[b"Transfer"][b"Advance"]()
        ready = self.ns[b"Transfer"][b"Current"](b"state")
        self.assertEqual(json.loads(ready[8:8 + struct.unpack("<H", ready[4:6])[0]])["st"], "ready")
        self.g.CancelPopup(b"clicked", True)
        closed = self.ns[b"Transfer"][b"Current"](b"state")
        self.assertEqual(json.loads(closed[8:8 + struct.unpack("<H", closed[4:6])[0]])["st"], "closed")
        for _ in range(30):
            self.ns[b"Transfer"][b"Advance"]()
            frame = self.ns[b"Transfer"][b"Current"](b"state")
            if frame == b"state": continue
            payload = json.loads(frame[8:8 + struct.unpack("<H", frame[4:6])[0]])
            if payload["kind"] == "offer": self.assertEqual(payload["st"], "closed")

    def test_new_offer_preserves_the_normal_state_slot(self):
        self.add()
        self.assertEqual(self.ns[b"Transfer"][b"Current"](b"state"), b"state")
        self.ns[b"Transfer"][b"Advance"](); self.ns[b"Transfer"][b"Advance"]()
        self.assertEqual(self.ns[b"Transfer"][b"Current"](b"state"), b"state")
        self.g.CancelPopup(b"clicked", True)
        self.assertEqual(self.ns[b"Transfer"][b"Current"](b"state"), b"state")

    def test_offer_and_swap_traffic_keep_35_parts_under_receiver_ttl_and_regular_status(self):
        self.add(); self.g.AcceptPopup()
        record = self.g.Records[1]
        record[b"tooltip"] = self.lua.table()
        while True:
            index = len(record[b"tooltip"]) + 1
            record[b"tooltip"][index] = b"x" * 256
            size = len(self.ns[b"Transfer"][b"JSON"](record))
            if size > 8190:
                record[b"tooltip"][index] = b"x" * (256 - (size - 8190))
                break
        load = self.lua.eval(b"function(source,name,ns) assert(loadstring(source))(name,ns) end")
        load((ROOT / "Transfer.lua").read_bytes(), ROOT.name.encode(), self.ns)
        self.ns[b"Transfer"][b"Add"](record)
        self.ns[b"Transfer"][b"AddSwap"](self.g.Results[1])
        self.ns[b"Transfer"][b"SetOffer"](self.g.Offers[len(self.g.Offers)])
        parts, kinds = [], []
        for second in range(1, 181):
            self.g.AdvanceTime(1)
            self.ns[b"Transfer"][b"Advance"]()
            frame = self.ns[b"Transfer"][b"Current"](b"state")
            if second % 2 == 0: self.assertEqual(frame, b"state")
            if frame == b"state": continue
            data = json.loads(frame[8:8 + struct.unpack("<H", frame[4:6])[0]])
            kinds.append(data["kind"])
            if data["kind"] == "eq":
                parts.append(data["p"])
                if data["p"] == 35: break
        self.assertEqual(parts, list(range(1, 36)))
        self.assertLessEqual(second, 140)
        self.assertIn("swap", kinds)
        self.assertIn("offer", kinds)
        self.assertEqual(kinds[:12], ["offer", "eq", "eq", "offer", "eq", "swap", "offer", "eq", "eq", "offer", "eq", "swap"])

    def test_main_replaces_ready_pixels_when_game_popup_is_closed(self):
        load = self.lua.eval(b"function(source,name,ns) assert(loadstring(source))(name,ns) end")
        for filename in ("Money.lua", "Inventory.lua", "Quests.lua", "Talents.lua", "Telemetry.lua", ROOT.name + ".lua"):
            load((ROOT / filename).read_bytes(), ROOT.name.encode(), self.ns)
        self.g.Fire(b"ADDON_LOADED", ROOT.name.encode()); self.g.Fire(b"PLAYER_ENTERING_WORLD")
        self.g.AdvanceTime(2)
        self.add(); self.g.Heartbeat()
        frame_name = b"WoWForeverCompanionTelemetry" if ROOT.name == "WoWForeverCompanion" else b"WoWCompanionTelemetry"
        textures = self.g.Objects[frame_name][b"textures"]
        def pixels():
            frame = bytes(sum(int(textures[byte * 8 + bit + 1][b"color"][1]) << (7 - bit) for bit in range(8)) for byte in range(512))
            return json.loads(frame[8:8 + struct.unpack("<H", frame[4:6])[0]])
        self.assertEqual(pixels()["st"], "ready")
        self.g.CancelPopup(b"clicked", True)
        self.assertEqual(pixels()["st"], "closed")
        self.assertEqual(pixels()["q"], 2)


if __name__ == "__main__":
    unittest.main()
