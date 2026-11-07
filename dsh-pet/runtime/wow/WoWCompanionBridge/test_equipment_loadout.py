"""Verify atomic current-equipment snapshots, separate from acquisition history."""

from __future__ import annotations

import base64
import binascii
import copy
import http.client
import json
import struct
import threading
import unittest
from pathlib import Path

from geometry import AdaptiveCaptureReader, Geometry, Image
from protocol import (EquipmentLoadoutError, FrameError, LOADOUT_MAX_BYTES, decode_frame,
                      decode_pixels, encode_frame, pixels_for_frame, validate_equipment_loadout,
                      validate_loadout_fragment)
from server import BridgeServer
from state import CompanionState, LOADOUT_PENDING_BYTES
from test_bridge import snapshot
from test_geometry import FakeCapture


def item(**changes):
    value = {"itemID": 1001, "itemGUID": "Item-1-TEST", "link": "item:1001::::::::",
             "name": "星辰法袍", "type": "护甲", "subtype": "布甲", "equipLoc": "INVTYPE_ROBE",
             "quality": 3, "itemLevel": 150, "requiredLevel": 20,
             "stats": [{"key": "ITEM_MOD_INTELLECT_SHORT", "value": 100}],
             "tooltip": ["星辰法袍", "装备：智力提高。", "套装（2）：示例效果。"],
             "infoComplete": True, "statsComplete": True, "tooltipComplete": True, "truncated": False}
    value.update(changes)
    return value


def loadout(**changes):
    slots = [{"slot": slot, "state": "empty", "item": None} for slot in range(1, 20)]
    slots[4] = {"slot": 5, "state": "equipped", "item": item()}
    slots[17] = {"slot": 18, "state": "unknown", "item": None}
    value = {"v": 1, "id": 1, "session": "test-session", "guid": "Player-1-TEST",
             "observedAt": 1792800000, "reason": "login", "slots": slots}
    value.update(changes)
    return value


def fragments(value=None, *, raw=None, envelope=None):
    value = value or loadout()
    payload = raw if raw is not None else json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    chunks = [payload[index:index + 240] for index in range(0, len(payload), 240)]
    return [{"v": 1, "kind": "gear", "s": value["session"], "g": value["guid"], "id": value["id"],
             "p": index + 1, "n": len(chunks), "d": base64.b64encode(chunk).decode("ascii"), **(envelope or {})}
            for index, chunk in enumerate(chunks)]


