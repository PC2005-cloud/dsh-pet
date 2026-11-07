"""Exercise public scene observations in the actual addon Lua and fixed frame."""
import json
import unittest

import test_addon


INSTANCE_MOCK = b'''
Scene={kind="none",id=571,inside=false,reads=0}
function GetInstanceInfo()
  Scene.reads=Scene.reads+1
  if Scene.infoError then error("info unavailable") end
  return "Instance",Scene.kind,1,"Normal",5,0,false,Scene.id
end
function IsInInstance()
  if Scene.insideError then error("type unavailable") end
  return Scene.inside,Scene.fallbackKind or Scene.kind
end
'''


class InstanceTest(unittest.TestCase):
    def setUp(self):
        self.lua=test_addon.LuaRuntime(encoding=None,unpack_returned_tuples=True)
        self.lua.execute(test_addon.MOCK)
        self.lua.execute(INSTANCE_MOCK)
        self.g=self.lua.globals()
        self.ns=self.lua.table()
        load=self.lua.eval(b"function(source,name,ns) assert(loadstring(source))(name,ns) end")
        root=test_addon.ROOT
        for line in (root/(root.name+'.toc')).read_text('utf-8').splitlines():
            if line.endswith('.lua'):
                load((root/line).read_bytes(),root.name.encode(),self.ns)
        self.g.Fire(b'ADDON_LOADED',root.name.encode())
        self.g.Fire(b'PLAYER_ENTERING_WORLD')

    def snapshot(self):
        return json.loads(self.g[test_addon.ROOT.name.encode()+b'DB'][b'snapshotJSON'])

    def scene(self,kind,instance_id=36):
        self.g.Scene[b'kind']=kind
        self.g.Scene[b'id']=instance_id
        self.g.Scene[b'inside']=True
        self.g.Fire(b'ZONE_CHANGED_NEW_AREA')
        return self.snapshot()

    def test_outdoor_type_does_not_export_the_continent_as_an_instance(self):
        value=self.snapshot()
        self.assertEqual(value['instanceType'],'none')
        self.assertIsNone(value['instanceID'])

    def test_public_party_raid_battleground_arena_and_scenario_are_distinct(self):
        for kind in [b'party',b'raid',b'pvp',b'arena',b'scenario']:
            with self.subTest(kind=kind):
                value=self.scene(kind)
                self.assertEqual(value['instanceType'],kind.decode())
                self.assertEqual(value['instanceID'],36)
                self.assertEqual(value['map'],84)

    def test_instance_change_updates_business_sequence_without_a_map_change(self):
        before=self.scene(b'party',36)
        changed=self.scene(b'raid',409)
        self.assertEqual(changed['map'],before['map'])
        self.assertGreater(changed['seq'],before['seq'])
        stable=changed['seq']
        self.g.Heartbeat()
        self.assertEqual(self.snapshot()['seq'],stable)

    def test_info_api_identifies_scenario_even_when_in_instance_flag_is_false(self):
        self.g.Scene[b'inside']=False
        self.g.Scene[b'kind']=b'scenario'
        self.g.Fire(b'PLAYER_ENTERING_WORLD')
        self.assertEqual(self.snapshot()['instanceType'],'scenario')

    def test_missing_or_failed_info_can_use_public_instance_type_without_id(self):
        for override in [b'GetInstanceInfo=nil',b'Scene.infoError=true']:
            with self.subTest(override=override):
                self.setUp()
                self.g.Scene[b'kind']=b'pvp'
                self.g.Scene[b'inside']=True
                self.lua.execute(override)
                self.g.Fire(b'ZONE_CHANGED')
                value=self.snapshot()
                self.assertEqual(value['instanceType'],'pvp')
                self.assertIsNone(value['instanceID'])

    def test_unavailable_and_secret_types_clear_the_previous_scene(self):
        for invalid in [self.g.Secret,b'unknown',b'invalid',None,42,True]:
            with self.subTest(invalid=type(invalid).__name__):
                self.scene(b'raid',409)
                self.g.Scene[b'kind']=invalid
                self.g.Scene[b'fallbackKind']=invalid
                self.g.Fire(b'ZONE_CHANGED')
                value=self.snapshot()
                self.assertEqual(value['instanceType'],'unknown')
                self.assertIsNone(value['instanceID'])
        self.g.Scene[b'infoError']=True
        self.g.Scene[b'insideError']=True
        self.g.Fire(b'ZONE_CHANGED')
        self.assertEqual(self.snapshot()['instanceType'],'unknown')

    def test_invalid_ids_never_leak_but_public_type_survives(self):
        for invalid in [self.g.Secret,0,-1,36.5,2147483648,float('nan'),float('inf'),b'36',True,None]:
            with self.subTest(invalid=type(invalid).__name__):
                value=self.scene(b'party',invalid)
                self.assertEqual(value['instanceType'],'party')
                self.assertIsNone(value['instanceID'])

    def test_inconsistent_or_secret_instance_flag_is_unknown(self):
        self.g.Scene[b'infoError']=True
        for inside,kind in [(True,b'none'),(False,b'party'),(self.g.Secret,b'party'),(None,b'pvp'),(1,b'raid')]:
            with self.subTest(kind=kind):
                self.g.Scene[b'inside']=inside
                self.g.Scene[b'kind']=kind
                self.g.Fire(b'ZONE_CHANGED')
                self.assertEqual(self.snapshot()['instanceType'],'unknown')
                self.assertIsNone(self.snapshot()['instanceID'])

    def test_logout_clears_scene_and_stops_api_reads(self):
        self.scene(b'raid',409)
        reads=self.g.Scene[b'reads']
        self.g.Fire(b'PLAYER_LEAVING_WORLD')
        self.g.Heartbeat()
        self.assertEqual(self.snapshot()['instanceType'],'unknown')
        self.assertIsNone(self.snapshot()['instanceID'])
        self.assertEqual(self.g.Scene[b'reads'],reads)

    def test_protocol_never_retains_id_for_none_unknown_or_offline(self):
        snapshot=self.g[test_addon.ROOT.name.encode()+b'DB'][b'snapshot']
        for kind,online in [(b'none',True),(b'unknown',True),(b'raid',False)]:
            with self.subTest(kind=kind,online=online):
                snapshot[b'instanceType']=kind
                snapshot[b'instanceID']=409
                snapshot[b'online']=online
                frame,payload,_=self.ns[b'Protocol'][b'Encode'](snapshot)
                value=json.loads(payload)
                self.assertEqual(len(frame),512)
                self.assertEqual(value['instanceType'],kind.decode() if online else 'unknown')
                self.assertIsNone(value['instanceID'])


    def test_capacity_policy_omits_scene_without_retaining_id(self):
        self.scene(b'pvp',529)
        snapshot=self.g[test_addon.ROOT.name.encode()+b'DB'][b'snapshot']
        exact={b'guid':b'G'*48,b'session':b's'*28,b'account':b'a'*29,b'moneyEpoch':b'e'*29,
               b'px':10000,b'py':10000,b'copper':9007199254740991,b'earned':9007199254740991,
               b'spent':9007199254740991,b'faction':b'Alliance',b'class':b'M'*20}
        for key,value in exact.items(): snapshot[key]=value
        for key in [b'name',b'realm',b'zone']: snapshot[key]=('测试'*100).encode()
        snapshot[b'seq'],snapshot[b'tick']=2147483647,2147483647
        snapshot[b'map'],snapshot[b'spec'],snapshot[b'level']=10000000,65535,255
        snapshot[b'race']=('熊'*16).encode()
        frame,payload,clean=self.ns[b'Protocol'][b'Encode'](snapshot)
        value=json.loads(payload)
        self.assertEqual(len(frame),512)
        self.assertLessEqual(len(payload),504)
        self.assertNotIn('instanceType',value)
        self.assertNotIn('instanceID',value)
        self.assertIsNone(clean[b'instanceType'])
        self.assertIsNone(clean[b'instanceID'])
        for key,expected in exact.items():
            self.assertEqual(value[key.decode()],expected.decode() if isinstance(expected,bytes) else expected)

if __name__ == '__main__':
    unittest.main()
