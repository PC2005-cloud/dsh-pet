"""Cross-language read-only bag snapshots, revision isolation, and incomplete observations."""
from __future__ import annotations

import base64
import copy
import json
import unittest
from pathlib import Path

from protocol import (FrameError, InventoryError, decode_frame, encode_frame, validate_inventory)
from state import CompanionState
from test_bridge import snapshot


def inventory(**changes):
    result = {"v": 1, "id": 1, "session": "test-session", "guid": "Player-1-TEST",
              "observedAt": 1700000000, "source": "bags", "bank": "unknown", "complete": True,
              "items": [{"itemID": 2840, "quantity": 12}, {"itemID": 12359, "quantity": 7}]}
    result.update(changes)
    return result


def fragments(record):
    data = json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode()
    count = (len(data) + 239) // 240
    return [{"v": 1, "kind": "inv", "s": record["session"], "g": record["guid"], "id": record["id"],
             "p": index + 1, "n": count, "d": base64.b64encode(data[index * 240:(index + 1) * 240]).decode()}
            for index in range(count)]


class InventoryProtocolTests(unittest.TestCase):
    def test_invalid_counts_identity_scope_and_duplicate_ids_are_rejected(self):
        for changes in [
            {"complete": 1}, {"bank": "empty"}, {"source": "bank"}, {"session": ""}, {"guid": "Player/other"},
            {"observedAt": 0}, {"items": [{"itemID": 12359, "quantity": 0}]},
            {"items": [{"itemID": 12359, "quantity": True}]},
            {"items": [{"itemID": 12359, "quantity": 2147483648}]},
            {"items": [{"itemID": 12359, "quantity": 1}, {"itemID": 12359, "quantity": 2}]},
            {"items": [{"itemID": 12359, "quantity": 1}, {"itemID": 2840, "quantity": 2}]},
            {"items": [{"itemID": index + 1, "quantity": 1} for index in range(1001)]},
        ]:
            with self.subTest(changes=changes), self.assertRaises(FrameError):
                validate_inventory(inventory(**changes))

    def test_empty_and_partial_captures_preserve_distinct_semantics(self):
        self.assertTrue(validate_inventory(inventory(items=[]))["complete"])
        self.assertFalse(validate_inventory(inventory(items=[], complete=False))["complete"])
        self.assertEqual(validate_inventory(inventory())["bank"], "unknown")

    def test_invalid_inventory_fragments_are_data_errors_not_heartbeat_corruption(self):
        for changes in [{"p": 0}, {"n": 275}, {"d": "!"}, {"s": ""}]:
            fragment = {**fragments(inventory())[0], **changes}
            with self.subTest(changes=changes), self.assertRaises(InventoryError):
                encode_frame(fragment)

    def test_real_lua_crc_frames_from_both_clients_match_the_receiver_contract(self):
        for game, addon, magic in [("retail", "WoWMapCompanion", "WCP1"), ("forever", "WoWForeverCompanion", "WCF1")]:
            with self.subTest(game=game):
                root = Path(__file__).resolve().parent.parent / addon / "tests" / "fixtures"
                record = json.loads((root / f"lua-{game}-inventory.json").read_bytes())
                stream = (root / f"lua-{game}-inventory.bin").read_bytes()
                self.assertEqual(validate_inventory(record), record)
                now = [0.0]
                state = CompanionState(clock=lambda: now[0], wall_clock=lambda: 1700000000 + now[0], game=game)
                state.ingest(snapshot(session=record["session"], guid=record["guid"]))
                for index in range(0, len(stream), 512):
                    state.ingest(decode_frame(stream[index:index + 512], magic))
                self.assertEqual(state.view()["inventory"], record)


