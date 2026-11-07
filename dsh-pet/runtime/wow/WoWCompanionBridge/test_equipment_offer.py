"""Exercise current equipment offers without any desktop-to-game action channel."""

import json
import unittest
from pathlib import Path

from protocol import (EquipmentOfferError, FrameError, decode_frame, decode_pixels,
                      encode_frame, pixels_for_frame, validate_equipment_offer)
from state import CompanionState
from test_bridge import snapshot


def offer(**changes):
    value = {"v": 1, "kind": "offer", "s": "test-session", "g": "Player-1-TEST",
             "id": 1, "q": 1, "st": "ready", "slot": 5, "item": 19019,
             "n": "星辰胸甲", "il": 150.5, "old": 19018, "ol": 140, "until": 1700000120}
    value.update(changes)
    return value


class EquipmentOfferTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.state = CompanionState(clock=lambda: self.now, wall_clock=lambda: 1700000000 + self.now)
        self.state.ingest(snapshot())

    def test_both_versions_round_trip_and_worst_case_fits_one_frame(self):
        value = offer(s="s" * 40, g="g" * 48, id=2147483647, q=2147483647,
                      item=2147483647, n='"' * 96, il=99999.99999999,
                      old=2147483647, ol=99998.99999999, until=4102444800, st="closed")
        for protocol in ("WCP1", "WCF1"):
            frame = encode_frame(value, protocol)
            self.assertEqual(len(frame), 512)
            self.assertEqual(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol), value)
        with self.assertRaises(FrameError):
            decode_frame(encode_frame(value, "WCP1"), "WCF1")

    def test_rejects_invalid_schema_and_non_upgrades(self):
        changes = [{"id": True}, {"q": 0}, {"s": ""}, {"g": "other user"}, {"n": ""},
                   {"n": "中" * 33}, {"n": "bad\x7f"}, {"il": float("nan")},
                   {"il": 139}, {"old": 0}, {"ol": -1}, {"slot": 20},
                   {"st": "equip"}, {"until": 0}, {"command": "execute"}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(EquipmentOfferError):
                validate_equipment_offer(offer(**change))
        for key in offer():
            value = offer()
            del value[key]
            with self.subTest(key=key), self.assertRaises(EquipmentOfferError):
                validate_equipment_offer(value)
        self.assertEqual(validate_equipment_offer(offer(old=0, ol=-1))["ol"], -1)
        # Equal item level can have better attributes. Lua and AIRI require separate comparison evidence.
        self.assertEqual(validate_equipment_offer(offer(il=140))["il"], 140)

    def test_repeated_ready_does_not_emit_events_or_refresh_heartbeat(self):
        cursor = self.state.event_id
        self.state.ingest(offer())
        self.state.ingest(offer())
        self.assertEqual(self.state.view()["equipmentOffer"], offer())
        self.assertEqual(self.state.event_id, cursor)
        self.now = 6
        self.state.ingest(offer(q=2))
        self.assertEqual(self.state.view()["status"], "stale")
        self.assertIsNone(self.state.view()["equipmentOffer"])

    def test_newer_closed_cannot_be_replaced_by_old_ready(self):
        self.state.ingest(offer())
        self.state.ingest(offer(q=2, st="closed"))
        self.state.ingest(offer())
        self.assertEqual(self.state.view()["equipmentOffer"]["st"], "closed")
        self.state.ingest(offer(q=3))
        self.assertEqual(self.state.view()["equipmentOffer"]["st"], "ready")

    def test_equal_sequence_conflict_keeps_original_and_reports_error(self):
        self.state.ingest(offer())
        self.state.ingest(offer(n="伪造的其他物品"))
        view = self.state.view()
        self.assertEqual(view["equipmentOffer"], offer())
        self.assertIsNotNone(view["equipmentOfferError"])
        self.assertIsNone(view["error"])

    def test_valid_repeat_recovers_transient_error_without_extending_lifetime(self):
        self.state.ingest(offer(until=1700000002))
        self.state.capture_offer_error("corrupted offer")
        self.now = 1
        self.state.ingest(offer(until=1700000002))
        self.assertIsNone(self.state.view()["equipmentOfferError"])
        self.now = 3
        self.assertIsNone(self.state.view()["equipmentOffer"])

    def test_wrong_identity_and_demo_never_publish_offers(self):
        self.state.ingest(offer(g="Player-OTHER"))
        self.assertIsNone(self.state.view()["equipmentOffer"])
        self.state.set_demo(True)
        self.state.ingest(offer())
        self.assertIsNone(self.state.view()["equipmentOffer"])

    def test_expired_ready_stays_expired_after_duplicate_frames(self):
        self.state.ingest(offer(until=1700000002))
        self.now = 3
        self.state.ingest(offer(until=1700000002))
        self.assertIsNone(self.state.view()["equipmentOffer"])

    def test_offer_duration_is_bounded_even_with_future_timestamp(self):
        self.state.ingest(offer(until=4102444800))
        for self.now in range(1, 122):
            self.state.ingest(snapshot(tick=self.now + 1))
            self.state.ingest(offer(until=4102444800))
        self.assertIsNone(self.state.view()["equipmentOffer"])

    def test_character_change_pause_and_offline_clear_visible_offer(self):
        self.state.ingest(offer())
        self.state.ingest(snapshot(session="next-session", tick=2))
        self.assertIsNone(self.state.view()["equipmentOffer"])
        self.state.ingest(offer(s="next-session"))
        self.state.update_config({"paused": True})
        self.assertIsNone(self.state.view()["equipmentOffer"])

    def test_result_snapshot_is_detached_and_error_is_isolated(self):
        self.state.ingest(offer())
        self.state.view()["equipmentOffer"]["n"] = "changed"
        self.assertEqual(self.state.view()["equipmentOffer"]["n"], offer()["n"])
        self.state.capture_offer_error("bad offer")
        self.assertEqual(self.state.view()["equipmentOfferError"], "bad offer")
        self.assertEqual(self.state.view()["status"], "live")

    def test_real_lua_offers_cross_pixel_protocol_and_state(self):
        for addon, game, protocol in (("WoWMapCompanion", "retail", "WCP1"), ("WoWForeverCompanion", "forever", "WCF1")):
            directory = Path(__file__).resolve().parent.parent / addon / "tests" / "fixtures"
            expected = json.loads((directory / "lua-offer.json").read_text(encoding="utf-8"))
            frame = (directory / "lua-offer.bin").read_bytes()
            decoded = decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol)
            self.assertEqual(decoded, expected)
            state = CompanionState(game=game, wall_clock=lambda: expected["until"] - 60)
            state.ingest(snapshot(session=expected["s"], guid=expected["g"]))
            state.ingest(decoded)
            self.assertEqual(state.view()["equipmentOffer"], expected)


if __name__ == "__main__":
    unittest.main()
