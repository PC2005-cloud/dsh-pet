"""Exercise real Lua acquisition, bounded loading, instance links and fragments."""
from __future__ import annotations

import base64
import binascii
import json
import struct
import unittest

from test_addon import LuaRuntime, MOCK, ROOT

EQUIPMENT_MOCK = r'''
Now, Bags, Inventory, Catalog, Records, LoadRequests = 0, {[0]={}}, {}, {}, {}, 0
NUM_TOTAL_EQUIPPED_BAG_SLOTS=5
function GetTime() return Now end
function GetInventoryItemLink(unit,slot) return Inventory[slot] and Inventory[slot].link end
ItemLocation={
  CreateFromBagAndSlot=function(self,bag,slot) return {bag=bag,slot=slot} end,
  CreateFromEquipmentSlot=function(self,slot) return {inventory=true,slot=slot} end
}
C_Container={
  GetContainerNumSlots=function(bag) return bag==0 and 20 or 0 end,
  GetContainerItemInfo=function(bag,slot) local item=Bags[bag] and Bags[bag][slot]; if item then return {itemID=item.id,hyperlink=item.link,stackCount=item.quantity or 1} end end,
  GetContainerItemLink=function(bag,slot) return Bags[bag] and Bags[bag][slot] and Bags[bag][slot].link end
}
C_Item={
  GetItemGUID=function(location) local item=location.inventory and Inventory[location.slot] or Bags[location.bag] and Bags[location.bag][location.slot]; return item and item.guid end,
  GetItemInfoInstant=function(link) local item=Catalog[link]; if item and not item.instantMissing then return item.id,"Armor","Plate","INVTYPE_CHEST",123,item.class or 4,4 end end,
  GetItemInfo=function(link) local item=Catalog[link]; if item and item.loaded then return item.name,link,4,100,80,"Armor","Plate",1,"INVTYPE_CHEST",123,100,4,4,1,12,1234,false,"" end end,
  GetDetailedItemLevelInfo=function(link) local item=Catalog[link]; if item and item.loaded then return 140.5 end end,
  GetItemStats=function(link) local item=Catalog[link]; return item and item.loaded and item.stats or nil end,
  RequestLoadItemDataByID=function(link) LoadRequests=LoadRequests+1 end
}
C_TooltipInfo={
  GetHyperlink=function(link) local item=Catalog[link]; return item and item.loaded and not item.noTooltip and {lines=item.lines} or nil end,
  GetBagItem=function(bag,slot) local link=C_Container.GetContainerItemLink(bag,slot); return link and C_TooltipInfo.GetHyperlink(link) end,
  GetInventoryItem=function(unit,slot) local link=GetInventoryItemLink(unit,slot); return link and C_TooltipInfo.GetHyperlink(link) end
}
C_Timer.NewTimer=function(delay,callback)
  local timer={at=Now+delay,callback=callback,Cancel=function(self) self.cancelled=true end}
  Timers[#Timers+1]=timer
  return timer
end
function AdvanceTime(seconds)
  local target=Now+seconds
  for guard=1,1000 do
    local nextTimer
    for _,timer in ipairs(Timers) do if not timer.cancelled and timer.at<=target and (not nextTimer or timer.at<nextTimer.at) then nextTimer=timer end end
    if not nextTimer then Now=target; return end
    Now=nextTimer.at; nextTimer.cancelled=true; nextTimer.callback()
  end
  error("unbounded timers")
end
function NewItem(id,guid,name)
  local link="|cffa335ee|Hitem:"..id..":1234:5678:0:0:0:0:0:80:0:0:2:111:222:0:0|h["..name.."]|h|r"
  local item={id=id,guid=guid,name=name,link=link,loaded=true,stats={ITEM_MOD_STRENGTH_SHORT=100,ITEM_MOD_HASTE_RATING_SHORT=42},lines={{leftText=name},{leftText="装备：攻击有几率提高急速。"},{leftText="守护者套装 (1/5)"},{leftText="(2) 套装：提高伤害。"},{leftText="附魔：力量 +10"},{leftText="插槽奖励：暴击 +5"}}}
  Catalog[link]=item
  return item
end
'''.encode("utf-8")


