"""Exercise current equipped inventories through real Lua, events and CRC fragments."""
from __future__ import annotations

import base64
import binascii
import json
import struct
import unittest

from test_addon import LuaRuntime, MOCK, ROOT
from test_equipment import EQUIPMENT_MOCK
from test_confirm_equip import CONFIRM_MOCK


class LoadoutTest(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        self.lua.execute(MOCK)
        self.lua.execute(EQUIPMENT_MOCK)
        self.lua.execute(CONFIRM_MOCK)
        self.g, self.ns = self.lua.globals(), self.lua.table()
        self.g.NS = self.ns
        self.load = self.lua.eval(b'function(source,name,ns) assert(loadstring(source))(name,ns) end')
        for name in ('Protocol.lua', 'Equipment.lua', 'Transfer.lua', 'EquipmentCompare.lua', 'ConfirmEquip.lua'):
            self.load((ROOT / name).read_bytes(), ROOT.name.encode(), self.ns)
        self.lua.execute(b'''Owner={session="1700000000-12500-123456",guid=Model.guid,class=Model.class,spec=Model.spec}; GearRecords={}
NS.Equipment.Initialize(Owner,function(record) Records[#Records+1]=record; NS.Transfer.Add(record) end,
 function(record) GearRecords[#GearRecords+1]=record; NS.Transfer.SetGear(record) end)''')

    def capture(self, reason=b'login'):
        if reason == b'login':
            self.ns[b'Equipment'][b'EnterWorld']()
        else:
            self.ns[b'Equipment'][b'RequestCurrent'](reason)
        self.g.AdvanceTime(.21)

    def record(self, index=None):
        item = self.g.GearRecords[index or len(self.g.GearRecords)]
        return json.loads(self.ns[b'Transfer'][b'GearJSON'](item))

    def test_login_reads_all_nineteen_slots_with_explicit_empty_and_full_item_details(self):
        self.g.SetupOld(5, 100, '星辰守卫胸甲'.encode(), 150)
        self.capture()
        record = self.record()
        self.assertEqual(record['reason'], 'login')
        self.assertEqual([slot['slot'] for slot in record['slots']], list(range(1, 20)))
        self.assertEqual(len(self.g.Records), 0)
        self.assertEqual(record['slots'][0], {'slot': 1, 'state': 'empty', 'item': None})
        chest = record['slots'][4]
        self.assertEqual(chest['state'], 'equipped')
        self.assertEqual(chest['item']['itemID'], 100)
        self.assertEqual(chest['item']['name'], '星辰守卫胸甲')
        self.assertEqual(chest['item']['stats'][0]['key'], 'ITEM_MOD_HASTE_RATING_SHORT')
        self.assertEqual(chest['item']['tooltip'][0], '星辰守卫胸甲')
        self.assertTrue(all(chest['item'][key] for key in ['infoComplete', 'statsComplete', 'tooltipComplete']))
        self.assertNotIn('source', chest['item'])

    def test_unreadable_or_secret_slot_is_unknown_and_never_empty(self):
        self.lua.execute(b'''local exists=C_Item.DoesItemExist
C_Item.DoesItemExist=function(loc) if loc.slot==3 then return Secret end; if loc.slot==4 then error("restricted") end; return exists(loc) end''')
        self.capture()
        self.g.AdvanceTime(10)
        record = self.record()
        for slot in [3, 4]:
            self.assertEqual(record['slots'][slot - 1], {'slot': slot, 'state': 'unknown', 'item': None})
        self.assertNotIn('secret converted', json.dumps(record))

    def test_uncached_equipped_item_loads_then_refreshes_the_same_public_instance(self):
        self.g.Old = self.g.SetupOld(5, 100, b'Chest', 150)
        self.g.Old[b'loaded'] = False
        self.capture()
        self.assertEqual(len(self.g.GearRecords), 0)
        self.assertGreater(self.g.LoadRequests, 0)
        self.g.Old[b'loaded'] = True
        self.ns[b'Equipment'][b'OnEvent'](b'ITEM_DATA_LOAD_RESULT', 100, True)
        self.g.AdvanceTime(.06)
        self.assertTrue(self.record()['slots'][4]['item']['infoComplete'])
        self.assertEqual(len(self.g.GearRecords), 1)

    def test_missing_cache_is_bounded_and_later_data_replaces_partial_snapshot(self):
        self.g.Old = self.g.SetupOld(5, 100, b'Chest', 150)
        self.g.Old[b'loaded'] = False
        self.capture()
        self.g.AdvanceTime(20)
        record = self.record()
        self.assertEqual(self.g.LoadRequests, 4)
        item = record['slots'][4]['item']
        self.assertEqual(item['itemID'], 100)
        self.assertIsNone(item['name'])
        self.assertIsNone(item['itemLevel'])
        self.assertFalse(item['infoComplete'])
        self.g.Old[b'loaded'] = True
        self.ns[b'Equipment'][b'OnEvent'](b'GET_ITEM_INFO_RECEIVED', 100, True)
        self.g.AdvanceTime(.21)
        current = self.record()
        self.assertEqual(current['reason'], 'refresh')
        self.assertGreater(current['id'], record['id'])
        self.assertTrue(current['slots'][4]['item']['infoComplete'])

    def test_secret_metadata_never_becomes_known_or_a_zero_attribute(self):
        self.g.Old = self.g.SetupOld(5, 100, b'Chest', 150)
        self.lua.execute(b'Old.name=Secret; Old.compareStats={ITEM_MOD_INTELLECT_SHORT=Secret}; Old.lines[1].leftText=Secret; Old.guid=Secret')
        self.capture()
        self.g.AdvanceTime(20)
        item = self.record()['slots'][4]['item']
        self.assertIsNone(item['name'])
        self.assertIsNone(item['itemGUID'])
        self.assertEqual(item['stats'], [])
        self.assertFalse(item['statsComplete'])
        self.assertFalse(item['tooltipComplete'])

    def test_mid_read_slot_change_restarts_instead_of_mixing_old_and_new_items(self):
        self.g.SetupOld(5, 100, b'Old chest', 100)
        self.lua.execute(b'''local read=C_Item.GetItemStats; local changed=false
C_Item.GetItemStats=function(link)
 if not changed then changed=true; SetupOld(5,101,"Replacement chest",170) end
 return read(link)
end''')
        self.capture()
        self.assertEqual(len(self.g.GearRecords), 0)
        self.g.AdvanceTime(.51)
        self.assertEqual(self.record()['slots'][4]['item']['itemID'], 101)

    def test_character_exit_cancels_pending_reads_and_old_replays(self):
        self.g.SetupOld(5, 100, b'Chest', 150)
        self.capture()
        self.ns[b'Equipment'][b'RequestCurrent'](b'refresh')
        self.ns[b'Equipment'][b'OnEvent'](b'PLAYER_LEAVING_WORLD')
        self.g.AdvanceTime(30)
        self.assertEqual(len(self.g.GearRecords), 1)
        for _ in range(20):
            self.ns[b'Transfer'][b'Advance']()
            self.assertEqual(self.ns[b'Transfer'][b'Current'](b'state'), b'state')

    def test_identity_change_cannot_publish_previous_character_inventory(self):
        self.g.SetupOld(5, 100, b'Chest', 150)
        self.ns[b'Equipment'][b'EnterWorld']()
        self.g.Model[b'guid'] = b'Player-other'
        self.g.AdvanceTime(20)
        self.assertEqual(len(self.g.GearRecords), 0)

    def test_new_acquisition_updates_inventory_but_manual_review_does_not_fabricate_acquisition(self):
        self.g.SetupOld(5, 100, b'Chest', 100)
        self.capture()
        self.g.AdvanceTime(2)
        self.lua.execute(b'Bags[0][2]=NewItem(12345,"new-guid","New item"); Bags[0][2].level=170')
        self.ns[b'Equipment'][b'OnEvent'](b'BAG_UPDATE_DELAYED')
        self.g.AdvanceTime(.41)
        self.assertEqual(len(self.g.Records), 1)
        self.assertEqual(self.record()['reason'], 'equipment_acquired')
        count = len(self.g.GearRecords)
        self.lua.execute(b'function ApproveReview(record) return true end')
        self.ns[b'Equipment'][b'Review'](self.g.ApproveReview, 12345)
        self.g.AdvanceTime(.5)
        self.assertEqual(len(self.g.Records), 1)
        self.assertEqual(len(self.g.GearRecords), count)
        self.assertEqual(self.record()['slots'][4]['item']['itemID'], 100)

    def test_equipment_change_updates_worn_gear_and_removes_a_cleared_slot(self):
        self.g.SetupOld(5, 100, b'Chest', 150)
        self.capture()
        self.g.Inventory[5] = None
        self.ns[b'Equipment'][b'OnEvent'](b'PLAYER_EQUIPMENT_CHANGED', 5)
        self.g.AdvanceTime(.21)
        current = self.record()
        self.assertEqual(current['reason'], 'equipment_changed')
        self.assertEqual(current['slots'][4]['state'], 'empty')
        self.assertEqual(current['id'], 2)

    def test_per_item_limit_keeps_nineteen_slots_and_marks_truncated_tooltip(self):
        self.lua.execute(b'''for slot=1,19 do
 local item=SetupOld(slot,100+slot,"Long item",150)
 item.lines={}; for line=1,48 do item.lines[line]={leftText=string.rep("X",256)} end
end''')
        self.capture()
        record = self.record()
        frames, body = self.ns[b'Transfer'][b'EncodeGear'](self.g.GearRecords[1])
        self.assertLessEqual(len(body), 196608)
        self.assertLessEqual(len(frames), 820)
        for slot in record['slots']:
            item = slot['item']
            self.assertLessEqual(len(json.dumps(item, separators=(',', ':'), ensure_ascii=False).encode()), 8192)
            self.assertTrue(item['truncated'])
            self.assertFalse(item['tooltipComplete'])

    def test_crc_fragments_replay_without_starving_the_next_full_inventory(self):
        self.g.SetupOld(5, 100, b'Chest', 150)
        self.capture()
        expected = self.record()
        parts, seen_ids = {}, []
        for _ in range(300):
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame == b'state':
                continue
            size, crc = struct.unpack('<HH', frame[4:8])
            payload = frame[8:8 + size]
            self.assertEqual(binascii.crc_hqx(payload, 0xffff), crc)
            fragment = json.loads(payload)
            self.assertEqual(fragment['kind'], 'gear')
            self.assertEqual(fragment['n'], len(self.ns[b'Transfer'][b'EncodeGear'](self.g.GearRecords[1])[0]))
            if fragment['p'] == 1:
                seen_ids.append(fragment['id'])
            parts[fragment['p']] = base64.b64decode(fragment['d'], validate=True)
        self.assertGreaterEqual(len(seen_ids), 2)
        self.assertEqual(json.loads(b''.join(parts[p] for p in sorted(parts))), expected)
        self.g.SetupOld(5, 101, b'Replacement', 180)
        self.capture(b'equipment_changed')
        frame = b'state'
        for _ in range(2):
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame != b'state':
                break
        size = struct.unpack('<H', frame[4:6])[0]
        self.assertEqual(json.loads(frame[8:8 + size])['id'], 2)

    def test_actual_main_login_captures_only_after_character_identity_sampling(self):
        runtime = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        runtime.execute(MOCK)
        runtime.execute(EQUIPMENT_MOCK)
        runtime.execute(CONFIRM_MOCK)
        ns, g = runtime.table(), runtime.globals()
        g.NS = ns
        g.SetupOld(16, 100, b'Worn weapon', 170, b'INVTYPE_2HWEAPON')
        load = runtime.eval(b'function(source,name,ns) assert(loadstring(source))(name,ns) end')
        for filename in ('Protocol.lua', 'Money.lua', 'Equipment.lua', 'Transfer.lua', 'EquipmentCompare.lua', 'ConfirmEquip.lua', 'Inventory.lua', 'Quests.lua', 'Talents.lua', 'Telemetry.lua', ROOT.name + '.lua'):
            load((ROOT / filename).read_bytes(), ROOT.name.encode(), ns)
        g.Fire(b'ADDON_LOADED', ROOT.name.encode())
        g.Model[b'guid'] = b'Player-login-new'
        g.Fire(b'PLAYER_ENTERING_WORLD')
        g.AdvanceTime(.21)
        messages = []
        for _ in range(100):
            ns[b'Transfer'][b'Advance']()
            frame = ns[b'Transfer'][b'Current'](b'state')
            if frame != b'state':
                size = struct.unpack('<H', frame[4:6])[0]
                fragment = json.loads(frame[8:8 + size])
                messages.append(fragment)
        self.assertTrue(messages)
        self.assertTrue(all(value['g'] == 'Player-login-new' for value in messages))
        self.assertTrue(all(value['kind'] == 'gear' for value in messages))

    def to_lua(self, value):
        if isinstance(value, dict):
            return self.lua.table_from({key.encode(): self.to_lua(item) for key, item in value.items()})
        if isinstance(value, list):
            return self.lua.table_from([self.to_lua(item) for item in value])
        return value.encode() if isinstance(value, str) else value

    def next_fragment(self):
        for _ in range(2):
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame != b'state':
                size = struct.unpack('<H', frame[4:6])[0]
                return json.loads(frame[8:8 + size])
        return None

    def comparison(self):
        return json.loads((ROOT / 'tests' / 'fixtures' / 'lua-comparison-cases.json').read_text(encoding='utf-8'))[0]['comparison']

    def offer_and_swap(self):
        identity = {'s': self.g.Owner[b'session'].decode(), 'g': self.g.Owner[b'guid'].decode()}
        offer = {'v': 1, 'kind': 'offer', **identity, 'id': 1, 'q': 1, 'st': 'ready', 'slot': 5,
                 'item': 12345, 'n': 'New item', 'il': 150, 'old': 100, 'ol': 100, 'until': 1700000120}
        swap = {'v': 1, 'kind': 'swap', **identity, 'id': 1, 'e': 1, 'st': 'declined', 'r': 'user',
                'at': 1700000000, 'slot': 5, 'item': 12345, 'old': 100}
        self.ns[b'Transfer'][b'SetOffer'](self.to_lua(offer))
        self.ns[b'Transfer'][b'AddSwap'](self.to_lua(swap))

    def test_fresh_comparison_and_offer_interrupt_active_background_gear_within_eight_seconds(self):
        self.g.SetupOld(5, 100, b'Chest', 100)
        self.capture()
        self.assertEqual(self.next_fragment()['kind'], 'gear')
        comparison = self.comparison()
        comparison['candidate']['itemID'] = 12345
        self.ns[b'Transfer'][b'AddComparison'](self.to_lua(comparison))
        self.offer_and_swap()
        parts, ready, finished = {}, False, None
        for tick in range(1, 33):
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame == b'state':
                continue
            size = struct.unpack('<H', frame[4:6])[0]
            fragment = json.loads(frame[8:8 + size])
            if fragment['kind'] == 'offer':
                ready = True
            elif fragment['kind'] == 'cmp':
                parts[fragment['p']] = fragment['d']
                if len(parts) == fragment['n'] and ready:
                    finished = tick * .25
                    break
        self.assertIsNotNone(finished)
        self.assertLessEqual(finished, 8)

    def test_largest_nineteen_item_snapshot_completes_with_permanent_offer_result_traffic_before_ttl(self):
        self.lua.execute(b'''for slot=1,19 do
 local item=SetupOld(slot,100+slot,"Long item",150)
 item.lines={}; for line=1,48 do item.lines[line]={leftText=string.rep("X",256)} end
end''')
        self.capture()
        frames, body = self.ns[b'Transfer'][b'EncodeGear'](self.g.GearRecords[1])
        self.offer_and_swap()
        parts, first, finished = {}, None, None
        for tick in range(1, 5000):
            # A fixed source clock keeps old offer/result traffic alive for a conservative maximum.
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame == b'state':
                continue
            size = struct.unpack('<H', frame[4:6])[0]
            fragment = json.loads(frame[8:8 + size])
            if fragment['kind'] == 'gear':
                first = first or tick * .25
                parts[fragment['p']] = fragment['d']
                if len(parts) == len(frames):
                    finished = tick * .25
                    break
        self.assertEqual(len(parts), len(frames))
        self.assertLess(finished - first, 1200)
        self.assertLessEqual(finished, len(frames) + 2)
        self.assertEqual(b''.join(base64.b64decode(parts[p]) for p in sorted(parts)), body)

    def test_old_partial_comparison_restarts_at_first_fragment_after_long_fresh_loadout(self):
        self.lua.execute(b'''for slot=1,19 do
 local item=SetupOld(slot,100+slot,"Long item",150)
 item.lines={}; for line=1,48 do item.lines[line]={leftText=string.rep("X",256)} end
end''')
        self.capture()
        record = self.g.GearRecords[1]
        self.ns[b'Transfer'][b'SetGear'](None)
        comparison = self.to_lua(self.comparison())
        self.ns[b'Transfer'][b'AddComparison'](comparison)
        count = len(self.ns[b'Transfer'][b'EncodeComparison'](comparison)[0])
        for _ in range(count):
            self.assertEqual(self.next_fragment()['kind'], 'cmp')
        self.assertEqual(self.next_fragment()['p'], 1)
        self.assertEqual(self.next_fragment()['p'], 2)
        self.ns[b'Transfer'][b'SetGear'](record)
        gear_count = len(self.ns[b'Transfer'][b'EncodeGear'](record)[0])
        self.assertGreater(gear_count * .5, 180)
        for _ in range(gear_count):
            self.assertEqual(self.next_fragment()['kind'], 'gear')
        resumed = self.next_fragment()
        self.assertEqual(resumed['kind'], 'cmp')
        self.assertEqual(resumed['p'], 1)
        # Later alternation preserves the resumed stream cursor instead of replaying its first part forever.
        self.assertEqual(self.next_fragment()['kind'], 'gear')
        self.assertEqual(self.next_fragment()['p'], 2)

    def test_control_text_and_fractional_integer_metadata_are_unknown_not_invalid_complete_items(self):
        self.g.Old = self.g.SetupOld(5, 100, b'Chest', 150)
        self.g.Old[b'name'] = 'Bad\u0085Name'.encode()
        self.g.Old[b'compareStats'] = self.to_lua({'Bad\u0085Stat': 20})
        self.g.Old[b'lines'] = self.to_lua([{'leftText': 'Bad\u0085Line'}])
        self.lua.execute(b'local read=C_Item.GetItemInfo; C_Item.GetItemInfo=function(link) local name,link,quality,level,requiredLevel,kind,subtype,stack,loc=read(link); return name,link,0.5,level,1.5,kind,subtype,stack,loc end')
        self.capture()
        self.g.AdvanceTime(20)
        item = self.record()['slots'][4]['item']
        self.assertIsNone(item['name'])
        self.assertIsNone(item['quality'])
        self.assertIsNone(item['requiredLevel'])
        self.assertEqual(item['stats'], [])
        self.assertEqual(item['tooltip'], [])
        self.assertFalse(item['infoComplete'])

    def test_real_lua_gear_fixtures_include_full_body_and_crc_frame_stream(self):
        self.g.SetupOld(5, 100, '星辰守卫胸甲'.encode(), 150)
        self.g.SetupOld(16, 101, '守护者之剑'.encode(), 170, b'INVTYPE_WEAPONMAINHAND')
        self.g.Inventory[5][b'lines'] = self.lua.table_from([
            self.lua.table_from({b'leftText': line.encode()}) for line in ['星辰守卫胸甲', '附魔：力量 +10', '守护者套装 (2/5)', '(2) 套装：提高伤害。']
        ])
        self.capture()
        frames, body = self.ns[b'Transfer'][b'EncodeGear'](self.g.GearRecords[1])
        fixture = ROOT / 'tests' / 'fixtures'
        fixture.mkdir(exist_ok=True)
        game = 'forever' if ROOT.name == 'WoWForeverCompanion' else 'retail'
        (fixture / f'lua-{game}-gear.json').write_bytes(body)
        (fixture / f'lua-{game}-gear.bin').write_bytes(b''.join(frames[p] for p in range(1, len(frames) + 1)))
        self.assertEqual(json.loads(body)['slots'][4]['item']['tooltip'][2], '守护者套装 (2/5)')


if __name__ == '__main__':
    unittest.main()
