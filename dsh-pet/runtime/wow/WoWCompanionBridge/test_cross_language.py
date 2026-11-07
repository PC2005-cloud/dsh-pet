"""Optional integration test: actual Lua addon -> pixels -> Python -> level event."""

import importlib.util
import sys
import unittest
from pathlib import Path

from protocol import decode_frame, decode_pixels, pixels_for_frame
from state import CompanionState

ADDON = Path(__file__).resolve().parent.parent / "WoWMapCompanion"
sys.path.insert(0, str(ADDON / "tests" / ".deps"))
try:
    from lupa.lua51 import LuaRuntime
except ImportError:
    LuaRuntime = None


@unittest.skipUnless(LuaRuntime and (ADDON / "tests" / "test_addon.py").exists(),
                     "可选联测需要 WoWMapCompanion/tests/.deps 中的 lupa Lua 5.1")
class LuaBridgeIntegrationTests(unittest.TestCase):
    def test_real_lua_movement_and_unavailable_positions_for_both_games(self):
        for addon, name, game, protocol in (
            (ADDON, "WoWMapCompanion", "retail", "WCP1"),
            (ADDON.parent / "WoWForeverCompanion", "WoWForeverCompanion", "forever", "WCF1"),
        ):
            with self.subTest(game=game):
                spec = importlib.util.spec_from_file_location("wow_position_harness", addon / "tests" / "test_addon.py")
                harness = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(harness)
                lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
                lua.execute(harness.MOCK)
                lua.execute(b'''CoordX, CoordY = 0.1234, 0.5678
function C_Map.GetPlayerMapPosition(map, unit)
  assert(map == Model.map and unit == "player")
  return {GetXY=function() return CoordX, CoordY end}
end''')
                ns = lua.table()
                loader = lua.eval(b"function(source, name, ns) assert(loadstring(source))(name, ns) end")
                for filename in (line.strip() for line in (addon / f"{name}.toc").read_text(encoding="utf-8-sig").splitlines()
                                 if line.strip().endswith(".lua") and not line.lstrip().startswith("#")):
                    loader((addon / filename).read_bytes(), name.encode(), ns)
                g = lua.globals()
                g.Fire(b"ADDON_LOADED", name.encode())
                g.Fire(b"PLAYER_ENTERING_WORLD")
                engine = CompanionState(game=game)

                def transfer():
                    frame, _, _ = ns[b"Protocol"][b"Encode"](g[(name + "DB").encode()][b"snapshot"])
                    decoded = decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol)
                    engine.ingest(decoded)
                    return decoded

                first = transfer()
                self.assertEqual((first["px"], first["py"]), (1234, 5678))
                g.CoordX, g.CoordY = 0.4321, 0.8765
                g.Heartbeat()
                moved = transfer()
                self.assertEqual((moved["px"], moved["py"]), (4321, 8765))
                self.assertGreater(moved["seq"], first["seq"])
                self.assertGreater(moved["tick"], first["tick"])
                self.assertEqual([event["type"] for event in engine.view()["events"]], ["connected"])
                # A changed map with unavailable public position cannot retain the old map's coordinates.
                g.Model[b"map"] = 37
                g.Model[b"zone"] = b"Elwynn Forest"
                lua.execute(b"C_Map.GetPlayerMapPosition=function() return nil end")
                g.Fire(b"ZONE_CHANGED_NEW_AREA")
                unknown = transfer()
                self.assertEqual(unknown["map"], 37)
                self.assertIsNone(unknown["px"])
                self.assertIsNone(unknown["py"])
                self.assertEqual([event["type"] for event in engine.view()["events"]], ["connected", "zone"])
                g.Fire(b"PLAYER_LEAVING_WORLD")
                offline = transfer()
                self.assertFalse(offline["online"])
                self.assertIsNone(offline["px"])
                self.assertIsNone(offline["py"])

    def test_real_lua_level_event_to_python_pixels_to_state(self):
        self.check_game(ADDON, "WoWMapCompanion", "retail", "WCP1", 2)

    def test_forever_lua_level_and_money_at_cell_one(self):
        self.check_game(ADDON.parent / "WoWForeverCompanion", "WoWForeverCompanion", "forever", "WCF1", 1)

    def check_game(self, addon, name, game, protocol, cell):
        spec = importlib.util.spec_from_file_location("wow_addon_harness", addon / "tests" / "test_addon.py")
        harness = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(harness)
        lua = LuaRuntime(encoding=None, unpack_returned_tuples=True)
        lua.execute(harness.MOCK)
        ns = lua.table()
        loader = lua.eval(b"function(source, name, ns) local f, err=loadstring(source); assert(f,err); return f(name, ns) end")
        filenames = [line.strip() for line in (addon / f"{name}.toc").read_text(encoding="utf-8-sig").splitlines()
                     if line.strip().endswith(".lua") and not line.lstrip().startswith("#")]
        for filename in filenames:
            loader((addon / filename).read_bytes(), name.encode(), ns)
        g = lua.globals()
        g.Fire(b"ADDON_LOADED", name.encode())
        g.Fire(b"PLAYER_ENTERING_WORLD")
        engine = CompanionState(game=game)

        def render_and_ingest():
            frame, _, _ = ns[b"Protocol"][b"Encode"](g[(name + 'DB').encode()][b"snapshot"])
            decoded = decode_frame(frame, protocol)
            pixels = pixels_for_frame(frame, cell_size=cell)
            from_pixels = decode_pixels(pixels, 64 * cell, 64 * cell, cell, protocol)
            self.assertEqual(decoded, from_pixels)
            engine.ingest(from_pixels)

        render_and_ingest()
        self.assertEqual(engine.view()["snapshot"]["level"], 29)
        # UnitLevel intentionally still returns 29: event argument must win in real Lua code.
        g.Fire(b"PLAYER_LEVEL_UP", 30)
        render_and_ingest()
        render_and_ingest()
        g.Heartbeat()
        render_and_ingest()
        events = engine.view()["events"]
        self.assertEqual([e["type"] for e in events], ["connected", "level_up"])
        self.assertEqual(events[-1]["snapshot"]["level"], 30)
        self.assertIn("29", events[-1]["detail"])
        g.Model[b"copper"] = 150000
        g.Fire(b"PLAYER_MONEY")
        g.Model[b"copper"] = 120000
        g.Fire(b"PLAYER_MONEY")
        # No desktop frame was sampled between the gain and the expense.
        render_and_ingest()
        gold = engine.view()["snapshot"]
        self.assertEqual((gold["copper"], gold["earned"], gold["spent"]), (120000, 50000, 30000))
        self.assertTrue(gold["account"])
        self.assertTrue(gold["moneyEpoch"])
        self.assertEqual([event["type"] for event in engine.view()["events"]], ["connected", "level_up"])


if __name__ == "__main__":
    unittest.main()
