"""Verify that game-confirmed equipment outcomes remain read-only telemetry."""

from __future__ import annotations

import binascii
import http.client
import json
import struct
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from protocol import (EquipmentSwapError, FrameError, decode_frame, decode_pixels,
                      encode_frame, pixels_for_frame, validate_equipment_swap)
from server import BridgeServer, capture_loop
from state import CompanionState
from window import GameWindow
from test_bridge import snapshot
from test_equipment import fragments, record


def swap(**changes):
    value = {"v": 1, "kind": "swap", "s": "test-session", "g": "Player-1-TEST",
             "id": 1, "e": 5, "st": "equipped", "r": "confirmed", "at": 1792800000,
             "slot": 5, "item": 19019, "old": 19018}
    value.update(changes)
    return value


def unchecked_frame(value):
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return (b"WCP1" + struct.pack("<HH", len(payload), binascii.crc_hqx(payload, 0xFFFF))
            + payload).ljust(512, b"\0")


class EquipmentSwapProtocolTests(unittest.TestCase):
    def test_all_outcomes_round_trip_both_pixel_protocols(self):
        outcomes = [("equipped", "confirmed"), ("declined", "user"), ("expired", "timeout")]
        outcomes += [("failed", reason) for reason in
                     ("timeout", "combat", "changed", "unavailable", "locked", "cursor",
                      "dead", "restricted", "disabled", "left_world")]
        for protocol in ("WCP1", "WCF1"):
            for status, reason in outcomes:
                with self.subTest(protocol=protocol, status=status, reason=reason):
                    value = swap(st=status, r=reason)
                    frame = encode_frame(value, protocol)
                    self.assertEqual(len(frame), 512)
                    self.assertEqual(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol), value)

    def test_maximum_swap_fits_one_frame_and_wrong_game_or_crc_is_rejected(self):
        value = swap(s="s" * 40, g="g" * 48, id=2147483647, e=2147483647, at=4102444800,
                     item=2147483647, old=2147483647, slot=19, st="failed", r="unavailable")
        frame = encode_frame(value)
        self.assertEqual(decode_frame(frame), value)
        self.assertLessEqual(struct.unpack_from("<H", frame, 4)[0], 504)
        with self.assertRaisesRegex(FrameError, "另一个"):
            decode_frame(frame, "WCF1")
        broken = bytearray(frame)
        broken[100] ^= 1
        with self.assertRaisesRegex(FrameError, "CRC"):
            decode_frame(bytes(broken))
        self.assertEqual(validate_equipment_swap(swap(at=0, old=0, slot=1))["old"], 0)

    def test_schema_rejects_missing_extra_bad_types_ranges_and_outcome_pairs(self):
        changes = [{"v": 2}, {"v": True}, {"kind": "equip"}, {"s": ""}, {"s": "x" * 41},
                   {"s": "a b"}, {"g": "角色"}, {"g": "g" * 49}, {"g": "x\n"},
                   {"id": 0}, {"id": True}, {"id": 2147483648}, {"e": 0}, {"item": 0},
                   {"item": 1.5}, {"old": -1}, {"old": 2147483648}, {"at": -1},
                   {"at": 4102444801}, {"at": None}, {"slot": 0}, {"slot": 20},
                   {"st": []}, {"st": "pending"}, {"r": []}, {"r": "user"},
                   {"st": "declined", "r": "confirmed"}, {"st": "expired", "r": "combat"},
                   {"st": "failed", "r": "confirmed"}, {"st": "failed", "r": "user"},
                   {"name": "不允许扩展的字段"}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(EquipmentSwapError):
                validate_equipment_swap(swap(**change))
        for key in swap():
            value = swap()
            del value[key]
            with self.subTest(missing=key), self.assertRaises(EquipmentSwapError):
                validate_equipment_swap(value)
        for value in (None, [], "swap"):
            with self.assertRaises(EquipmentSwapError):
                validate_equipment_swap(value)
        with self.assertRaises(EquipmentSwapError):
            decode_frame(unchecked_frame(swap(st="equipped", r="timeout")))

    def test_actual_retail_lua_swap_crosses_pixels_to_http_state(self):
        self.check_lua_fixture("WoWMapCompanion", "retail", "WCP1")

    def test_actual_forever_lua_swap_crosses_pixels_to_http_state(self):
        self.check_lua_fixture("WoWForeverCompanion", "forever", "WCF1")

    def check_lua_fixture(self, addon, game, protocol):
        directory = Path(__file__).resolve().parent.parent / addon / "tests" / "fixtures"
        if not directory.exists():
            self.skipTest("真实 Lua 联测需要同级插件的 tests/fixtures")
        expected = json.loads((directory / "lua-swap.json").read_text(encoding="utf-8"))
        frame = (directory / "lua-swap.bin").read_bytes()
        result = decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol)
        self.assertEqual(result, expected)
        state = CompanionState(game=game)
        state.ingest(snapshot(session=expected["s"], guid=expected["g"]))
        state.ingest(result)
        state.ingest(result)
        self.assertEqual(state.view()["equipmentSwaps"], [expected])
        self.assertEqual([event["type"] for event in state.view()["events"]], ["connected"])
        self.assertEqual(state.view()["status"], "live")


class EquipmentSwapStateTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.state = CompanionState(clock=lambda: self.now)
        self.state.ingest(snapshot())

    def test_sorted_results_deduplicate_and_have_no_equipment_or_event_side_effects(self):
        before = self.state.view()
        for identifier in (5, 2, 8, 2, 1):
            self.state.ingest(swap(id=identifier))
        result = self.state.view()
        self.assertEqual([item["id"] for item in result["equipmentSwaps"]], [1, 2, 5, 8])
        self.assertEqual(result["equipment"], [])
        self.assertEqual(result["events"], before["events"])
        self.assertEqual(result["snapshot"], before["snapshot"])
        result["equipmentSwaps"][0]["item"] = 1
        self.assertEqual(self.state.view()["equipmentSwaps"][0]["item"], 19019)

    def test_conflicting_id_does_not_replace_result_even_outside_visible_list(self):
        for identifier in range(1, 12):
            self.state.ingest(swap(id=identifier))
        before = self.state.view()["equipmentSwaps"]
        self.state.ingest(swap(id=1, st="failed", r="changed"))
        result = self.state.view()
        self.assertEqual(result["equipmentSwaps"], before)
        self.assertIn("冲突", result["equipmentSwapError"])
        self.assertIsNone(result["equipmentError"])
        self.assertIsNone(result["error"])
        self.assertEqual(result["status"], "live")
        self.state.ingest(swap(id=12))
        self.assertIsNone(self.state.view()["equipmentSwapError"])

    def test_old_replays_cannot_evict_new_results_after_dedup_limit(self):
        for identifier in range(1, 301):
            self.state.ingest(swap(id=identifier))
        self.assertEqual(len(self.state.equipment_swap_seen), 256)
        self.assertEqual(self.state.equipment_swap_floor, 44)
        expected = list(range(291, 301))
        for identifier in range(300, 0, -1):
            self.state.ingest(swap(id=identifier))
        self.assertEqual([item["id"] for item in self.state.view()["equipmentSwaps"]], expected)
        self.assertEqual(len(self.state.equipment_swap_seen), 256)

    def test_swap_results_do_not_refresh_the_heartbeat_or_revive_stale_status(self):
        before = self.state.view()
        self.now += 4
        self.state.ingest(swap())
        current = self.state.view()
        self.assertEqual(current["lastSeen"], before["lastSeen"])
        self.assertEqual(current["ageSeconds"], 4)
        self.now += 2
        self.state.ingest(swap(id=2))
        self.assertEqual(self.state.view()["status"], "stale")
        self.assertEqual(self.state.view()["equipmentSwaps"], [swap()])
        self.assertIn("实时状态帧", self.state.view()["equipmentSwapError"])
        self.state.ingest(snapshot(tick=2))
        self.assertEqual(self.state.view()["equipmentSwaps"], [])
        self.assertEqual(self.state.equipment_swap_seen, {})
        self.state.ingest(swap())
        self.assertEqual(self.state.view()["equipmentSwaps"], [swap()])

    def test_only_matching_live_screen_identity_can_publish_swaps(self):
        for change in ({"s": "other-session"}, {"g": "Player-OTHER"}, {"slot": 20}):
            self.state.ingest(swap(**change))
            self.assertEqual(self.state.view()["equipmentSwaps"], [])
            self.assertIsNotNone(self.state.view()["equipmentSwapError"])
        empty = CompanionState()
        empty.ingest(swap())
        self.assertEqual(empty.view()["equipmentSwaps"], [])
        empty.set_demo(True)
        empty.ingest(swap(s="demo-session", g="DEMO-PLAYER"))
        self.assertEqual(empty.view()["equipmentSwaps"], [])

    def test_identity_config_pause_demo_and_offline_clear_all_swap_history(self):
        changes = [lambda: self.state.ingest(snapshot(session="other", seq=2, tick=2)),
                   lambda: self.state.ingest(snapshot(guid="Player-OTHER", seq=2, tick=2)),
                   lambda: self.state.ingest(snapshot(account="other", seq=2, tick=2)),
                   lambda: self.state.ingest(snapshot(online=False, seq=2, tick=2)),
                   lambda: self.state.update_config({"paused": True}),
                   lambda: self.state.update_config({"x": 10}),
                   lambda: self.state.set_demo(True)]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                self.setUp()
                self.state.ingest(swap())
                self.state.ingest(swap(id=1, st="failed", r="combat"))
                change()
                self.assertEqual(self.state.view()["equipmentSwaps"], [])
                self.assertIsNone(self.state.view()["equipmentSwapError"])
                self.assertEqual(self.state.equipment_swap_seen, {})
                self.assertEqual(self.state.equipment_swap_floor, 0)

    def test_game_instances_are_isolated_and_acquisition_data_remains_independent(self):
        other = CompanionState(game="forever", clock=lambda: self.now)
        other.ingest(snapshot())
        other.ingest(swap(item=111))
        for part in fragments(record()):
            self.state.ingest(part)
        self.state.ingest(swap())
        self.assertEqual(other.view()["equipmentSwaps"][0]["item"], 111)
        self.assertEqual(self.state.view()["equipmentSwaps"], [swap()])
        self.assertEqual(self.state.view()["equipment"], [record()])


