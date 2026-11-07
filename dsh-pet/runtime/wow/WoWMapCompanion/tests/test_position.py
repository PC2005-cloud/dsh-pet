"""Run real Lua collection, heartbeat and frame serialization for map coordinates."""
import binascii
import json
import struct
import unittest

import test_addon


POSITION_MOCK = b'''
Position = {x=.123456,y=.987654,reads=0,readable=true}
Point = {GetXY=function(self) return Position.x,Position.y end}
function canaccesstable(value)
  if rawequal(value,Point) then return Position.readable end
  return true
end
C_Map.GetPlayerMapPosition=function(map,unit)
  assert(map==Model.map and unit=="player")
  Position.reads=Position.reads+1
  if Position.apiError then error("position unavailable") end
  if Position.unavailable then return nil end
  if Position.secret then return Secret end
  return Point
end
'''


class PositionTest(unittest.TestCase):
    def setUp(self):
        self.lua = test_addon.LuaRuntime(encoding=None, unpack_returned_tuples=True)
        self.lua.execute(test_addon.MOCK)
        self.lua.execute(POSITION_MOCK)
        self.ns = self.lua.table()
        self.load = self.lua.eval(b"function(source,name,ns) local f,err=loadstring(source); assert(f,err); return f(name,ns) end")
        self.g = self.lua.globals()
        root = test_addon.ROOT
        for line in (root / f"{root.name}.toc").read_text("utf-8").splitlines():
            if line.endswith('.lua'):
                self.load((root / line).read_bytes(), root.name.encode(), self.ns)
        self.g.Fire(b"ADDON_LOADED", root.name.encode())
        self.g.Fire(b"PLAYER_ENTERING_WORLD")

    def snapshot(self):
        db = self.g[test_addon.ROOT.name.encode() + b"DB"]
        return json.loads(db[b"snapshotJSON"])

    def test_collects_map_scoped_position_with_hundredth_percent_precision(self):
        snapshot = self.snapshot()
        self.assertEqual((snapshot['map'], snapshot['px'], snapshot['py']), (84, 1235, 9877))
        self.assertEqual((snapshot['px'] / 100, snapshot['py'] / 100), (12.35, 98.77))

    def test_heartbeat_refreshes_motion_without_events_and_only_on_one_second_ticker(self):
        before = self.snapshot()
        reads = self.g.Position[b'reads']
        self.g.Position[b'x'] = .5
        self.g.Position[b'y'] = .25
        for _ in range(4):
            self.g.Tickers[2][b'callback']()
        self.assertEqual(self.g.Position[b'reads'], reads)
        self.assertEqual(self.snapshot()['px'], before['px'])
        self.g.Tickers[1][b'callback']()
        after = self.snapshot()
        self.assertEqual((after['px'], after['py']), (5000, 2500))
        self.assertEqual(after['tick'], before['tick'] + 1)
        self.assertEqual(after['seq'], before['seq'] + 1)
        self.assertEqual(self.g.Position[b'reads'], reads + 1)
        self.g.Tickers[1][b'callback']()
        self.assertEqual(self.snapshot()['seq'], after['seq'])

    def test_subprecision_movement_does_not_create_business_changes(self):
        before = self.snapshot()
        self.g.Position[b'x'] = .123457
        self.g.Heartbeat()
        after = self.snapshot()
        self.assertEqual(after['px'], before['px'])
        self.assertEqual(after['seq'], before['seq'])
        self.assertEqual(after['tick'], before['tick'] + 1)

    def test_map_change_unavailable_and_logout_clear_both_fields(self):
        self.g.Model[b'map'] = 37
        self.g.Position[b'x'], self.g.Position[b'y'] = .6, .7
        self.g.Fire(b'ZONE_CHANGED_NEW_AREA')
        self.assertEqual((self.snapshot()['map'], self.snapshot()['px'], self.snapshot()['py']), (37, 6000, 7000))
        self.g.Position[b'unavailable'] = True
        self.g.Model[b'map'] = 0
        self.g.Fire(b'ZONE_CHANGED_NEW_AREA')
        self.assertEqual(self.snapshot()['map'], 0)
        self.assertIsNone(self.snapshot()['px'])
        self.assertIsNone(self.snapshot()['py'])
        self.g.Position[b'unavailable'] = False
        self.g.Model[b'map'] = 84
        self.g.Fire(b'PLAYER_ENTERING_WORLD')
        self.assertEqual(self.snapshot()['px'], 6000)
        self.g.Fire(b'PLAYER_LEAVING_WORLD')
        reads = self.g.Position[b'reads']
        self.g.Heartbeat()
        self.assertFalse(self.snapshot()['online'])
        self.assertIsNone(self.snapshot()['px'])
        self.assertIsNone(self.snapshot()['py'])
        self.assertEqual(self.g.Position[b'reads'], reads)

    def test_zero_and_one_are_valid_map_edges(self):
        for x,y in [(0,0),(0,1),(1,0),(1,1)]:
            with self.subTest(x=x,y=y):
                self.g.Position[b'x'], self.g.Position[b'y'] = x,y
                self.g.Heartbeat()
                self.assertEqual((self.snapshot()['px'], self.snapshot()['py']), (x*10000,y*10000))

    def test_one_bad_component_invalidates_pair_without_secret_arithmetic(self):
        for expression in [b'nil',b'-0.1',b'1.1',b'0/0',b'math.huge',b'-math.huge',b'"0.5"',b'true',b'Secret']:
            for axis in [b'x',b'y']:
                with self.subTest(expression=expression,axis=axis):
                    self.lua.execute(b'Position.x=.4; Position.y=.6; Position.' + axis + b'=' + expression)
                    self.g.Heartbeat()
                    self.assertIsNone(self.snapshot()['px'])
                    self.assertIsNone(self.snapshot()['py'])

    def test_unreadable_or_throwing_position_paths_are_unknown(self):
        cases = [
            b'Position.apiError=true',
            b'Position.unavailable=true',
            b'Position.secret=true',
            b'Position.readable=false',
            b'Point.GetXY=nil',
            b'Point.GetXY=Secret',
            b'Point.GetXY=function() error("unreadable") end',
            b'Point=setmetatable({},{__index=function() error("unreadable field") end})',
            b'canaccesstable=function(value) if rawequal(value,Point) then error("unreadable table") end return true end',
            b'C_Map.GetPlayerMapPosition=nil',
            b'C_Map.GetBestMapForUnit=function() return Secret end',
            b'C_Map.GetBestMapForUnit=function() error("map unavailable") end',
        ]
        for setup in cases:
            with self.subTest(setup=setup):
                self.setUp()
                self.lua.execute(setup)
                self.g.Heartbeat()
                self.assertIsNone(self.snapshot()['px'])
                self.assertIsNone(self.snapshot()['py'])

    def test_protocol_sanitizes_partial_and_invalid_coordinates_atomically(self):
        db = self.g[test_addon.ROOT.name.encode() + b'DB']
        snapshot = db[b'snapshot']
        for x,y in [(None,5000),(5000,None),(-1,5000),(10001,5000),(2.5,5000)]:
            with self.subTest(x=x,y=y):
                snapshot[b'px'], snapshot[b'py'] = x,y
                _,payload,_ = self.ns[b'Protocol'][b'Encode'](snapshot)
                value = json.loads(payload)
                self.assertIsNone(value['px'])
                self.assertIsNone(value['py'])
        for field,value in [(b'online',False),(b'map',0),(b'map',84.5)]:
            with self.subTest(field=field,value=value):
                snapshot[b'online'], snapshot[b'map'] = True,84
                snapshot[b'px'], snapshot[b'py'] = 0,10000
                snapshot[field] = value
                _,payload,_ = self.ns[b'Protocol'][b'Encode'](snapshot)
                decoded = json.loads(payload)
                self.assertIsNone(decoded['px'])
                self.assertIsNone(decoded['py'])

    def test_worst_case_coordinates_keep_frame_size_crc_ids_and_counters(self):
        snapshot = self.g[test_addon.ROOT.name.encode() + b'DB'][b'snapshot']
        snapshot[b'px'], snapshot[b'py'] = 10000,10000
        snapshot[b'session'] = b's'*40
        snapshot[b'guid'] = b'g'*48
        snapshot[b'account'] = b'a'*64
        snapshot[b'moneyEpoch'] = b'e'*64
        for key in [b'name',b'realm',b'zone']:
            snapshot[key] = ('测试角色与地图'*12).encode()
        frame,payload,clean = self.ns[b'Protocol'][b'Encode'](snapshot)
        self.assertEqual(len(frame),512)
        self.assertLessEqual(len(payload),504)
        length,crc=struct.unpack('<HH',frame[4:8])
        self.assertEqual(payload,frame[8:8+length])
        self.assertEqual(crc,binascii.crc_hqx(payload,0xffff))
        value=json.loads(payload)
        self.assertEqual((value['px'],value['py']), (10000,10000))
        for key in ['session','guid','account','moneyEpoch','seq','tick','map','copper','earned','spent']:
            self.assertEqual(value[key], snapshot[key.encode()].decode() if isinstance(snapshot[key.encode()],bytes) else snapshot[key.encode()])


if __name__ == '__main__':
    unittest.main()
