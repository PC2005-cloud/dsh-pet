"""Committed C_Traits capture, stable rank proofs and actual CRC transmission."""
import base64
import binascii
import json
import struct
import unittest

from test_addon import LuaRuntime, MOCK, ROOT
from test_equipment import EQUIPMENT_MOCK

TALENT_MOCK = b'''ConfigID=7; Staged=false; ConfigType=1; SpecID=71
Enum={TraitConfigType={Combat=1,CamelotCombat=4}}
Nodes={[9001]={ID=9001,ranksPurchased=1,activeRank=1,maxRanks=2,isAvailable=true,isVisible=true,meetsEdgeRequirements=true,
entryIDsWithCommittedRanks={101},activeEntry={entryID=101,rank=1},conditionIDs={601}},
[9002]={ID=9002,ranksPurchased=0,activeRank=0,maxRanks=1,entryIDsWithCommittedRanks={},conditionIDs={}}}
function UnitClass() return "Warrior","WARRIOR",1 end
function GetSpecialization() return 2 end
function GetSpecializationInfo(index) assert(index==2); return SpecID end
C_SpecializationInfo={GetSpecialization=function() return GetSpecialization() end,GetSpecializationInfo=function(index) return GetSpecializationInfo(index) end}
function GetBuildInfo() return BuildVersion,BuildNumber end
function GetLocale() return "zhCN" end
function GetServerTime() return 1700000000+math.floor(GetTime()) end
C_ClassTalents={GetActiveConfigID=function() return ConfigID end}
C_Traits={ConfigHasStagedChanges=function() return Staged end,
 GetConfigInfo=function(id) return {ID=id,type=ConfigType,name="Committed",treeIDs={777}} end,
 GetTreeNodes=function() return {9002,9001} end,
 GetNodeInfo=function(config,node) return Nodes[node] end,
 GetEntryInfo=function(config,entry) assert(entry==101); return {definitionID=501} end,
 GetDefinitionInfo=function(definition) assert(definition==501); return {spellID=1001} end,
 GetConditionInfo=function(config,condition) assert(condition==601); return {condID=601,isMet=true,playerLevel=10,spentAmountRequired=1,traitCurrencyID=4} end}
'''


