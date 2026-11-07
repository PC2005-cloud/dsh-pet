"""Exercise fragmented equipment at pixel, state, and HTTP boundaries."""

from __future__ import annotations

import base64
import binascii
import http.client
import json
import struct
import threading
import unittest
from pathlib import Path

from protocol import (FrameError, decode_frame, decode_pixels, encode_frame, load_json,
                      pixels_for_frame, validate_equipment_fragment, validate_equipment_record)
from server import BridgeServer
from state import CompanionState
from test_bridge import snapshot


def record(**changes):
    result = {"v": 1, "id": 1, "session": "test-session", "guid": "Player-1-TEST", "itemID": 19019,
              "itemGUID": "Item-1-1234", "link": "|cffff8000|Hitem:19019:::::::::|h[测试长剑]|h|r",
              "name": "测试长剑", "type": "武器", "subtype": "单手剑", "equipLoc": "INVTYPE_WEAPON",
              "quality": 5, "itemLevel": 123.5, "requiredLevel": 29,
              "stats": [{"key": "ITEM_MOD_STRENGTH_SHORT", "value": 100},
                        {"key": "ITEM_MOD_HASTE_RATING_SHORT", "value": 42}],
              "tooltip": ["测试长剑", "+100 力量", "装备：触发测试效果。", "测试套装 (1/2)", "(2) 套装：测试加成。"],
              "quantity": 1, "observedAt": 1792800000, "source": "bag_added", "infoComplete": True,
              "statsComplete": True, "tooltipComplete": True, "truncated": False}
    result.update(changes)
    return result


def fragments(value=None, *, raw=None, envelope=None):
    value = value or record()
    payload = raw if raw is not None else json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    chunks = [payload[index:index + 240] for index in range(0, len(payload), 240)]
    result = []
    for index, chunk in enumerate(chunks):
        fragment = {"v": 1, "kind": "eq", "s": value["session"], "g": value["guid"], "id": value["id"],
                    "p": index + 1, "n": len(chunks), "d": base64.b64encode(chunk).decode("ascii")}
        fragment.update(envelope or {})
        result.append(fragment)
    return result


