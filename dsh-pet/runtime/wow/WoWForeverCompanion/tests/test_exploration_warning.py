"""Exercise boundary events, real Lua modules, territory gates, and arrival deduplication."""
import unittest

import test_addon


class ExplorationWarningTest(unittest.TestCase):
    def setUp(self):
        self.lua = test_addon.LuaRuntime(encoding=None, unpack_returned_tuples=True)
        self.lua.execute(test_addon.MOCK)
        self.lua.execute(b'''
            Clock=10
            function GetLocale() return "zhCN" end
            function GetTime() return Clock end
            C_PvP={GetZonePVPInfo=function()
                if Model.territoryError then error("unavailable") end
                return Model.territory
            end}
            function GetInstanceInfo() return "World", Model.instanceType or "none" end
            UIErrorsFrame={AddMessage=function(_, text) Alert=text; Alerts=(Alerts or 0)+1 end}
            Model.level=15; Model.faction="Horde"; Model.map=1413; Model.zone="Barrens"
        ''')
        self.g = self.lua.globals()
        self.ns = self.lua.table()
        load = self.lua.eval(b"function(source,name,ns) assert(loadstring(source))(name,ns) end")
        root = test_addon.ROOT
        for line in (root / (root.name + '.toc')).read_text('utf-8').splitlines():
            if line.endswith('.lua'):
                load((root / line).read_bytes(), root.name.encode(), self.ns)
        self.g.Fire(b'ADDON_LOADED', root.name.encode())
        self.g.Fire(b'PLAYER_ENTERING_WORLD')

    def enter(self, map_id=1424, territory=b'contested'):
        self.g.Model[b'map'] = map_id
        self.g.Model[b'territory'] = territory
        self.g.Fire(b'ZONE_CHANGED_NEW_AREA')

    def settle(self, seconds=0.25):
        self.g.Clock += seconds
        self.g.RetryTimers()

    def test_low_level_horde_warrior_warns_once_at_hillsbrad_boundary(self):
        self.g.Model[b'class'] = b'WARRIOR'
        self.enter()
        self.assertIsNone(self.g.Alert)
        self.settle()
        self.assertEqual(self.g.Alert.decode(), '这里对现在的你而言太早了，前面的区域，以后再来探索吧')
        self.assertIn(b'https://wuxianwow.com/atlas/1424', self.g.Messages[len(self.g.Messages)])
        for event in (b'ZONE_CHANGED', b'ZONE_CHANGED_INDOORS', b'PLAYER_LEVEL_UP'):
            self.g.Fire(event, 16)
        self.g.Heartbeat()
        self.g.RetryTimers()
        self.assertEqual(self.g.Alerts, 1)

    def test_minimum_level_and_higher_do_not_warn(self):
        for level in (20, 21, 60):
            with self.subTest(level=level):
                self.setUp()
                self.g.Model[b'level'] = level
                self.enter()
                self.settle()
                self.assertIsNone(self.g.Alert)

    def test_friendly_sanctuary_unknown_and_restricted_territory_do_not_warn(self):
        for territory in (b'friendly', b'sanctuary', b'unknown', None, 42):
            with self.subTest(territory=territory):
                self.setUp()
                self.enter(territory=territory)
                self.settle()
                self.assertIsNone(self.g.Alert)
        self.enter(territory=self.g.Secret)
        self.settle()
        self.assertIsNone(self.g.Alert)

    def test_enemy_territory_warns_for_both_known_factions(self):
        for faction in (b'Horde', b'Alliance'):
            self.setUp()
            self.g.Model[b'faction'] = faction
            self.enter(territory=b'hostile')
            self.settle()
            self.assertEqual(self.g.Alerts, 1)

    def test_unknown_map_level_and_instance_do_not_warn(self):
        for map_id in (2482, 999999):
            self.enter(map_id)
            self.settle()
            self.assertIsNone(self.g.Alert)
        self.g.Model[b'instanceType'] = b'party'
        self.enter()
        self.settle()
        self.assertIsNone(self.g.Alert)

    def test_login_and_character_switch_only_establish_baseline(self):
        self.g.Model[b'guid'] = b'Player-other'
        self.enter()
        self.settle()
        self.assertIsNone(self.g.Alert)
        self.g.Fire(b'PLAYER_ENTERING_WORLD')
        self.settle()
        self.assertIsNone(self.g.Alert)

    def test_delayed_territory_is_retried_but_not_after_five_seconds(self):
        self.enter(territory=None)
        self.settle()
        self.g.Model[b'territory'] = b'contested'
        self.g.Heartbeat()
        self.assertEqual(self.g.Alerts, 1)
        self.setUp()
        self.enter(territory=None)
        self.settle(6)
        self.g.Model[b'territory'] = b'contested'
        self.g.Heartbeat()
        self.assertIsNone(self.g.Alert)

    def test_fast_crossing_cancels_old_destination_and_reentry_can_warn(self):
        self.enter()
        self.enter(1413)
        self.settle()
        self.assertIsNone(self.g.Alert)
        self.enter()
        self.settle()
        self.assertEqual(self.g.Alerts, 1)

    def test_loading_unknown_map_does_not_create_an_arrival_on_return(self):
        self.enter()
        self.settle()
        self.g.Fire(b'PLAYER_LEAVING_WORLD')
        self.enter(0)
        self.g.Fire(b'PLAYER_ENTERING_WORLD')
        self.enter()
        self.settle()
        self.assertEqual(self.g.Alerts, 1)

    def test_missing_or_failed_territory_api_and_unknown_faction_do_not_warn(self):
        for script in (b'C_PvP=nil', b'Model.territoryError=true', b'Model.faction="Neutral"'):
            self.setUp()
            self.lua.execute(script)
            self.enter()
            self.settle()
            self.assertIsNone(self.g.Alert)


if __name__ == '__main__':
    unittest.main()