class EquipmentSwapBoundaryTests(unittest.TestCase):
    def test_bad_swap_in_capture_loop_sets_only_swap_error(self):
        state = CompanionState()
        state.ingest(snapshot())
        before = state.view()
        pixels = pixels_for_frame(unchecked_frame(swap(r="user")), 1)
        capture = Mock()
        capture.grab.return_value = pixels
        stop = Mock()
        stop.is_set.side_effect = [False, True]
        windows = Mock()
        window = GameWindow(1, 1, 1, (0, 0, 800, 600))
        windows.discover.return_value = [window]
        windows.inspect.return_value = window
        with patch("capture.ScreenCapture", return_value=capture), patch("window.WindowsGameWindows", return_value=windows):
            capture_loop(state, stop)
        result = state.view()
        self.assertEqual(result["status"], "live")
        self.assertEqual(result["lastSeen"], before["lastSeen"])
        self.assertEqual(result["equipmentSwaps"], [])
        self.assertIsNotNone(result["equipmentSwapError"])
        self.assertIsNone(result["equipmentError"])
        self.assertIsNone(state.error)

    def test_http_exposes_results_but_does_not_accept_desktop_equip_commands(self):
        state = CompanionState()
        state.ingest(snapshot())
        state.ingest(swap())
        expected = state.view()
        server = BridgeServer(("127.0.0.1", 0), state)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            connection.request("GET", "/api/status")
            response = connection.getresponse()
            result = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(result["equipmentSwaps"], [swap()])
            self.assertIsNone(result["equipmentSwapError"])
            connection.request("POST", "/api/equip", json.dumps({"id": 5, "approved": True}),
                               {"Content-Type": "application/json"})
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 404)
            self.assertEqual(state.view()["equipmentSwaps"], expected["equipmentSwaps"])
            self.assertEqual(state.view()["events"], expected["events"])
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
