"""Exercise independent comparison fragments without changing other telemetry streams."""

from __future__ import annotations

import base64
import http.client
import json
import threading
import unittest
from pathlib import Path

from protocol import (EquipmentComparisonError, FrameError, decode_frame, decode_pixels, encode_frame,
                      pixels_for_frame, validate_comparison_fragment, validate_equipment_comparison)
from server import BridgeServer
from state import CompanionState
from test_bridge import snapshot
from test_equipment import fragments as equipment_fragments, record as equipment_record


def item(**changes):
    value = {"itemID": 1001, "name": "星辰法袍", "itemLevel": 150, "equipLoc": "INVTYPE_ROBE",
             "type": "护甲", "subtype": "布甲", "stats": [{"key": "ITEM_MOD_INTELLECT_SHORT", "value": 100}],
             "complex": False, "complete": True}
    value.update(changes)
    return value


def comparison(**changes):
    value = {"v": 1, "id": 1, "session": "test-session", "guid": "Player-1-TEST", "class": "MAGE",
             "spec": 64, "primary": 4, "observedAt": 1792800000, "slot": 5, "usable": True, "specMatch": True,
             "current": item(itemID=1000, itemLevel=140, stats=[{"key": "ITEM_MOD_INTELLECT_SHORT", "value": 90}]),
             "candidate": item()}
    value.update(changes)
    return value


def fragments(value=None, *, raw=None, envelope=None):
    value = value or comparison()
    payload = raw if raw is not None else json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    chunks = [payload[index:index + 240] for index in range(0, len(payload), 240)]
    return [{"v": 1, "kind": "cmp", "s": value["session"], "g": value["guid"], "id": value["id"],
             "p": index + 1, "n": len(chunks), "d": base64.b64encode(chunk).decode("ascii"), **(envelope or {})}
            for index, chunk in enumerate(chunks)]


