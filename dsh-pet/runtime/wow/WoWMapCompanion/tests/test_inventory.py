"""Run the actual read-only inventory collector and CRC transmitter under Lua 5.1."""
from __future__ import annotations

import base64
import binascii
import json
import struct
import unittest

from test_addon import LuaRuntime, MOCK, ROOT
from test_equipment import EQUIPMENT_MOCK


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        self.lua.execute(MOCK)
        self.lua.execute(EQUIPMENT_MOCK)
        self.ns, self.g = self.lua.table(), self.lua.globals()
        self.g.NS = self.ns
        load = self.lua.eval(b'function(source,name,ns) assert(loadstring(source))(name,ns) end')
        for name in ('Protocol.lua', 'Transfer.lua', 'Inventory.lua'):
            load((ROOT / name).read_bytes(), ROOT.name.encode(), self.ns)
        self.lua.execute(b'''Owner={session="1700000000-12500-123456",guid=Model.guid}; Captures={}
NS.Inventory.Initialize(Owner,function(record)
 if record then Captures[#Captures+1]=record end
 return NS.Transfer.SetInventory(record)
end,NS.Transfer.InventoryBusy)''')

    def capture(self):
        self.ns[b'Inventory'][b'OnEvent'](b'PLAYER_ENTERING_WORLD')
        self.g.AdvanceTime(.41)
        return self.record()

    def record(self):
        return json.loads(self.ns[b'Transfer'][b'InventoryJSON'](self.g.Captures[len(self.g.Captures)]))

    def drain(self):
        parts = {}
        for _ in range(1500):
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame == b'state':
                continue
            size, crc = struct.unpack('<HH', frame[4:8])
            payload = frame[8:8 + size]
            self.assertEqual(binascii.crc_hqx(payload, 0xffff), crc)
            fragment = json.loads(payload)
            if fragment['kind'] != 'inv':
                continue
            parts[fragment['p']] = base64.b64decode(fragment['d'])
            if len(parts) == fragment['n']:
                return json.loads(b''.join(parts[index] for index in range(1, fragment['n'] + 1)))
        self.fail('inventory did not finish while preserving heartbeat slots')

    def test_aggregates_materials_across_equipped_bags_and_excludes_all_banks(self):
        self.lua.execute(b'''Bags[0][1]={id=12359,quantity=8}; Bags[0][2]={id=12359,quantity=3}
Bags[5]={[1]={id=20,quantity=4}}
C_Container.GetContainerNumSlots=function(bag) assert(bag>=0 and bag<=5); return bag==0 and 20 or bag==5 and 1 or 0 end''')
        record = self.capture()
        self.assertEqual(record['items'], [{'itemID': 20, 'quantity': 4}, {'itemID': 12359, 'quantity': 11}])
        self.assertEqual(record['bank'], 'unknown')
        self.assertEqual(record['source'], 'bags')
        self.assertTrue(record['complete'])
        self.assertEqual(self.g.LoadRequests, 0)
        self.assertEqual(self.drain(), record)

    def test_empty_bags_are_complete_but_unknown_bank_never_becomes_empty(self):
        record = self.capture()
        self.assertEqual(record['items'], [])
        self.assertTrue(record['complete'])
        self.assertEqual(record['bank'], 'unknown')

    def test_secret_missing_and_failed_reads_make_a_partial_capture(self):
        for modification in [
            b'C_Container.GetContainerItemInfo=function() return Secret end',
            b'C_Container.GetContainerItemInfo=function() error("restricted") end',
            b'C_Container.GetContainerNumSlots=function() return Secret end',
            b'C_Container.GetContainerItemInfo=function() return {itemID=12359,stackCount=Secret} end',
            b'NUM_TOTAL_EQUIPPED_BAG_SLOTS=Secret',
            b'C_Container=nil',
        ]:
            with self.subTest(modification=modification):
                self.setUp()
                self.lua.execute(modification)
                record = self.capture()
                self.assertFalse(record['complete'])
                self.assertEqual(record['items'], [])

    def test_partial_capture_preserves_known_counts_without_completing_unknown_slots(self):
        self.lua.execute(b'''Bags[0][1]={id=12359,quantity=7}; local read=C_Container.GetContainerItemInfo
C_Container.GetContainerItemInfo=function(bag,slot) if bag==0 and slot==2 then return Secret end; return read(bag,slot) end''')
        record = self.capture()
        self.assertFalse(record['complete'])
        self.assertEqual(record['items'], [{'itemID': 12359, 'quantity': 7}])

    def test_bag_events_coalesce_and_publish_a_new_revision(self):
        self.capture()
        self.lua.execute(b'Bags[0][1]={id=12359,quantity=9}')
        for _ in range(25):
            self.ns[b'Inventory'][b'OnEvent'](b'BAG_UPDATE_DELAYED')
        self.g.AdvanceTime(.41)
        self.assertEqual(len(self.g.Captures), 2)
        self.assertEqual(self.record()['id'], 2)
        self.assertEqual(self.record()['items'][0]['quantity'], 9)

    def test_quiet_inventory_refreshes_after_transmission_not_each_heartbeat(self):
        self.lua.execute(b'function GetServerTime() return 1700000000 + math.floor(GetTime()) end')
        self.capture()
        for _ in range(10):
            self.ns[b'Inventory'][b'Tick']()
        self.assertEqual(len(self.g.Captures), 1)
        self.g.AdvanceTime(31)
        self.ns[b'Inventory'][b'Tick']()
        self.g.AdvanceTime(.41)
        self.assertEqual(len(self.g.Captures), 1)
        self.drain()
        self.ns[b'Inventory'][b'Tick']()
        self.g.AdvanceTime(.41)
        self.assertEqual(len(self.g.Captures), 2)
        self.assertGreater(self.record()['observedAt'], 1700000000)

    def test_unknown_capture_clock_retries_without_publishing_a_false_time(self):
        self.lua.execute(b'function GetServerTime() return Secret end')
        self.ns[b'Inventory'][b'OnEvent'](b'PLAYER_ENTERING_WORLD')
        self.g.AdvanceTime(.41)
        self.assertEqual(len(self.g.Captures), 0)
        self.lua.execute(b'function GetServerTime() return 1700000000 end')
        self.ns[b'Inventory'][b'Tick']()
        self.g.AdvanceTime(.41)
        self.assertEqual(len(self.g.Captures), 1)

    def test_exit_cancels_pending_collection_and_all_inventory_replays(self):
        self.capture()
        self.ns[b'Inventory'][b'OnEvent'](b'BAG_UPDATE_DELAYED')
        self.ns[b'Inventory'][b'OnEvent'](b'PLAYER_LEAVING_WORLD')
        self.g.AdvanceTime(40)
        self.ns[b'Inventory'][b'Tick']()
        self.assertEqual(len(self.g.Captures), 1)
        for _ in range(20):
            self.ns[b'Transfer'][b'Advance']()
            self.assertEqual(self.ns[b'Transfer'][b'Current'](b'state'), b'state')

    def test_identity_change_during_a_read_does_not_publish_mixed_character_counts(self):
        self.lua.execute(b'''local read=C_Container.GetContainerItemInfo
C_Container.GetContainerItemInfo=function(bag,slot) Model.guid="Player-other"; return read(bag,slot) end''')
        self.ns[b'Inventory'][b'OnEvent'](b'PLAYER_ENTERING_WORLD')
        self.g.AdvanceTime(.41)
        self.assertEqual(len(self.g.Captures), 0)

    def test_entry_cap_and_invalid_quantities_are_explicitly_partial(self):
        self.lua.execute(b'''C_Container.GetContainerNumSlots=function() return 200 end
C_Container.GetContainerItemInfo=function(bag,slot) return {itemID=1+bag*200+slot,stackCount=1} end''')
        record = self.capture()
        self.assertFalse(record['complete'])
        self.assertEqual(len(record['items']), 1000)
        self.assertEqual(self.drain(), record)

    def test_real_lua_inventory_fixtures_preserve_capture_scope_and_crc_frames(self):
        self.lua.execute(b'Bags[0][1]={id=12359,quantity=7}; Bags[0][2]={id=2840,quantity=12}')
        record = self.capture()
        frames, body = self.ns[b'Transfer'][b'EncodeInventory'](self.g.Captures[1])
        fixture = ROOT / 'tests' / 'fixtures'
        fixture.mkdir(exist_ok=True)
        game = 'forever' if ROOT.name == 'WoWForeverCompanion' else 'retail'
        (fixture / f'lua-{game}-inventory.json').write_bytes(body)
        (fixture / f'lua-{game}-inventory.bin').write_bytes(b''.join(frames[index] for index in range(1, len(frames) + 1)))
        self.assertEqual(self.drain(), record)


if __name__ == '__main__':
    unittest.main()