class InventoryStateTests(unittest.TestCase):
    def setUp(self):
        self.now = [0.0]
        self.state = CompanionState(clock=lambda: self.now[0], wall_clock=lambda: 1700000000 + self.now[0])
        self.state.ingest(snapshot())

    def send(self, record=None):
        for part in fragments(inventory() if record is None else record):
            self.state.ingest(part)

    def test_publishes_only_a_complete_transfer_with_capture_and_received_time(self):
        record = inventory(items=[{"itemID": index + 1, "quantity": index + 2} for index in range(50)])
        parts = fragments(record)
        self.assertGreater(len(parts), 2)
        for part in reversed(parts[1:]):
            self.state.ingest(part)
            self.assertIsNone(self.state.view()["inventory"])
        self.state.ingest(parts[0])
        view = self.state.view()
        self.assertEqual(view["inventory"], record)
        self.assertEqual(view["inventoryReceivedAt"], "2023-11-14T22:13:20.000+00:00")
        self.assertIsNone(view["inventoryError"])
        view["inventory"]["items"][0]["quantity"] = 100
        self.assertNotEqual(view["inventory"], self.state.view()["inventory"])

    def test_partial_capture_never_becomes_a_complete_empty_inventory(self):
        self.send(inventory(complete=False, items=[]))
        self.assertEqual(self.state.view()["inventory"]["items"], [])
        self.assertFalse(self.state.view()["inventory"]["complete"])
        self.assertEqual(self.state.view()["inventory"]["bank"], "unknown")

    def test_future_and_expired_captures_do_not_supply_inventory(self):
        for observed in [1700000121, 1699998799]:
            self.setUp()
            self.send(inventory(observedAt=observed))
            self.assertIsNone(self.state.view()["inventory"])
            self.assertIn("采集时间", self.state.view()["inventoryError"])

    def test_conflicting_and_corrupt_revisions_cannot_replace_the_previous_capture(self):
        original = inventory()
        self.send(original)
        parts = fragments(inventory(id=2, items=[{"itemID": index + 1, "quantity": 1} for index in range(40)]))
        self.state.ingest(parts[0])
        self.assertIsNone(self.state.view()["inventory"])
        conflict = copy.deepcopy(parts[0])
        conflict["d"] = base64.b64encode(b"x" * 240).decode()
        self.state.ingest(conflict)
        for part in parts:
            self.state.ingest(part)
        self.assertEqual(self.state.inventory, original)
        self.assertIsNone(self.state.view()["inventory"])
        self.assertIsNotNone(self.state.view()["inventoryError"])
        self.send(inventory(id=3))
        self.assertEqual(self.state.view()["inventory"]["id"], 3)

    def test_foreign_session_and_character_cannot_supply_or_renew_counts(self):
        for changes in [{"guid": "Player-other"}, {"session": "another-session"}]:
            self.setUp()
            self.send(inventory(**changes))
            self.assertIsNone(self.state.view()["inventory"])
            self.assertIsNotNone(self.state.view()["inventoryError"])

    def test_newer_complete_revision_wins_and_replay_does_not_renew_receipt_time(self):
        self.send(inventory(id=2))
        received = self.state.view()["inventoryReceivedAt"]
        self.now[0] = 1
        self.state.ingest(snapshot(tick=2))
        self.send(inventory(id=1))
        self.send(inventory(id=2))
        self.assertEqual(self.state.view()["inventory"]["id"], 2)
        self.assertEqual(self.state.view()["inventoryReceivedAt"], received)

    def test_stale_paused_demo_and_new_character_clear_automatic_inventory(self):
        for action in [
            lambda: self.now.__setitem__(0, 6),
            lambda: self.state.update_config({"paused": True}),
            lambda: self.state.set_demo(True),
            lambda: self.state.ingest(snapshot(guid="Player-other", tick=2)),
            lambda: self.state.ingest(snapshot(session="other-session", tick=2)),
            lambda: self.state.ingest(snapshot(online=False, seq=2, tick=2)),
        ]:
            self.setUp()
            self.send()
            self.assertIsNotNone(self.state.view()["inventory"])
            action()
            self.assertIsNone(self.state.view()["inventory"])
            self.assertIsNone(self.state.view()["inventoryReceivedAt"])

    def test_expired_pending_inventory_cannot_complete_from_a_late_last_fragment(self):
        parts = fragments(inventory(items=[{"itemID": index + 1, "quantity": 1} for index in range(30)]))
        self.assertGreater(len(parts), 1)
        self.state.ingest(parts[0])
        self.now[0] = 1201
        self.state.view()
        self.assertEqual(self.state.inventory_pending, {})
        self.assertIn("超时", self.state.view()["inventoryError"])
        self.state.ingest(snapshot(tick=2))
        self.state.ingest(parts[-1])
        self.assertIsNone(self.state.view()["inventory"])

    def test_inventory_frames_cannot_advance_the_character_heartbeat(self):
        self.send()
        self.now[0] = 6
        self.send()
        self.assertEqual(self.state.view()["status"], "stale")
        self.assertIsNone(self.state.view()["inventory"])


if __name__ == "__main__":
    unittest.main()