class ComparisonProtocolTests(unittest.TestCase):
    def test_both_game_frames_round_trip_utf8_and_independent_kind(self):
        expected = comparison(candidate=item(name='测试"长袍\\中文'))
        for protocol in ("WCP1", "WCF1"):
            for part in fragments(expected):
                frame = encode_frame(part, protocol)
                self.assertEqual(len(frame), 512)
                self.assertEqual(decode_frame(frame, protocol), part)
                self.assertEqual(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol), part)
        with self.assertRaises(FrameError):
            decode_frame(encode_frame(fragments()[0], "WCP1"), "WCF1")

    def test_fragment_limits_and_canonical_base64(self):
        valid = fragments()[0]
        longest = {**valid, "s": "s" * 40, "g": "g" * 48, "id": 2147483647,
                   "n": 18, "p": 17, "d": base64.b64encode(b"x" * 240).decode("ascii")}
        self.assertEqual(len(encode_frame(longest)), 512)
        for change in ({"v": True}, {"id": False}, {"p": 0}, {"n": 19}, {"s": ""}, {"g": "bad id"},
                       {"kind": "eq"}, {"d": "!invalid"}, {"d": ""}, {"extra": 1}):
            with self.subTest(change=change), self.assertRaises(EquipmentComparisonError):
                validate_comparison_fragment({**valid, **change})
        final = {**valid, "n": 18, "p": 18, "d": base64.b64encode(b"x" * 16).decode("ascii")}
        self.assertEqual(validate_comparison_fragment(final), final)
        with self.assertRaises(EquipmentComparisonError):
            validate_comparison_fragment({**final, "d": base64.b64encode(b"x" * 17).decode("ascii")})

    def test_comparison_rejects_unknown_missing_or_invalid_scalar_fields(self):
        for change in ({"v": True}, {"id": 0}, {"session": ""}, {"guid": "bad guid"}, {"class": "mage"},
                       {"spec": True}, {"spec": -1}, {"primary": 3}, {"primary": False}, {"slot": 20},
                       {"observedAt": True}, {"observedAt": 4102444801}, {"usable": 1}, {"specMatch": 0},
                       {"command": "equip"}):
            with self.subTest(change=change), self.assertRaises(FrameError):
                validate_equipment_comparison(comparison(**change))
        for key in comparison():
            value = comparison()
            del value[key]
            with self.subTest(missing=key), self.assertRaises(FrameError):
                validate_equipment_comparison(value)

    def test_items_reject_invalid_text_numbers_stats_and_completeness(self):
        changes = [{"itemID": True}, {"itemID": 0}, {"itemLevel": -1}, {"itemLevel": float("nan")},
                   {"name": "中" * 43}, {"name": "bad\x1f"}, {"name": "bad\x7f"}, {"type": "bad\x85"},
                   {"subtype": "\ud800"}, {"complex": 1}, {"complete": None}, {"name": ""},
                   {"stats": [{"key": "x", "value": True}]}, {"stats": [{"key": "x", "value": float("inf")}]},
                   {"stats": [{"key": "x", "value": 1}, {"key": "x", "value": 2}]},
                   {"stats": [{"key": "\x9f", "value": 1}]}, {"stats": [{"key": "x", "value": 1, "extra": 1}]},
                   {"stats": [{"key": str(index), "value": index} for index in range(33)]}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(FrameError):
                validate_equipment_comparison(comparison(candidate=item(**change)))
        unknown = comparison(candidate=item(name="", complete=False), specMatch=None, primary=0)
        self.assertEqual(validate_equipment_comparison(unknown), unknown)

    def test_empty_and_unknown_targets_have_distinct_contracts(self):
        empty = item(itemID=0, itemLevel=-1, stats=[], name="空槽", equipLoc="", type="", subtype="")
        value = comparison(current=empty)
        self.assertEqual(validate_equipment_comparison(value), value)
        self.assertEqual(validate_equipment_comparison(comparison(slot=0, current=None))["slot"], 0)
        for change in ({"slot": 0}, {"current": None}, {"current": {**empty, "itemLevel": 0}},
                       {"current": {**empty, "stats": [{"key": "x", "value": 1}]}}):
            with self.subTest(change=change), self.assertRaises(FrameError):
                validate_equipment_comparison(comparison(**change))


class ComparisonStateTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.state = CompanionState(clock=lambda: self.now)
        self.state.ingest(snapshot())

    def ingest(self, value=None):
        for part in fragments(value):
            self.state.ingest(part)

    def test_out_of_order_duplicate_parts_reassemble_without_touching_equipment(self):
        value = comparison()
        parts = fragments(value)
        self.state.ingest(parts[-1])
        for part in reversed(parts):
            self.state.ingest(part)
        self.ingest(value)
        view = self.state.view()
        self.assertEqual(view["equipmentComparisons"], [value])
        self.assertIsNone(view["equipmentComparisonError"])
        self.assertEqual(view["equipment"], [])
        exposed = view["equipmentComparisons"]
        exposed[0]["candidate"]["stats"].clear()
        self.assertTrue(self.state.view()["equipmentComparisons"][0]["candidate"]["stats"])

    def test_equal_ids_in_both_streams_do_not_share_parts_or_deduplication(self):
        eq_parts = equipment_fragments(equipment_record())
        cmp_parts = fragments()
        for index in range(max(len(eq_parts), len(cmp_parts))):
            if index < len(eq_parts):
                self.state.ingest(eq_parts[index])
            if index < len(cmp_parts):
                self.state.ingest(cmp_parts[index])
        self.assertEqual(self.state.view()["equipment"], [equipment_record()])
        self.assertEqual(self.state.view()["equipmentComparisons"], [comparison()])

    def test_parts_conflicts_reject_one_comparison_and_keep_other_streams_live(self):
        first = fragments()[0]
        self.state.ingest(first)
        self.state.ingest({**first, "d": base64.b64encode(b"x" * 240).decode("ascii")})
        self.ingest()
        view = self.state.view()
        self.assertIn("冲突", view["equipmentComparisonError"])
        self.assertEqual(view["equipmentComparisons"], [])
        self.assertIsNone(view["equipmentError"])
        self.assertEqual(view["status"], "live")
        self.assertIsNone(view["error"])
        for part in equipment_fragments():
            self.state.ingest(part)
        self.assertEqual(len(self.state.view()["equipment"]), 1)

    def test_fragment_count_conflict_and_mismatched_inner_identity_are_rejected(self):
        self.state.ingest(fragments()[0])
        self.state.ingest({**fragments()[0], "n": fragments()[0]["n"] + 1})
        self.assertIn("冲突", self.state.view()["equipmentComparisonError"])
        for change in ({"id": 2}, {"session": "other-session"}, {"guid": "Other-Player"}):
            state = CompanionState()
            state.ingest(snapshot())
            for part in fragments(comparison(**change), envelope={"s": "test-session", "g": "Player-1-TEST", "id": 1}):
                state.ingest(part)
            self.assertEqual(state.view()["equipmentComparisons"], [])
            self.assertIn("标识", state.view()["equipmentComparisonError"])

    def test_wrong_character_or_class_cannot_enter_current_history(self):
        self.ingest(comparison(guid="Other-Player"))
        self.assertIn("其他角色", self.state.view()["equipmentComparisonError"])
        self.ingest(comparison(id=2, **{"class": "PALADIN"}))
        self.assertIn("职业", self.state.view()["equipmentComparisonError"])
        self.assertEqual(self.state.view()["equipmentComparisons"], [])

    def test_a_past_spec_remains_a_record_and_does_not_decide_a_new_offer(self):
        value = comparison(spec=63)
        self.ingest(value)
        self.assertEqual(self.state.view()["equipmentComparisons"], [value])
        self.assertIsNone(self.state.view()["equipmentOffer"])

    def test_comparison_does_not_refresh_heartbeat_or_create_events(self):
        event_id = self.state.event_id
        self.now = 4
        self.ingest()
        self.assertEqual(self.state.view()["ageSeconds"], 4)
        self.assertEqual(self.state.event_id, event_id)
        self.now = 6
        self.ingest(comparison(id=2))
        self.assertEqual(self.state.view()["status"], "stale")
        self.assertEqual(len(self.state.view()["equipmentComparisons"]), 1)
        self.assertIn("实时", self.state.view()["equipmentComparisonError"])

    def test_independent_pending_budgets_and_absolute_expiry(self):
        for identifier in range(1, 10):
            self.state.ingest(fragments(comparison(id=identifier))[0])
            self.state.ingest(equipment_fragments(equipment_record(id=identifier))[0])
        self.assertEqual(len(self.state.comparison_pending), 8)
        self.assertEqual(len(self.state.equipment_pending), 8)
        for second in range(1, 180):
            self.now = second
            self.state.ingest(snapshot(tick=second + 1))
        self.state.ingest(fragments()[0])
        self.now = 180
        self.state.view()
        self.assertEqual(self.state.comparison_pending, {})
        self.assertEqual(self.state.equipment_pending, {})
        self.assertIn("超时", self.state.view()["equipmentComparisonError"])

    def test_late_old_records_do_not_displace_the_latest_ten(self):
        for identifier in range(1, 14):
            self.ingest(comparison(id=identifier))
        self.assertEqual([value["id"] for value in self.state.view()["equipmentComparisons"]], list(range(4, 14)))
        self.ingest(comparison(id=2))
        self.assertEqual([value["id"] for value in self.state.view()["equipmentComparisons"]], list(range(4, 14)))

    def test_forgotten_ids_cannot_reenter_after_deduplication_rolls_over(self):
        for identifier in range(1, 260):
            self.ingest(comparison(id=identifier))
        self.assertEqual(len(self.state.comparison_seen), 256)
        self.ingest(comparison(id=1))
        self.assertEqual([value["id"] for value in self.state.view()["equipmentComparisons"]], list(range(250, 260)))

    def test_maximum_payload_is_bounded_and_duplicate_json_keys_are_rejected(self):
        raw = json.dumps(comparison(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        padded = raw + b" " * (4096 - len(raw))
        for part in fragments(raw=padded):
            self.state.ingest(decode_frame(encode_frame(part)))
        self.assertEqual(self.state.view()["equipmentComparisons"], [comparison()])
        self.assertEqual(len(fragments(raw=padded)), 18)
        bad = raw[:-1] + b',"id":1}'
        for part in fragments(comparison(id=2), raw=bad, envelope={"id": 2}):
            self.state.ingest(part)
        self.assertIn("JSON", self.state.view()["equipmentComparisonError"])

    def test_character_session_demo_and_config_changes_clear_partial_and_complete_data(self):
        for action in ("character", "session", "demo", "config"):
            with self.subTest(action=action):
                state = CompanionState()
                state.ingest(snapshot())
                for part in fragments():
                    state.ingest(part)
                state.ingest(fragments(comparison(id=2))[0])
                if action == "character":
                    state.ingest(snapshot(guid="Player-Other", tick=2))
                elif action == "session":
                    state.ingest(snapshot(session="new-session", tick=2))
                elif action == "demo":
                    state.set_demo(True)
                else:
                    state.update_config({"x": 9})
                self.assertEqual(state.view()["equipmentComparisons"], [])
                self.assertEqual(state.comparison_pending, {})

    def test_capture_comparison_error_is_independent_and_recovers_on_valid_record(self):
        self.state.capture_comparison_error("comparison decode failed")
        self.assertIsNone(self.state.view()["error"])
        self.assertIsNone(self.state.view()["equipmentError"])
        self.ingest()
        self.assertIsNone(self.state.view()["equipmentComparisonError"])

    def test_http_status_returns_required_comparison_fields(self):
        server = BridgeServer(("127.0.0.1", 0), self.state)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(*server.server_address)
            connection.request("GET", "/api/status")
            empty = json.loads(connection.getresponse().read())
            self.assertEqual(empty["equipmentComparisons"], [])
            self.assertIsNone(empty["equipmentComparisonError"])
            self.ingest()
            connection.request("GET", "/api/status")
            result = json.loads(connection.getresponse().read())
            self.assertEqual(result["equipmentComparisons"], [comparison()])
            self.assertEqual(result["snapshot"]["class"], "MAGE")
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


class ComparisonLuaFixtureTests(unittest.TestCase):
    def test_retail_lua_comparison_fragments(self):
        self.check_fixture("WoWMapCompanion", "retail", "WCP1")

    def test_forever_lua_comparison_fragments(self):
        self.check_fixture("WoWForeverCompanion", "forever", "WCF1")

    def check_fixture(self, addon, game, protocol):
        directory = Path(__file__).resolve().parent.parent / addon / "tests" / "fixtures"
        path = directory / "lua-comparison.json"
        if not path.exists():
            self.skipTest("真实 Lua 比较 fixture 尚未生成")
        expected = json.loads(path.read_text(encoding="utf-8"))
        files = sorted(directory.glob("lua-comparison-*.bin"))
        self.assertGreater(len(files), 1)
        state = CompanionState(game=game)
        state.ingest(snapshot(session=expected["session"], guid=expected["guid"], **{"class": expected["class"]}))
        for file in reversed(files):
            frame = file.read_bytes()
            self.assertEqual(len(frame), 512)
            state.ingest(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol))
        self.assertEqual(state.view()["equipmentComparisons"], [expected])
        self.assertIsNone(state.view()["equipmentComparisonError"])


if __name__ == "__main__":
    unittest.main()
