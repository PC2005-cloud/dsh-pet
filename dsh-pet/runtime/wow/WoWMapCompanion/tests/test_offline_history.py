import json
import unittest
from pathlib import Path
import test_addon


class OfflineHistoryTests(unittest.TestCase):
    def runtime(self, folder):
        root = Path(__file__).resolve().parents[2] / folder
        lua = test_addon.LuaRuntime(encoding=None, unpack_returned_tuples=True)
        lua.execute(test_addon.MOCK)
        if folder == "WoWForeverCompanion": lua.execute(b'function GetBuildInfo() return "1.60.1","build","date",16001 end')
        lua.execute(b'clock=100; function GetTime() return clock end; function GetServerTime() return 1700000000+clock end')
        ns = lua.table()
        for name in ('Protocol.lua', 'Money.lua', 'Equipment.lua', 'Transfer.lua', 'OfflineHistory.lua', 'EquipmentCompare.lua', 'ConfirmEquip.lua', 'Inventory.lua', 'Quests.lua', 'Talents.lua', 'Telemetry.lua', folder+'.lua'):
            lua.execute((root/name).read_bytes(), folder.encode(), ns)
        lua.globals().Fire(b'ADDON_LOADED', folder.encode())
        lua.globals().Fire(b'PLAYER_ENTERING_WORLD')
        return lua, ns, root

    def test_money_and_levels_survive_without_any_desktop_and_flush_on_logout(self):
        for folder in ('WoWMapCompanion', 'WoWForeverCompanion'):
            lua, ns, root = self.runtime(folder)
            g = lua.globals()
            lua.execute(b'clock=101; Model.copper=99900; Fire("PLAYER_MONEY"); clock=102; Model.level=30; Fire("PLAYER_LEVEL_UP",30); Fire("PLAYER_LOGOUT")')
            db = g[(folder+'DB').encode()]
            result = json.loads(db[b'snapshotJSON'])
            character = result['offlineHistory']['characters']['Player-1-00000001']
            self.assertEqual(character['money'][0]['deltaCopper'], -100)
            self.assertEqual(character['levels'][-1]['level'], 30)
            self.assertEqual(character['levels'][-1]['durationBasis'], 'partial')
            self.assertEqual(result['offlineHistory']['game'], 'retail' if folder=='WoWMapCompanion' else 'forever')
            # Retain the SavedVariables table while resetting addon runtime, as /reload does.
            lua.execute(test_addon.MOCK)
            if folder == "WoWForeverCompanion": lua.execute(b'function GetBuildInfo() return "1.60.1","build","date",16001 end')
            lua.execute(b'clock=500; function GetTime() return clock end; function GetServerTime() return 1700000000+clock end; Model.level=30; Model.copper=99900')
            second = lua.table()
            for name in ('Protocol.lua','Money.lua','Equipment.lua','Transfer.lua','OfflineHistory.lua','EquipmentCompare.lua','ConfirmEquip.lua','Inventory.lua','Quests.lua','Talents.lua','Telemetry.lua',folder+'.lua'):
                lua.execute((root/name).read_bytes(), folder.encode(), second)
            g.Fire(b'ADDON_LOADED', folder.encode()); g.Fire(b'PLAYER_ENTERING_WORLD')
            lua.execute(b'clock=501; Model.copper=99850; Fire("PLAYER_MONEY"); Fire("PLAYER_LOGOUT")')
            result = json.loads(db[b'snapshotJSON'])
            money = result['offlineHistory']['characters']['Player-1-00000001']['money']
            self.assertEqual([row['deltaCopper'] for row in money], [-100, -50])
            self.assertEqual([row['id'] for row in money], [1, 2])

    def test_large_balances_multicharacter_and_json_do_not_change_grid_budget(self):
        lua, ns, _ = self.runtime('WoWMapCompanion')
        record = lua.eval(b'function() local slots={}; for i=1,19 do slots[i]={slot=i,state="empty"} end; return {v=1,id=1,guid="Player-1-00000001",session=WoWMapCompanionDB.snapshot.session,observedAt=GetServerTime(),reason="login",slots=slots} end')()
        ns.OfflineHistory.Equipment(record)
        lua.execute(b'Model.copper=9007199254740991; Fire("PLAYER_MONEY"); Fire("PLAYER_LOGOUT")')
        db = lua.globals().WoWMapCompanionDB
        result = json.loads(db[b'snapshotJSON'])
        self.assertEqual(result['offlineHistory']['characters']['Player-1-00000001']['snapshot']['copper'],9007199254740991)
        self.assertIsNone(result['offlineHistory']['characters']['Player-1-00000001']['equipment']['slots'][0]['item'])
        self.assertEqual(len(ns.Protocol.Encode(db[b'snapshot'])[0]),512)
        lua.execute(b'Model.guid="Player-2"; Model.copper=50; Fire("PLAYER_ENTERING_WORLD"); Fire("PLAYER_LOGOUT")')
        result = json.loads(db[b'snapshotJSON'])
        self.assertEqual(len(result['offlineHistory']['characters']),2)
        self.assertEqual(result['offlineHistory']['balanceCopper'], '9007199254741041')


if __name__ == '__main__':
    unittest.main()
