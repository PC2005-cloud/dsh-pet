"""Run real read-only task collection and bounded CRC frames in Lua 5.1."""
import base64
import binascii
import json
import struct
import unittest

from test_addon import LuaRuntime, MOCK, ROOT
from test_equipment import EQUIPMENT_MOCK

QUEST_MOCK = b'''Rows={{isHeader=true,title="Zone"},{isHeader=false,questID=42,title="Quest",level=15}}
Goals={[42]={{text="Collect: 2/3",type="item",numFulfilled=2,numRequired=3,finished=false}}}
Completed={9,4}; QuestCount=1
C_QuestLog={GetNumQuestLogEntries=function() return #Rows,QuestCount end,
 GetInfo=function(index) return Rows[index] end,
 GetQuestObjectives=function(id) return Goals[id] end,
 ReadyForTurnIn=function() return false end,IsFailed=function() return false end,
 GetAllCompletedQuestIDs=function() return Completed end}
function GetServerTime() return 1700000000+math.floor(GetTime()) end
'''


class QuestTests(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        for source in (MOCK, EQUIPMENT_MOCK, QUEST_MOCK):
            self.lua.execute(source)
        self.ns, self.g = self.lua.table(), self.lua.globals()
        self.g.NS = self.ns
        load = self.lua.eval(b'function(source,name,ns) assert(loadstring(source))(name,ns) end')
        for name in ('Protocol.lua', 'Transfer.lua', 'Quests.lua'):
            load((ROOT / name).read_bytes(), ROOT.name.encode(), self.ns)
        self.lua.execute(b'''Owner={session="1700000000-12500-123456",guid=Model.guid}; Captures={}
NS.Quests.Initialize(Owner,function(record)
 if record then Captures[#Captures+1]=record end
 return NS.Transfer.SetQuests(record)
end,NS.Transfer.QuestsBusy)''')

    def capture(self):
        self.ns[b'Quests'][b'OnEvent'](b'PLAYER_ENTERING_WORLD')
        self.g.AdvanceTime(.51)
        return self.record()

    def record(self):
        return json.loads(self.ns[b'Transfer'][b'QuestsJSON'](self.g.Captures[len(self.g.Captures)]))

    def drain(self):
        parts = {}
        states = 0
        for _ in range(2500):
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame == b'state':
                states += 1
                continue
            size, crc = struct.unpack('<HH', frame[4:8])
            payload = frame[8:8 + size]
            self.assertEqual(binascii.crc_hqx(payload, 0xffff), crc)
            fragment = json.loads(payload)
            if fragment['kind'] != 'qlog':
                continue
            parts[fragment['p']] = base64.b64decode(fragment['d'])
            if len(parts) == fragment['n']:
                self.assertGreater(states, 0)
                return json.loads(b''.join(parts[index] for index in range(1, fragment['n'] + 1)))
        self.fail('quest transfer did not finish')

    def test_current_objectives_and_historical_flags_keep_distinct_evidence(self):
        record = self.capture()
        self.assertTrue(record['log']['complete'])
        self.assertTrue(record['log']['entries'][0]['objectivesComplete'])
        self.assertFalse(record['log']['entries'][0]['readyForTurnIn'])
        self.assertEqual(record['log']['entries'][0]['objectives'][0]['fulfilled'], 2)
        self.assertFalse(record['log']['entries'][0]['objectives'][0]['finished'])
        self.assertEqual(record['completion']['ids'], [4, 9])
        self.assertEqual(record['completion']['scope'], 'unknown')
        self.assertEqual(record['completion']['turnIns'], [])
        self.assertEqual(self.drain(), record)

    def test_removed_or_ready_quests_do_not_fabricate_turn_ins(self):
        self.lua.execute(b'C_QuestLog.ReadyForTurnIn=function() return true end')
        self.capture(); self.drain()
        self.lua.execute(b'Rows={}; QuestCount=0')
        self.ns[b'Quests'][b'OnEvent'](b'QUEST_REMOVED', 42)
        self.g.AdvanceTime(.51)
        self.assertEqual(self.record()['completion']['turnIns'], [])
        self.assertEqual(self.record()['log']['entries'], [])

    def test_only_turn_in_events_supply_bounded_session_receipts(self):
        self.capture(); self.drain()
        self.lua.execute(b'C_QuestLog.GetAllCompletedQuestIDs=nil')
        for identifier in range(1, 35):
            self.ns[b'Quests'][b'OnEvent'](b'QUEST_TURNED_IN', identifier)
        self.g.AdvanceTime(.51)
        record = self.record()
        self.assertEqual(len(record['completion']['turnIns']), 32)
        self.assertTrue(record['completion']['truncated'])
        self.assertFalse(record['completion']['complete'])
        self.assertEqual(record['completion']['source'], 'session-events')
        self.assertEqual(record['completion']['ids'], [])

    def test_missing_or_restricted_apis_remain_unknown(self):
        self.lua.execute(b'C_QuestLog=nil')
        record = self.capture()
        self.assertFalse(record['log']['complete'])
        self.assertIsNone(record['log']['total'])
        self.assertEqual(record['completion']['source'], 'unknown')
        self.assertIsNone(record['completion']['total'])
        self.setUp()
        self.lua.execute(b'Goals[42][1].numFulfilled=Secret; C_QuestLog.ReadyForTurnIn=function() return Secret end')
        entry = self.capture()['log']['entries'][0]
        self.assertIsNone(entry['readyForTurnIn'])
        self.assertIsNone(entry['objectives'][0]['fulfilled'])
        self.assertFalse(entry['objectivesComplete'])

    def test_collapsed_or_hidden_quests_are_not_declared_absent(self):
        self.lua.execute(b'QuestCount=2')
        record = self.capture()
        self.assertEqual(record['log']['total'], 2)
        self.assertFalse(record['log']['complete'])

    def test_completed_id_and_payload_limits_preserve_explicit_truncation(self):
        self.lua.execute(b'''Completed={}; for i=1,700 do Completed[i]=i end
Rows={}; Goals={}; QuestCount=60
for i=1,60 do Rows[i]={isHeader=false,questID=i,title=string.rep("Title",32),level=15}; Goals[i]={}
 for n=1,8 do Goals[i][n]={text=string.rep("Objective",40),type="monster",numFulfilled=0,numRequired=10,finished=false} end end''')
        record = self.capture()
        self.assertEqual(len(record['completion']['ids']), 512)
        self.assertEqual(record['completion']['total'], 700)
        self.assertFalse(record['completion']['complete'])
        self.assertTrue(record['completion']['truncated'])
        self.assertFalse(record['log']['complete'])
        self.assertTrue(record['log']['truncated'])
        self.assertLess(len(record['log']['entries']), 50)
        self.assertLessEqual(len(json.dumps(record, ensure_ascii=False, separators=(',', ':')).encode()), 32768)
        self.assertEqual(self.drain(), record)

    def test_events_coalesce_and_dont_replace_an_incomplete_first_pass(self):
        self.capture()
        for _ in range(20):
            self.ns[b'Quests'][b'OnEvent'](b'QUEST_LOG_UPDATE')
        self.g.AdvanceTime(.51)
        self.assertEqual(len(self.g.Captures), 1)
        self.drain()
        self.lua.execute(b'Goals[42][1].numFulfilled=3; Goals[42][1].finished=true')
        self.ns[b'Quests'][b'Tick']()
        self.g.AdvanceTime(.51)
        self.assertEqual(len(self.g.Captures), 2)
        self.assertEqual(self.record()['id'], 2)

    def test_quiet_quest_refresh_and_logout_clear_only_task_transmission(self):
        self.capture(); self.drain()
        self.g.AdvanceTime(61)
        self.ns[b'Quests'][b'Tick']()
        self.g.AdvanceTime(.51)
        self.assertEqual(len(self.g.Captures), 2)
        self.ns[b'Quests'][b'OnEvent'](b'PLAYER_LOGOUT')
        for _ in range(30):
            self.ns[b'Transfer'][b'Advance']()
            self.assertEqual(self.ns[b'Transfer'][b'Current'](b'state'), b'state')

    def test_identity_changes_during_scan_dont_mix_character_tasks(self):
        self.lua.execute(b'local read=C_QuestLog.GetInfo; C_QuestLog.GetInfo=function(i) Model.guid="Player-other"; return read(i) end')
        self.ns[b'Quests'][b'OnEvent'](b'PLAYER_ENTERING_WORLD')
        self.g.AdvanceTime(.51)
        self.assertEqual(len(self.g.Captures), 0)

    def test_quest_first_pass_shares_background_slots_with_inventory(self):
        self.lua.execute(b'''NS.Transfer.SetInventory({v=1,id=1,session=Owner.session,guid=Owner.guid,observedAt=1700000000,
source="bags",bank="unknown",complete=true,items={{itemID=12359,quantity=7}}})''')
        self.capture()
        seen, totals = {}, {}
        states = 0
        for _ in range(250):
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame == b'state':
                states += 1
                continue
            size = struct.unpack('<H', frame[4:6])[0]
            part = json.loads(frame[8:8 + size])
            seen.setdefault(part['kind'], set()).add(part['p'])
            totals[part['kind']] = part['n']
            if all(kind in seen and len(seen[kind]) == totals[kind] for kind in ('inv', 'qlog')):
                break
        self.assertGreater(states, 0)
        self.assertIn('inv', seen)
        self.assertIn('qlog', seen)
        self.assertFalse(self.ns[b'Transfer'][b'InventoryBusy']())
        self.assertFalse(self.ns[b'Transfer'][b'QuestsBusy']())

    def test_real_lua_fixtures_export_task_progress_and_turn_in_evidence(self):
        self.capture(); self.drain()
        self.ns[b'Quests'][b'OnEvent'](b'QUEST_TURNED_IN', 9)
        self.g.AdvanceTime(.51)
        frames, body = self.ns[b'Transfer'][b'EncodeQuests'](self.g.Captures[len(self.g.Captures)])
        game = 'forever' if ROOT.name == 'WoWForeverCompanion' else 'retail'
        fixture = ROOT / 'tests' / 'fixtures'
        (fixture / f'lua-{game}-quests.json').write_bytes(body)
        (fixture / f'lua-{game}-quests.bin').write_bytes(b''.join(frames[index] for index in range(1, len(frames) + 1)))
        self.assertEqual(self.drain(), self.record())


if __name__ == '__main__':
    unittest.main()