class EquipmentProtocolTests(unittest.TestCase):
    def test_real_retail_lua_fragments_decode_pixels_and_reassemble(self):
        self.check_lua_fixture("WoWMapCompanion", "retail", "WCP1")

    def test_real_forever_lua_fragments_decode_pixels_and_reassemble(self):
        self.check_lua_fixture("WoWForeverCompanion", "forever", "WCF1")

    def check_lua_fixture(self, addon_name, game, protocol):
        directory = Path(__file__).resolve().parent.parent / addon_name / "tests" / "fixtures"
        if not directory.exists():
            self.skipTest("真实 Lua 联测需要同级插件的 tests/fixtures")
        expected = json.loads((directory / "lua-equipment.json").read_text(encoding="utf-8"))
        files = sorted(directory.glob("lua-equipment-*.bin"))
        self.assertGreater(len(files), 1)
        state = CompanionState(game=game)
        state.ingest(snapshot(session=expected["session"], guid=expected["guid"]))
        for path in reversed(files):
            frame = path.read_bytes()
            part = decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol)
            state.ingest(part)
            state.ingest(part)
        self.assertEqual(state.view()["equipment"], [expected])
        self.assertEqual(state.view()["status"], "live")
        self.assertEqual([event["type"] for event in state.view()["events"]], ["connected"])
        self.assertIn("(2) 套装：提高伤害。", state.view()["equipment"][0]["tooltip"])

    def test_chinese_item_tooltip_round_trips_through_both_pixel_protocols(self):
        expected = record(tooltip=["这是可能跨越 UTF-8 分片边界的装备套装效果。" * 3] * 8)
        for protocol in ("WCP1", "WCF1"):
            parts = fragments(expected)
            decoded = []
            for part in parts:
                frame = encode_frame(part, protocol)
                self.assertEqual(len(frame), 512)
                self.assertLessEqual(len(json.dumps(part, separators=(",", ":")).encode()), 504)
                decoded.append(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol))
            joined = b"".join(base64.b64decode(part["d"]) for part in decoded)
            self.assertEqual(validate_equipment_record(load_json(joined)), expected)
            with self.assertRaisesRegex(FrameError, "另一个"):
                decode_frame(encode_frame(parts[0], protocol), "WCF1" if protocol == "WCP1" else "WCP1")

    def test_largest_fragment_envelope_still_fits_and_crc_rejects_damage(self):
        part = {"v": 1, "kind": "eq", "s": "s" * 40, "g": "g" * 48, "id": 2147483647,
                "p": 34, "n": 35, "d": base64.b64encode(b"x" * 240).decode()}
        frame = encode_frame(part)
        self.assertEqual(decode_frame(frame), part)
        bad = bytearray(frame)
        bad[100] ^= 1
        with self.assertRaisesRegex(FrameError, "CRC"):
            decode_frame(bytes(bad))

    def test_fragment_schema_rejects_invalid_indices_identities_and_base64(self):
        valid = fragments()[0]
        for change in ({"n": 36}, {"n": True}, {"p": 0}, {"p": 36}, {"id": 0}, {"v": 2},
                       {"s": ""}, {"s": "s" * 41}, {"g": "g" * 49}, {"g": "角色"},
                       {"d": "*" * 320}, {"d": ""}, {"d": "YQ=="}, {"extra": 1}):
            with self.subTest(change=change), self.assertRaises(FrameError):
                validate_equipment_fragment({**valid, **change})
        for size in (33, 240):
            with self.assertRaises(FrameError):
                validate_equipment_fragment({**valid, "p": 35, "n": 35,
                                             "d": base64.b64encode(b"x" * size).decode()})

    def test_record_schema_rejects_ambiguous_or_oversized_data(self):
        for change in ({"source": "loot_guess"}, {"quantity": True}, {"itemID": -1}, {"id": 0},
                       {"quality": 9}, {"itemLevel": float("inf")}, {"itemLevel": 10 ** 400},
                       {"infoComplete": 1}, {"observedAt": 4102444801}, {"observedAt": -1},
                       {"name": "界" * 43}, {"link": "x" * 1025},
                       {"tooltip": ["x"] * 49}, {"tooltip": ["x" * 257]}, {"stats": [{}]},
                       {"stats": [{"key": "a", "value": 0}] * 2},
                       {"stats": [{"key": "a", "value": float("nan")}]}, {"extra": True}):
            with self.subTest(change=change), self.assertRaises(FrameError):
                validate_equipment_record(record(**change))
        for key in record():
            value = record()
            del value[key]
            with self.subTest(missing=key), self.assertRaises(FrameError):
                validate_equipment_record(value)

    def test_nullable_incomplete_details_remain_honest(self):
        value = record(itemGUID=None, name=None, type=None, subtype=None, equipLoc=None, quality=None,
                       itemLevel=None, requiredLevel=None, stats=[], tooltip=[], infoComplete=False,
                       statsComplete=False, tooltipComplete=False, truncated=True)
        self.assertEqual(validate_equipment_record(value), value)
        for observed_at in (0, 4102444800):
            self.assertEqual(validate_equipment_record(record(observedAt=observed_at))["observedAt"], observed_at)

    def test_bad_json_utf8_duplicates_and_nonfinite_are_rejected_after_valid_crc(self):
        for payload in (b'{"v":1,"v":2}', b'{"v":NaN}', b'\xff', b'[' * 1500, b'{'):
            with self.subTest(payload=payload[:30]), self.assertRaises(FrameError):
                load_json(payload)
        payload = b'{"v":2,"v":2}'
        frame = (b"WCP1" + struct.pack("<HH", len(payload), binascii.crc_hqx(payload, 0xFFFF)) + payload).ljust(512, b"\0")
        with self.assertRaises(FrameError):
            decode_frame(frame)


class EquipmentStateTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.state = CompanionState(clock=lambda: self.now)
        self.state.ingest(snapshot())

    def feed(self, value=None, *, state=None, parts=None):
        target = state or self.state
        for part in parts if parts is not None else fragments(value):
            target.ingest(decode_frame(encode_frame(part), target.protocol))

    def test_out_of_order_duplicate_parts_and_message_ids_complete_once(self):
        first, second = record(), record(id=2, name="另一件装备")
        for value in (second, first):
            parts = fragments(value)
            self.feed(parts=[parts[-1], parts[-1], *reversed(parts[:-1])])
            self.feed(value)
        self.assertEqual(self.state.view()["equipment"], [second, first])
        self.assertEqual([e["type"] for e in self.state.view()["events"]], ["connected"])
        exposed = self.state.view()["equipment"]
        exposed[0]["tooltip"].clear()
        self.assertEqual(self.state.view()["equipment"][0], second)

    def test_missing_or_conflicting_parts_never_publish(self):
        parts = fragments()
        self.feed(parts=parts[:-1])
        self.assertEqual(self.state.view()["equipment"], [])
        conflict = {**parts[0], "d": base64.b64encode(b"x" * 240).decode()}
        self.feed(parts=[conflict, *parts])
        self.assertEqual(self.state.view()["equipment"], [])
        self.assertIn("冲突", self.state.view()["equipmentError"])
        self.assertEqual(self.state.view()["status"], "live")
        self.assertIsNone(self.state.view()["error"])

    def test_conflicting_count_is_rejected_until_expiry(self):
        parts = fragments()
        self.feed(parts=[parts[0], {**parts[0], "n": parts[0]["n"] + 1}, *parts])
        self.assertEqual(self.state.view()["equipment"], [])

    def test_body_identity_schema_and_bad_json_do_not_publish(self):
        invalid = [fragments(record(id=2), envelope={"id": 1}),
                   fragments(record(session="other"), envelope={"s": "test-session"}),
                   fragments(record(guid="Player-2"), envelope={"g": "Player-1-TEST"}),
                   fragments(record(name="界" * 43)), fragments(raw=b'{"v":NaN}'),
                   fragments(raw=b'\xff'), fragments(raw=b'[{]')]
        for parts in invalid:
            state = CompanionState(clock=lambda: self.now)
            state.ingest(snapshot())
            self.feed(state=state, parts=parts)
            self.assertEqual(state.view()["equipment"], [])
            self.assertIsNotNone(state.view()["equipmentError"])

    def test_equipment_never_advances_snapshot_heartbeat(self):
        before = self.state.view()
        self.now += 4
        self.feed()
        current = self.state.view()
        self.assertEqual(current["lastSeen"], before["lastSeen"])
        self.assertEqual(current["snapshot"], before["snapshot"])
        self.assertEqual(current["ageSeconds"], 4)
        self.now += 2
        self.feed(record(id=2))
        self.assertEqual(self.state.view()["status"], "stale")
        self.assertEqual(len(self.state.view()["equipment"]), 1)
        self.assertEqual(self.state.view()["ageSeconds"], 6)

    def test_pending_capacity_ttl_and_recent_list_are_bounded(self):
        for identifier in range(1, 10):
            self.feed(parts=fragments(record(id=identifier))[:1])
        self.assertEqual(len(self.state.equipment_pending), 8)
        for tick in range(2, 183):
            self.now += 1
            self.state.ingest(snapshot(tick=tick))
        self.assertEqual(len(self.state.view()["equipment"]), 0)
        self.assertEqual(len(self.state.equipment_pending), 0)
        self.feed()
        self.assertEqual(self.state.view()["equipment"], [record()])
        for identifier in range(10, 24):
            self.feed(record(id=identifier))
        self.assertEqual([item["id"] for item in self.state.view()["equipment"]], list(range(14, 24)))

    def test_live_identity_is_required_and_new_identity_discards_pending_and_complete(self):
        empty = CompanionState()
        self.feed(state=empty)
        self.assertEqual(empty.view()["equipment"], [])
        self.feed()
        pending = fragments(record(id=2))
        self.feed(parts=pending[:1])
        self.state.ingest(snapshot(guid="Player-2", session="other-session", tick=2))
        self.feed(parts=pending[1:])
        self.assertEqual(self.state.view()["equipment"], [])
        self.assertEqual(self.state.equipment_pending, {})
        self.feed(record(guid="Player-2", session="other-session"))
        self.assertEqual(len(self.state.view()["equipment"]), 1)

    def test_pause_capture_change_offline_demo_and_reconnect_clear_data(self):
        for action in (lambda: self.state.update_config({"paused": True}),
                       lambda: self.state.update_config({"x": 99}),
                       lambda: self.state.ingest(snapshot(online=False, seq=2, tick=2)),
                       lambda: self.state.set_demo(True),
                       lambda: self.state.ingest(snapshot(account="different", seq=2, tick=2))):
            self.setUp()
            self.feed()
            self.feed(parts=fragments(record(id=2))[:1])
            action()
            self.assertEqual(self.state.view()["equipment"], [])
            self.assertEqual(self.state.equipment_pending, {})
        self.setUp()
        self.feed()
        self.now += 6
        self.state.ingest(snapshot(tick=7))
        self.assertEqual(self.state.view()["equipment"], [])
        # Same-session historical acquisitions remain readable after reconnect.
        self.feed()
        self.assertEqual(self.state.view()["equipment"], [record()])

    def test_identical_ids_never_leak_across_game_processes(self):
        forever = CompanionState(game="forever", clock=lambda: self.now)
        forever.ingest(snapshot())
        for part in fragments(record(name="无限服装备")):
            forever.ingest(decode_frame(encode_frame(part, "WCF1"), "WCF1"))
        self.feed(record(name="正式服装备"))
        self.assertEqual(self.state.view()["equipment"][0]["name"], "正式服装备")
        self.assertEqual(forever.view()["equipment"][0]["name"], "无限服装备")


class EquipmentHttpTests(unittest.TestCase):
    def test_status_exposes_only_complete_records_with_existing_snapshot_and_events(self):
        state = CompanionState()
        state.ingest(snapshot())
        parts = fragments()
        for part in parts[:-1]:
            state.ingest(part)
        server = BridgeServer(("127.0.0.1", 0), state)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            connection.request("GET", "/api/status")
            first = json.loads(connection.getresponse().read())
            self.assertEqual(first["equipment"], [])
            state.ingest(parts[-1])
            connection.request("GET", "/api/status")
            result = json.loads(connection.getresponse().read())
            self.assertEqual(result["equipment"], [record()])
            self.assertEqual(result["snapshot"], snapshot())
            self.assertEqual(result["events"], first["events"])
            self.assertIsNone(result["equipmentError"])
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