class TalentTests(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        for source in (MOCK, EQUIPMENT_MOCK, TALENT_MOCK):
            self.lua.execute(source)
        self.ns, self.g = self.lua.table(), self.lua.globals()
        self.g.NS = self.ns
        self.g.BuildVersion = b'1.60.1' if ROOT.name == 'WoWForeverCompanion' else b'12.1.5'
        self.g.BuildNumber = b'70707' if ROOT.name == 'WoWForeverCompanion' else b'70575'
        load = self.lua.eval(b'function(source,name,ns) assert(loadstring(source))(name,ns) end')
        for name in ('Protocol.lua', 'Transfer.lua', 'Talents.lua'):
            load((ROOT / name).read_bytes(), ROOT.name.encode(), self.ns)
        self.lua.execute(b'''Owner={session="1700000000-12500-123456",guid=Model.guid}; Captures={}
NS.Talents.Initialize(Owner,function(record)
 if record then Captures[#Captures+1]=record end
 return NS.Transfer.SetTalents(record)
end,NS.Transfer.TalentsBusy)''')

    def capture(self):
        self.ns[b'Talents'][b'OnEvent'](b'PLAYER_ENTERING_WORLD')
        self.g.AdvanceTime(.51)
        return self.record()

    def record(self):
        return json.loads(self.ns[b'Transfer'][b'TalentsJSON'](self.g.Captures[len(self.g.Captures)]))

    def drain(self):
        parts = {}
        heartbeat = 0
        for _ in range(10000):
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame == b'state':
                heartbeat += 1
                continue
            size, crc = struct.unpack('<HH', frame[4:8])
            data = frame[8:8 + size]
            self.assertEqual(binascii.crc_hqx(data, 0xffff), crc)
            fragment = json.loads(data)
            if fragment['kind'] != 'traits':
                continue
            parts[fragment['p']] = base64.b64decode(fragment['d'])
            if len(parts) == fragment['n']:
                self.assertGreater(heartbeat, 0)
                return json.loads(b''.join(parts[index] for index in range(1, fragment['n'] + 1)))
        self.fail('talent transfer did not finish')

    def test_active_configuration_has_distinct_namespace_ids_ranks_zero_and_condition_evidence(self):
        record = self.capture()
        self.assertEqual(record['status'], 'active')
        self.assertFalse(record['hasStagedChanges'])
        self.assertTrue(record['complete'])
        self.assertEqual(record['class'], 'WARRIOR')
        self.assertEqual(record['classID'], 1)
        self.assertEqual(record['specID'], 71)
        self.assertEqual(record['treeIDs'], [777])
        self.assertEqual(record['knownZeroNodes'], [{'treeID': 777, 'nodeID': 9002}])
        node = record['nodes'][0]
        self.assertEqual(node['nodeID'], 9001)
        self.assertEqual(node['ranksPurchased'], 1)
        self.assertEqual(node['entries'], [{'entryID': 101, 'definitionID': 501, 'spellID': 1001, 'rank': 1, 'isActive': True}])
        self.assertEqual(node['conditions'][0]['playerLevel'], 10)
        self.assertEqual(self.drain(), record)

    def test_staged_or_unknown_staging_never_exports_preview_ranks_or_zero_nodes(self):
        for change, status in [(b'Staged=true', 'staged'), (b'Staged=nil', 'unknown'), (b'C_Traits.ConfigHasStagedChanges=nil', 'inaccessible')]:
            with self.subTest(change=change):
                self.setUp(); self.lua.execute(change)
                record = self.capture()
                self.assertEqual(record['status'], status)
                self.assertEqual(record['nodes'], [])
                self.assertEqual(record['knownZeroNodes'], [])
                self.assertFalse(record['complete'])

    def test_node_rank_changes_without_config_id_change_invalidate_the_whole_capture(self):
        self.lua.execute(b'''local read=C_Traits.GetNodeInfo; local n=0
C_Traits.GetNodeInfo=function(config,node)
 if node==9001 then n=n+1; if n==2 then Nodes[node].ranksPurchased=2 end end
 return read(config,node) end''')
        record = self.capture()
        self.assertEqual(record['status'], 'unknown')
        self.assertEqual(record['nodes'], [])
        self.assertEqual(record['knownZeroNodes'], [])

    def test_config_spec_and_staging_changes_during_scan_are_not_active(self):
        for change in [b'ConfigID=8', b'SpecID=72', b'Staged=true']:
            with self.subTest(change=change):
                self.setUp()
                self.lua.execute(b'local read=C_Traits.GetNodeInfo; C_Traits.GetNodeInfo=function(config,node) ' + change + b'; return read(config,node) end')
                record = self.capture()
                self.assertNotEqual(record['status'], 'active')
                self.assertEqual(record['nodes'], [])

    def test_partial_public_data_never_converts_secret_identifiers_or_ranks_to_zero(self):
        self.lua.execute(b'''local read=C_Traits.GetDefinitionInfo; C_Traits.GetDefinitionInfo=function(id) return {spellID=Secret} end
Nodes[9001].ranksPurchased=Secret
function UnitClass() return "Warrior","WARRIOR",Secret end''')
        record = self.capture()
        self.assertEqual(record['status'], 'active')
        self.assertIsNone(record['classID'])
        self.assertIsNone(record['nodes'][0]['ranksPurchased'])
        self.assertIsNone(record['nodes'][0]['entries'][0]['spellID'])
        self.assertFalse(record['complete'])
        self.assertFalse(record['nodes'][0]['entriesComplete'])

    def test_inaccessible_active_config_does_not_claim_an_empty_talent_build(self):
        self.lua.execute(b'C_ClassTalents.GetActiveConfigID=function() return Secret end')
        record = self.capture()
        self.assertEqual(record['status'], 'inaccessible')
        self.assertIsNone(record['configID'])
        self.assertFalse(record['complete'])
        self.assertEqual(record['nodes'], [])

    def test_mismatched_condition_identity_is_unknown_instead_of_a_met_prerequisite(self):
        self.lua.execute(b'C_Traits.GetConditionInfo=function() return {condID=999,isMet=true,playerLevel=10} end')
        record = self.capture()
        self.assertFalse(record['nodes'][0]['conditionsComplete'])
        self.assertIsNone(record['nodes'][0]['conditions'][0]['isMet'])
        self.assertIsNone(record['nodes'][0]['conditions'][0]['playerLevel'])
        self.assertFalse(record['complete'])

    def test_an_empty_unloaded_tree_does_not_prove_an_empty_committed_build(self):
        self.lua.execute(b'C_Traits.GetTreeNodes=function() return {} end')
        record = self.capture()
        self.assertFalse(record['complete'])
        self.assertEqual(record['nodes'], [])
        self.assertEqual(record['knownZeroNodes'], [])

    def test_profession_config_is_not_a_combat_talent_build_and_camelot_is_version_specific(self):
        self.lua.execute(b'ConfigType=2')
        self.assertEqual(self.capture()['status'], 'unknown')
        self.setUp(); self.lua.execute(b'ConfigType=4')
        self.assertEqual(self.capture()['status'], 'active' if ROOT.name == 'WoWForeverCompanion' else 'unknown')

    def test_combat_does_not_prevent_public_committed_reads_or_call_any_mutator(self):
        self.lua.execute(b'''Model.combat=true
C_Traits.CommitConfig=function() error("mutator") end
C_Traits.StageConfig=function() error("mutator") end
C_ClassTalents.LoadConfig=function() error("mutator") end''')
        self.assertEqual(self.capture()['status'], 'active')

    def test_trait_events_invalidate_an_unfinished_old_active_transfer_before_recollecting(self):
        self.capture()
        self.lua.execute(b'Staged=true')
        self.ns[b'Talents'][b'OnEvent'](b'TRAIT_NODE_CHANGED', 9001)
        self.g.AdvanceTime(.51)
        record = self.record()
        self.assertEqual(record['id'], 2)
        self.assertEqual(record['status'], 'staged')
        self.assertEqual(self.drain()['status'], 'staged')
        self.lua.execute(b'Staged=false')
        self.ns[b'Talents'][b'OnEvent'](b'TRAIT_CONFIG_UPDATED', 7)
        self.g.AdvanceTime(.51)
        self.assertEqual(self.record()['status'], 'active')

    def test_quiet_refresh_requires_a_finished_first_pass_and_logout_clears_replay(self):
        self.capture()
        self.g.AdvanceTime(61)
        self.ns[b'Talents'][b'Tick'](); self.g.AdvanceTime(.51)
        self.assertEqual(len(self.g.Captures), 1)
        self.drain()
        self.ns[b'Talents'][b'Tick'](); self.g.AdvanceTime(.51)
        self.assertEqual(len(self.g.Captures), 2)
        self.ns[b'Talents'][b'OnEvent'](b'PLAYER_LOGOUT')
        for _ in range(16):
            self.ns[b'Transfer'][b'Advance']()
            self.assertEqual(self.ns[b'Transfer'][b'Current'](b'state'), b'state')

    def test_identity_changes_during_collection_do_not_publish(self):
        self.lua.execute(b'local read=C_Traits.GetNodeInfo; C_Traits.GetNodeInfo=function(...) Model.guid="Player-other"; return read(...) end')
        self.ns[b'Talents'][b'OnEvent'](b'PLAYER_ENTERING_WORLD'); self.g.AdvanceTime(.51)
        self.assertEqual(len(self.g.Captures), 0)

    def test_missing_build_and_spec_are_unknown_not_index_or_truncated_versions(self):
        self.lua.execute(b'function GetBuildInfo() return "1.60", "70707" end; function GetSpecializationInfo() return nil end')
        record = self.capture()
        self.assertIsNone(record['clientBuild'])
        self.assertIsNone(record['specID'])

    def test_payload_budget_truncates_known_zeros_before_selected_nodes_without_inventing_absence(self):
        self.lua.execute(b'''Nodes={}; local ids={}
for n=1,2000 do ids[n]=n; Nodes[n]={ID=n,ranksPurchased=n<=500 and 1 or 0,activeRank=n<=500 and 1 or 0,maxRanks=2,
isAvailable=true,isVisible=true,meetsEdgeRequirements=true,entryIDsWithCommittedRanks={},conditionIDs={}}
if n<=500 then Nodes[n].activeEntry={entryID=101,rank=1}; for e=1,8 do Nodes[n].entryIDsWithCommittedRanks[e]=100+e; Nodes[n].conditionIDs[e]=600+e end end end
C_Traits.GetTreeNodes=function() return ids end
C_Traits.GetEntryInfo=function(config,entry) return {definitionID=entry+2000} end
C_Traits.GetDefinitionInfo=function(def) return {spellID=def+3000} end
C_Traits.GetConditionInfo=function(config,condition) return {condID=condition,isMet=true,playerLevel=10,spentAmountRequired=1,traitCurrencyID=4} end''')
        record = self.capture()
        self.assertEqual(record['status'], 'active')
        self.assertTrue(record['truncated'])
        self.assertFalse(record['complete'])
        self.assertLess(len(record['nodes']), 128)
        self.assertEqual(record['knownZeroNodes'], [])
        self.assertLessEqual(len(json.dumps(record, ensure_ascii=False, separators=(',', ':')).encode()), 65536)
        self.assertEqual(self.drain(), record)

    def test_inventory_tasks_traits_and_equipment_all_finish_without_stealing_heartbeat(self):
        self.lua.execute(b'''local inv={v=1,id=1,session=Owner.session,guid=Owner.guid,observedAt=1700000000,source="bags",bank="unknown",complete=true,items={{itemID=12359,quantity=7}}}
NS.Transfer.SetInventory(inv)
NS.Transfer.SetQuests({v=1,id=1,session=Owner.session,guid=Owner.guid,observedAt=1700000000,source="quest-log",
log={complete=true,truncated=false,total=0,entries={}},completion={source="unknown",scope="unknown",complete=false,truncated=false,total=nil,ids={},turnIns={}}})
local gear={v=1,id=1,session=Owner.session,guid=Owner.guid,observedAt=1700000000,reason="login",slots={}}
for n=1,19 do gear.slots[n]={slot=n,state="empty"} end
NS.Transfer.SetGear(gear)''')
        self.capture()
        seen, totals, heartbeat = {}, {}, 0
        for _ in range(1000):
            self.ns[b'Transfer'][b'Advance']()
            frame = self.ns[b'Transfer'][b'Current'](b'state')
            if frame == b'state':
                heartbeat += 1
                continue
            size = struct.unpack('<H', frame[4:6])[0]
            part = json.loads(frame[8:8 + size])
            seen.setdefault(part['kind'], set()).add(part['p'])
            totals[part['kind']] = part['n']
            if all(kind in seen and len(seen[kind]) == totals[kind] for kind in ('inv', 'qlog', 'traits', 'gear')):
                break
        self.assertGreater(heartbeat, 0)
        for kind in ('inv', 'qlog', 'traits', 'gear'):
            self.assertIn(kind, seen)
            self.assertEqual(len(seen[kind]), totals[kind])

    def test_real_fixture_uses_the_actual_collector_encoder_and_crc_frames(self):
        self.capture()
        frames, body = self.ns[b'Transfer'][b'EncodeTalents'](self.g.Captures[1])
        game = 'forever' if ROOT.name == 'WoWForeverCompanion' else 'retail'
        fixture = ROOT / 'tests' / 'fixtures'
        (fixture / f'lua-{game}-talents.json').write_bytes(body)
        (fixture / f'lua-{game}-talents.bin').write_bytes(b''.join(frames[index] for index in range(1, len(frames) + 1)))
        self.assertEqual(self.drain(), self.record())


if __name__ == '__main__':
    unittest.main()