class EquipmentTest(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        self.lua.execute(MOCK)
        self.lua.execute(EQUIPMENT_MOCK)
        self.ns = self.lua.table()
        load = self.lua.eval(b"function(source,ns) assert(loadstring(source))('test',ns) end")
        for filename in ("Protocol.lua", "Equipment.lua", "Transfer.lua"):
            load((ROOT / filename).read_bytes(), self.ns)
        self.lua.globals().NS = self.ns
        self.lua.execute(b'''Owner={session="1700000000-12500-123456",guid="Player-1-00000001"}
NS.Equipment.Initialize(Owner,function(record) Records[#Records+1]=record; NS.Transfer.Add(record) end)''')

    def baseline(self):
        self.ns[b"Equipment"][b"EnterWorld"]()
        self.lua.globals().AdvanceTime(2)

    def add(self, loaded=True):
        self.lua.execute('New=NewItem(12345,"Item-new-1","星辰守卫胸甲"); Bags[0][2]=New'.encode())
        self.lua.globals().New[b"loaded"] = loaded
        self.ns[b"Equipment"][b"OnEvent"](b"BAG_UPDATE_DELAYED")
        self.lua.globals().AdvanceTime(.2)

    def record(self, index=1):
        return json.loads(self.ns[b"Transfer"][b"JSON"](self.lua.globals().Records[index]))

    def test_login_baseline_never_announces_existing_inventory(self):
        self.lua.execute(b'Old=NewItem(100,"old-guid","old"); Bags[0][1]=Old; Inventory[5]=NewItem(101,"equipped-guid","worn")')
        self.baseline()
        self.ns[b"Equipment"][b"Scan"]()
        self.assertEqual(len(self.lua.globals().Records), 0)

    def test_new_gear_keeps_instance_link_stats_and_set_tooltip(self):
        self.baseline()
        self.add()
        record = self.record()
        self.assertEqual(record["name"], "星辰守卫胸甲")
        self.assertIn(":1234:5678:", record["link"])
        self.assertIn(":2:111:222:", record["link"])
        self.assertEqual(record["itemLevel"], 140.5)
        self.assertEqual(record["stats"][0], {"key": "ITEM_MOD_HASTE_RATING_SHORT", "value": 42})
        self.assertIn("(2) 套装：提高伤害。", record["tooltip"])
        self.assertTrue(all(record[key] for key in ("infoComplete", "statsComplete", "tooltipComplete")))

    def test_bag_moves_equip_and_duplicate_events_do_not_announce_again(self):
        self.baseline()
        self.add()
        self.lua.execute(b'Bags[0][3]=Bags[0][2]; Bags[0][2]=nil')
        self.ns[b"Equipment"][b"Scan"]()
        self.lua.execute(b'Inventory[5]=Bags[0][3]; Bags[0][3]=nil')
        self.ns[b"Equipment"][b"Scan"]()
        self.lua.execute(b'Bags[0][4]=Inventory[5]; Inventory[5]=nil')
        for _ in range(3):
            self.ns[b"Equipment"][b"Scan"]()
        self.assertEqual(len(self.lua.globals().Records), 1)

    def test_async_item_cache_retries_and_event_completes_once(self):
        self.baseline()
        self.add(loaded=False)
        self.assertEqual(len(self.lua.globals().Records), 0)
        self.assertEqual(self.lua.globals().LoadRequests, 1)
        self.lua.globals().New[b"loaded"] = True
        self.ns[b"Equipment"][b"OnEvent"](b"ITEM_DATA_LOAD_RESULT", 12345, True)
        self.lua.globals().AdvanceTime(30)
        self.assertEqual(len(self.lua.globals().Records), 1)
        self.assertTrue(self.record()["infoComplete"])

    def test_unavailable_fields_finish_partial_after_bounded_retries(self):
        self.baseline()
        self.add(loaded=False)
        self.lua.globals().AdvanceTime(30)
        record = self.record()
        self.assertIsNone(record["name"])
        self.assertFalse(record["infoComplete"])
        self.assertFalse(record["statsComplete"])
        self.assertFalse(record["tooltipComplete"])
        self.assertEqual(self.lua.globals().LoadRequests, 4)

    def test_secret_values_are_not_coerced_or_exported(self):
        self.baseline()
        self.lua.execute('New=NewItem(12345,"secret-gear","装备"); New.name=Secret; New.stats.ITEM_MOD_HASTE_RATING_SHORT=Secret; New.lines[1].leftText=Secret; Bags[0][1]=New'.encode())
        self.ns[b"Equipment"][b"Scan"]()
        self.lua.globals().AdvanceTime(30)
        record = self.record()
        self.assertIsNone(record["name"])
        self.assertFalse(record["statsComplete"])
        self.assertFalse(record["tooltipComplete"])
        self.assertNotIn("secret converted", json.dumps(record))

    def test_non_equipment_is_ignored(self):
        self.baseline()
        self.lua.execute(b'New=NewItem(99,"food","Food"); New.class=0; Bags[0][1]=New')
        self.ns[b"Equipment"][b"Scan"]()
        self.assertEqual(len(self.lua.globals().Records), 0)

    def test_guidless_moves_and_multiple_copies_use_conservative_count(self):
        self.lua.execute(b'Old=NewItem(100,nil,"old"); Bags[0][1]=Old')
        self.baseline()
        self.lua.execute(b'Bags[0][2]=Bags[0][1]; Bags[0][1]=nil')
        self.ns[b"Equipment"][b"Scan"]()
        self.assertEqual(len(self.lua.globals().Records), 0)
        self.lua.execute(b'Bags[0][3]=Old; Bags[0][4]=Old')
        self.ns[b"Equipment"][b"Scan"]()
        self.assertEqual(len(self.lua.globals().Records), 1)
        self.assertEqual(self.record()["quantity"], 2)

    def test_moved_slot_does_not_use_replacement_tooltip(self):
        self.baseline()
        self.add(loaded=False)
        self.lua.execute(b'Bags[0][2]=NewItem(999,"replacement","Other"); New.loaded=true')
        self.ns[b"Equipment"][b"OnEvent"](b"GET_ITEM_INFO_RECEIVED", 12345, True)
        self.assertEqual(self.record()["tooltip"][0], "星辰守卫胸甲")

    def test_real_fragments_round_trip_utf8_and_crc(self):
        self.baseline()
        self.add()
        frames, body = self.ns[b"Transfer"][b"Encode"](self.lua.globals().Records[1])
        pieces = []
        self.assertGreater(len(frames), 1)
        for index in range(1, len(frames) + 1):
            frame = frames[index]
            length, crc = struct.unpack("<HH", frame[4:8])
            payload = frame[8:8 + length]
            self.assertEqual(crc, binascii.crc_hqx(payload, 0xffff))
            self.assertEqual(len(frame), 512)
            fragment = json.loads(payload)
            piece = base64.b64decode(fragment["d"], validate=True)
            if index < len(frames):
                self.assertEqual(len(piece), 240)
            self.assertEqual(fragment["p"], index)
            pieces.append(piece)
        self.assertEqual(b"".join(pieces), body)
        self.assertEqual(json.loads(body)["name"], "星辰守卫胸甲")

    def test_long_tooltip_is_bounded_and_explicitly_partial(self):
        self.baseline()
        self.lua.execute('New=NewItem(12345,"long-gear","装备"); New.lines={}; for i=1,60 do New.lines[i]={leftText=string.rep("套装",90)} end; Bags[0][1]=New'.encode())
        self.ns[b"Equipment"][b"Scan"]()
        self.lua.globals().AdvanceTime(30)
        record = self.record()
        self.assertTrue(record["truncated"])
        self.assertFalse(record["tooltipComplete"])
        frames, body = self.ns[b"Transfer"][b"Encode"](self.lua.globals().Records[1])
        self.assertLessEqual(len(body), 8192)
        self.assertLessEqual(len(frames), 35)
        for line in record["tooltip"]:
            self.assertLessEqual(len(line.encode()), 256)

    def test_fragment_is_held_during_business_updates_and_state_alternates(self):
        self.baseline()
        self.add()
        transfer = self.ns[b"Transfer"]
        transfer[b"Advance"]()
        equipment_frame = transfer[b"Current"](b"state-1")
        self.assertEqual(transfer[b"Current"](b"changed-state"), equipment_frame)
        transfer[b"Advance"]()
        self.assertEqual(transfer[b"Current"](b"state-2"), b"state-2")

    def test_cache_is_bounded_and_expires(self):
        self.baseline()
        self.lua.execute('for i=1,8 do Bags[0][i]=NewItem(100+i,"gear-"..i,"装备"..i) end'.encode())
        self.ns[b"Equipment"][b"Scan"]()
        self.assertIn(b"6/6", self.ns[b"Transfer"][b"Status"]())
        self.lua.globals().AdvanceTime(601)
        self.ns[b"Transfer"][b"Advance"]()
        self.assertEqual(self.ns[b"Transfer"][b"Current"](b"state"), b"state")

    def test_cut_metadata_is_marked_partial_and_long_links_are_skipped(self):
        self.baseline()
        self.lua.execute(b'New=NewItem(12345,"long-name","name"); New.name=string.rep("x",200); Bags[0][1]=New')
        self.ns[b"Equipment"][b"Scan"]()
        self.lua.globals().AdvanceTime(30)
        self.assertEqual(len(self.record()["name"]), 128)
        self.assertTrue(self.record()["truncated"])
        self.assertFalse(self.record()["infoComplete"])
        self.lua.execute(b'Bad=NewItem(54321,"long-link","bad"); Bad.link=Bad.link..string.rep("x",1024); Bags[0][2]=Bad')
        self.ns[b"Equipment"][b"Scan"]()
        self.lua.globals().AdvanceTime(30)
        self.assertEqual(len(self.lua.globals().Records), 1)

    def test_pending_loads_are_bounded(self):
        self.baseline()
        self.lua.execute(b'''C_Container.GetContainerNumSlots=function(bag) return bag==0 and 100 or 0 end
for i=1,80 do local item=NewItem(1000+i,"pending-"..i,"item-"..i); item.loaded=false; Bags[0][i]=item end''')
        self.ns[b"Equipment"][b"Scan"]()
        self.assertEqual(self.lua.globals().LoadRequests, 64)
        self.assertIn(b"64", self.ns[b"Equipment"][b"Status"]())

    def test_restricted_bag_data_does_not_establish_empty_baseline(self):
        self.lua.execute(b'''Old=NewItem(100,"old-guid","old"); Bags[0][1]=Old
OriginalContainerInfo=C_Container.GetContainerItemInfo
C_Container.GetContainerItemInfo=function(bag,slot) if bag==0 and slot==1 then return Secret end; return OriginalContainerInfo(bag,slot) end''')
        self.baseline()
        self.lua.execute(b'C_Container.GetContainerItemInfo=OriginalContainerInfo')
        self.ns[b"Equipment"][b"OnEvent"](b"BAG_UPDATE_DELAYED")
        self.lua.globals().AdvanceTime(3)
        self.assertEqual(len(self.lua.globals().Records), 0)
        self.add()
        self.assertEqual(len(self.lua.globals().Records), 1)

    def test_main_addon_dispatches_acquisition_and_keeps_frame_on_state_change(self):
        lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        lua.execute(MOCK)
        lua.execute(EQUIPMENT_MOCK)
        ns = lua.table()
        load = lua.eval(b"function(source,name,ns) assert(loadstring(source))(name,ns) end")
        addon = ROOT.name.encode()
        for filename in ("Protocol.lua", "Money.lua", "Equipment.lua", "Transfer.lua", "EquipmentCompare.lua", "ConfirmEquip.lua", "Inventory.lua", "Quests.lua", "Talents.lua", "Telemetry.lua", ROOT.name + ".lua"):
            load((ROOT / filename).read_bytes(), addon, ns)
        lua.globals().Fire(b"ADDON_LOADED", addon)
        lua.globals().Fire(b"PLAYER_ENTERING_WORLD")
        lua.globals().AdvanceTime(2)
        lua.execute('New=NewItem(12345,"integration","测试护甲"); Bags[0][1]=New'.encode())
        lua.globals().Fire(b"BAG_UPDATE_DELAYED")
        lua.globals().AdvanceTime(.2)
        lua.globals().Heartbeat()
        frame_name = b"WoWForeverCompanionTelemetry" if ROOT.name == "WoWForeverCompanion" else b"WoWCompanionTelemetry"
        textures = lua.globals().Objects[frame_name][b"textures"]

        def pixels():
            return bytes(sum(int(textures[byte * 8 + bit + 1][b"color"][1]) << (7 - bit) for bit in range(8)) for byte in range(512))

        first = pixels()
        payload_length = struct.unpack("<H", first[4:6])[0]
        self.assertEqual(json.loads(first[8:8 + payload_length])["kind"], "cmp")
        lua.globals().Fire(b"PLAYER_LEVEL_UP", 30)
        self.assertEqual(pixels(), first)
        lua.globals().Heartbeat()
        state_frame = pixels()
        payload_length = struct.unpack("<H", state_frame[4:6])[0]
        self.assertEqual(json.loads(state_frame[8:8 + payload_length])["level"], 30)


if __name__ == "__main__":
    unittest.main()