class LoadoutProtocolTests(unittest.TestCase):
    def test_both_profiles_round_trip_actual_equipped_attributes(self):
        value = loadout()
        for protocol in ("WCP1", "WCF1"):
            for part in fragments(value):
                frame = encode_frame(part, protocol)
                self.assertEqual(decode_frame(frame, protocol), part)
                self.assertEqual(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol), part)
        self.assertEqual(validate_equipment_loadout(value), value)

    def test_fragment_boundaries_and_canonical_base64(self):
        valid = fragments()[0]
        last = {**valid, "s": "s" * 40, "g": "g" * 48, "id": 2147483647,
                "n": 820, "p": 820, "d": base64.b64encode(b"x" * 48).decode("ascii")}
        self.assertEqual(len(encode_frame(last)), 512)
        self.assertEqual(validate_loadout_fragment(last), last)
        full = {**last, "p": 819, "d": base64.b64encode(b"x" * 240).decode("ascii")}
        self.assertEqual(len(encode_frame(full)), 512)
        for change in ({"v": True}, {"id": 0}, {"p": 0}, {"n": 821}, {"s": ""}, {"g": "bad guid"},
                       {"kind": "eq"}, {"d": "!"}, {"d": ""}, {"extra": 1}):
            with self.subTest(change=change), self.assertRaises(EquipmentLoadoutError):
                validate_loadout_fragment({**valid, **change})
        with self.assertRaises(EquipmentLoadoutError):
            validate_loadout_fragment({**last, "d": base64.b64encode(b"x" * 49).decode("ascii")})

    def test_body_scalars_and_exact_fields(self):
        for change in ({"v": True}, {"id": 0}, {"id": True}, {"session": ""}, {"guid": "bad guid"},
                       {"observedAt": -1}, {"observedAt": True}, {"observedAt": 4102444801},
                       {"reason": "bag_added"}, {"reason": None}, {"command": "equip"}):
            with self.subTest(change=change), self.assertRaises(FrameError):
                validate_equipment_loadout(loadout(**change))
        for key in loadout():
            invalid = loadout()
            del invalid[key]
            with self.subTest(missing=key), self.assertRaises(FrameError):
                validate_equipment_loadout(invalid)

    def test_all_nineteen_ordered_slots_are_required(self):
        good = loadout()["slots"]
        cases = [good[:-1], good + [copy.deepcopy(good[0])], list(reversed(good)),
                 [{**good[0], "slot": True}, *good[1:]], [{**good[0], "slot": 2}, *good[1:]],
                 [{**good[0], "extra": 1}, *good[1:]], [{**good[0], "state": "missing"}, *good[1:]]]
        for slots in cases:
            with self.subTest(slots=slots[:1]), self.assertRaises(FrameError):
                validate_equipment_loadout(loadout(slots=slots))

    def test_unknown_empty_and_equipped_cannot_be_interchanged(self):
        for state, carried in (("empty", item()), ("unknown", item()), ("equipped", None)):
            value = loadout()
            value["slots"][0].update(state=state, item=carried)
            with self.subTest(state=state), self.assertRaises(FrameError):
                validate_equipment_loadout(value)
        partial = item(name=None, quality=None, itemLevel=None, requiredLevel=None,
                       type=None, subtype=None, equipLoc=None, itemGUID=None, stats=[], tooltip=[],
                       infoComplete=False, statsComplete=False, tooltipComplete=False)
        value = loadout()
        value["slots"][4]["item"] = partial
        self.assertEqual(validate_equipment_loadout(value), value)

    def test_item_scalars_text_links_and_flags_are_strict(self):
        cases = [{"itemID": 0}, {"itemID": True}, {"link": "item:1002"}, {"link": "not-an-item"},
                 {"name": ""}, {"name": "中" * 43}, {"name": "bad\x1f"}, {"name": "bad\x7f"},
                 {"name": "bad\x85"}, {"name": "\ud800"}, {"quality": True}, {"quality": 9},
                 {"itemLevel": float("inf")}, {"itemLevel": float("nan")}, {"requiredLevel": 256},
                 {"itemGUID": ""}, {"itemGUID": "x" * 129}, {"infoComplete": 1}, {"truncated": True},
                 {"name": None}, {"type": None}, {"quality": None}, {"tooltip": []}, {"extra": 1}]
        for change in cases:
            value = loadout()
            value["slots"][4]["item"] = item(**change)
            with self.subTest(change=change), self.assertRaises(FrameError):
                validate_equipment_loadout(value)
        value = loadout()
        value["slots"][4]["item"] = item(truncated=True, tooltipComplete=False)
        self.assertEqual(validate_equipment_loadout(value), value)

    def test_attributes_and_tooltip_keep_public_bounded_values(self):
        cases = [{"stats": [{"key": "x", "value": True}]},
                 {"stats": [{"key": "x", "value": 1}, {"key": "x", "value": 2}]},
                 {"stats": [{"key": "", "value": 1}]}, {"stats": [{"key": "x", "value": 1e13}]},
                 {"stats": [{"key": "x", "value": 1, "extra": 0}]},
                 {"stats": [{"key": str(i), "value": i} for i in range(33)]},
                 {"tooltip": ["x"] * 49}, {"tooltip": [""]}, {"tooltip": ["中" * 86]}, {"tooltip": ["bad\x9f"]}]
        for change in cases:
            value = loadout()
            value["slots"][4]["item"] = item(**change)
            with self.subTest(change=change), self.assertRaises(FrameError):
                validate_equipment_loadout(value)
        value = loadout()
        value["slots"][4]["item"] = item(tooltip=["x" * 256] * 32)
        with self.assertRaisesRegex(FrameError, "8192"):
            validate_equipment_loadout(value)

    def test_bad_crc_and_wrong_game_are_never_reclassified_as_loadout_errors(self):
        frame = bytearray(encode_frame(fragments()[0]))
        frame[100] ^= 1
        with self.assertRaisesRegex(FrameError, "CRC"):
            decode_frame(bytes(frame))
        with self.assertRaisesRegex(FrameError, "另一个魔兽世界版本"):
            decode_frame(encode_frame(fragments()[0], "WCP1"), "WCF1")

    def test_invalid_gear_data_keeps_its_independent_error_on_both_capture_paths(self):
        payload = json.dumps({**fragments()[0], "id": 0}, separators=(",", ":")).encode("utf-8")
        frame = (b"WCP1" + struct.pack("<HH", len(payload), binascii.crc_hqx(payload, 0xFFFF)) + payload).ljust(512, b"\0")
        capture = FakeCapture(Image(pixels_for_frame(frame), 128, 128))
        reader = AdaptiveCaptureReader()
        config = {"x": 0, "y": 0, "cellSize": 2, "pollMs": 100, "paused": False}
        with self.assertRaises(EquipmentLoadoutError):
            reader.read(capture, config, "WCP1")
        self.assertEqual(reader.searches, 0)
        reader.geometry = Geometry((0, 0, 128, 128), 1, 1, 2, 2)
        with self.assertRaises(EquipmentLoadoutError):
            reader.read(capture, config, "WCP1")
        self.assertIsNotNone(reader.geometry)
        self.assertEqual(reader.searches, 0)


class LoadoutStateTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.state = CompanionState(clock=lambda: self.now)
        self.state.ingest(snapshot())

    def send(self, value=None, **options):
        for part in fragments(value, **options):
            self.state.ingest(part)

    def test_reordered_duplicate_parts_publish_all_slots_once_atomically(self):
        value = loadout()
        parts = fragments(value)
        self.state.ingest(parts[-1])
        self.assertIsNone(self.state.view()["equipmentLoadout"])
        for part in reversed(parts):
            self.state.ingest(part)
        self.send(value)
        view = self.state.view()
        self.assertEqual(view["equipmentLoadout"], value)
        self.assertIsNone(view["equipmentLoadoutError"])
        self.assertEqual(view["equipment"], [])
        self.assertEqual(view["equipmentComparisons"], [])
        view["equipmentLoadout"]["slots"].clear()
        self.assertEqual(len(self.state.view()["equipmentLoadout"]["slots"]), 19)

    def test_only_latest_complete_revision_replaces_previous_whole_snapshot(self):
        first, newer = loadout(), loadout(id=3, reason="equipment_changed")
        newer["slots"][4] = {"slot": 5, "state": "unknown", "item": None}
        self.send(first)
        parts = fragments(newer)
        for part in parts[:-1]:
            self.state.ingest(part)
        self.assertEqual(self.state.view()["equipmentLoadout"], first)
        self.state.ingest(parts[-1])
        self.send(loadout(id=2))
        self.send(first)
        self.assertEqual(self.state.view()["equipmentLoadout"], newer)

    def test_conflicting_pending_parts_reject_whole_revision_and_preserve_valid_one(self):
        self.send()
        first = fragments(loadout(id=2))[0]
        self.state.ingest(first)
        self.state.ingest({**first, "d": base64.b64encode(b"x" * 240).decode("ascii")})
        self.send(loadout(id=2))
        self.assertEqual(self.state.view()["equipmentLoadout"], loadout())
        self.assertIn("冲突", self.state.view()["equipmentLoadoutError"])
        self.assertIsNone(self.state.view()["error"])
        self.send(loadout(id=3))
        self.assertIsNone(self.state.view()["equipmentLoadoutError"])

    def test_completed_same_revision_conflict_cannot_replace_current_snapshot(self):
        self.send()
        conflicting = loadout(reason="refresh")
        self.send(conflicting)
        self.assertEqual(self.state.view()["equipmentLoadout"], loadout())
        self.assertIn("冲突", self.state.view()["equipmentLoadoutError"])

    def test_mismatched_envelope_body_id_session_guid_and_count_reject(self):
        for change in ({"id": 2}, {"session": "another"}, {"guid": "Other-Player"}):
            state = CompanionState()
            state.ingest(snapshot())
            for part in fragments(loadout(**change), envelope={"s": "test-session", "g": "Player-1-TEST", "id": 1}):
                state.ingest(part)
            self.assertIsNone(state.view()["equipmentLoadout"])
            self.assertIn("标识", state.view()["equipmentLoadoutError"])
        first = fragments()[0]
        self.state.ingest(first)
        self.state.ingest({**first, "n": first["n"] + 1})
        self.assertIn("冲突", self.state.view()["equipmentLoadoutError"])

    def test_wrong_session_character_and_no_character_reject_without_heartbeat_errors(self):
        for value in (loadout(session="other"), loadout(guid="Other-Player")):
            self.send(value)
            self.assertIn("其他角色", self.state.view()["equipmentLoadoutError"])
            self.assertIsNone(self.state.view()["error"])
        state = CompanionState()
        for part in fragments():
            state.ingest(part)
        self.assertIsNone(state.view()["equipmentLoadout"])
        self.assertIn("实时", state.view()["equipmentLoadoutError"])

    def test_loadout_frames_do_not_refresh_tick_events_or_frozen_state(self):
        events = self.state.event_id
        self.now = 4
        self.send()
        self.assertEqual(self.state.view()["ageSeconds"], 4)
        self.assertEqual(self.state.event_id, events)
        self.now = 6
        self.send(loadout(id=2))
        self.assertEqual(self.state.view()["status"], "stale")
        self.assertEqual(self.state.view()["equipmentLoadout"]["id"], 1)
        self.assertIn("实时", self.state.view()["equipmentLoadoutError"])

    def test_two_pending_revisions_and_total_memory_are_bounded(self):
        for identifier in (2, 3, 1, 4):
            self.state.ingest(fragments(loadout(id=identifier))[0])
        self.assertEqual(set(self.state.loadout_pending), {3, 4})
        for revision in self.state.loadout_pending.values():
            revision["parts"] = {0: b"x" * (LOADOUT_PENDING_BYTES // 2)}
        self.state.ingest(fragments(loadout(id=4))[1])
        self.assertIn("内存", self.state.view()["equipmentLoadoutError"])
        self.assertNotIn(4, self.state.loadout_pending)

    def test_absolute_partial_expiry_does_not_extend_on_duplicate(self):
        first = fragments()[0]
        self.state.ingest(first)
        for second in range(1, 1200):
            self.now = second
            self.state.ingest(snapshot(tick=second + 1))
            self.state.ingest(first)
        self.now = 1200
        view = self.state.view()
        self.assertEqual(self.state.loadout_pending, {})
        self.assertIn("超时", view["equipmentLoadoutError"])

    def test_character_account_session_demo_config_and_offline_clear_snapshots(self):
        actions = ("character", "account", "session", "demo", "config", "offline")
        for action in actions:
            state = CompanionState()
            state.ingest(snapshot())
            for part in fragments():
                state.ingest(part)
            state.ingest(fragments(loadout(id=2))[0])
            if action == "character":
                state.ingest(snapshot(guid="Other-Player", tick=2))
            elif action == "account":
                state.ingest(snapshot(account="other-account", tick=2))
            elif action == "session":
                state.ingest(snapshot(session="other-session", tick=2))
            elif action == "demo":
                state.set_demo(True)
            elif action == "config":
                state.update_config({"x": 30})
            else:
                state.ingest(snapshot(online=False, seq=2, tick=2))
            with self.subTest(action=action):
                self.assertIsNone(state.view()["equipmentLoadout"])
                self.assertEqual(state.loadout_pending, {})

    def test_maximum_body_size_and_duplicate_json_keys(self):
        raw = json.dumps(loadout(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        padded = raw + b" " * (LOADOUT_MAX_BYTES - len(raw))
        self.assertEqual(len(fragments(raw=padded)), 820)
        self.send(raw=padded)
        self.assertEqual(self.state.view()["equipmentLoadout"], loadout())
        duplicate = raw[:-1] + b',"id":2}'
        self.send(loadout(id=2), raw=duplicate, envelope={"id": 2})
        self.assertIn("JSON", self.state.view()["equipmentLoadoutError"])

    def test_independent_loadout_decode_error_recovers_with_valid_new_revision(self):
        self.state.capture_loadout_error("invalid loadout")
        self.assertEqual(self.state.view()["equipmentLoadoutError"], "invalid loadout")
        self.assertIsNone(self.state.view()["equipmentComparisonError"])
        self.assertIsNone(self.state.view()["error"])
        self.send()
        self.assertIsNone(self.state.view()["equipmentLoadoutError"])

    def test_status_http_contains_full_loadout_without_acquisition_records(self):
        server = BridgeServer(("127.0.0.1", 0), self.state)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection(*server.server_address)
            connection.request("GET", "/api/status")
            empty = json.loads(connection.getresponse().read())
            self.assertIsNone(empty["equipmentLoadout"])
            self.assertIsNone(empty["equipmentLoadoutError"])
            self.send()
            connection.request("GET", "/api/status")
            current = json.loads(connection.getresponse().read())
            self.assertEqual(current["equipmentLoadout"], loadout())
            self.assertEqual(current["equipment"], [])
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


class LoadoutLuaFixtureTests(unittest.TestCase):
    def test_retail_lua_current_equipment_fixture(self):
        self.check_fixture("WoWMapCompanion", "retail", "WCP1")

    def test_forever_lua_current_equipment_fixture(self):
        self.check_fixture("WoWForeverCompanion", "forever", "WCF1")

    def check_fixture(self, addon: str, game: str, protocol: str):
        directory = Path(__file__).resolve().parent.parent / addon / "tests" / "fixtures"
        path = directory / f"lua-{game}-gear.json"
        if not path.exists():
            self.skipTest("真实 Lua 当前装备 fixture 尚未生成")
        expected = json.loads(path.read_text(encoding="utf-8"))
        frames = path.with_suffix(".bin").read_bytes()
        self.assertEqual(len(frames) % 512, 0)
        self.assertGreater(len(frames), 512)
        state = CompanionState(game=game)
        state.ingest(snapshot(session=expected["session"], guid=expected["guid"]))
        for offset in reversed(range(0, len(frames), 512)):
            frame = frames[offset:offset + 512]
            self.assertEqual(len(frame), 512)
            state.ingest(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol))
        self.assertEqual(state.view()["equipmentLoadout"], expected)
        self.assertIsNone(state.view()["equipmentLoadoutError"])


if __name__ == "__main__":
    unittest.main()
