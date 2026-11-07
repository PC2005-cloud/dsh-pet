"""Validate optional scene observations without changing the compact frame or event history."""

import json
import unittest
from pathlib import Path

from protocol import FrameError, decode_frame, decode_pixels, encode_frame, pixels_for_frame
from state import CompanionState
from test_bridge import snapshot


class InstanceProtocolTests(unittest.TestCase):
    def test_v3_without_scene_data_does_not_imply_outdoor_or_add_fields(self):
        value = snapshot()
        for magic in ("WCP1", "WCF1"):
            decoded = decode_frame(encode_frame(value, magic), magic)
            self.assertNotIn("instanceType", decoded)
            self.assertNotIn("instanceID", decoded)

    def test_types_round_trip_in_the_one_pixel_grid(self):
        for magic in ("WCP1", "WCF1"):
            for kind in ("none", "party", "raid", "pvp", "arena", "scenario", "unknown"):
                with self.subTest(magic=magic, kind=kind):
                    value = snapshot(instanceType=kind, instanceID=None if kind in ("none", "unknown") else 36)
                    frame = encode_frame(value, magic)
                    self.assertEqual(len(frame), 512)
                    self.assertEqual(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, magic), value)

    def test_type_observation_does_not_require_a_known_instance_id(self):
        value = snapshot(instanceType="party")
        self.assertEqual(decode_frame(encode_frame(value)), value)

    def test_invalid_types_are_rejected(self):
        for kind in (None, True, False, 1, "", "dungeon", "PVP", [], {}):
            with self.subTest(kind=kind), self.assertRaises(FrameError):
                encode_frame(snapshot(instanceType=kind))

    def test_invalid_ids_are_rejected_before_offline_normalization(self):
        for online in (True, False):
            for instance_id in (0, -1, 1.5, 2147483648, True, False, "36", [], {}, float("inf"), float("nan")):
                with self.subTest(online=online, id=instance_id), self.assertRaises(FrameError):
                    encode_frame(snapshot(instanceType="party", instanceID=instance_id, online=online))

    def test_positive_ids_cannot_claim_outdoor_unknown_or_missing_type(self):
        for kind in ("none", "unknown", None):
            value = snapshot(instanceID=36)
            if kind is not None:
                value["instanceType"] = kind
            with self.subTest(kind=kind), self.assertRaises(FrameError):
                encode_frame(value)

    def test_instance_id_boundaries_are_not_map_ids(self):
        for instance_id in (1, 2147483647):
            value = snapshot(map=84, instanceType="raid", instanceID=instance_id)
            self.assertEqual(decode_frame(encode_frame(value))["instanceID"], instance_id)

    def test_offline_observations_clear_scene_without_retaining_id(self):
        value = snapshot(instanceType="pvp", instanceID=529, online=False)
        decoded = decode_frame(encode_frame(value))
        self.assertEqual(decoded["instanceType"], "unknown")
        self.assertIsNone(decoded["instanceID"])

    def test_stale_and_paused_current_scene_is_unknown_while_history_remains(self):
        clock = [10.0]
        state = CompanionState(clock=lambda: clock[0])
        state.ingest(decode_frame(encode_frame(snapshot(instanceType="raid", instanceID=409))))
        historical = state.view()["events"][0]
        self.assertEqual(state.view()["snapshot"]["instanceID"], 409)
        clock[0] += 6
        stale = state.view()
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["snapshot"]["instanceType"], "unknown")
        self.assertIsNone(stale["snapshot"]["instanceID"])
        self.assertEqual(stale["events"][0], historical)
        state.update_config({"paused": True})
        self.assertEqual(state.view()["snapshot"]["instanceType"], "unknown")

    def test_scene_changes_are_current_observations_without_duplicate_zone_events(self):
        state = CompanionState()
        state.ingest(decode_frame(encode_frame(snapshot(instanceType="party", instanceID=36))))
        state.ingest(decode_frame(encode_frame(snapshot(seq=2, tick=2, instanceType="pvp", instanceID=529))))
        view = state.view()
        self.assertEqual(view["snapshot"]["instanceType"], "pvp")
        self.assertEqual(view["snapshot"]["instanceID"], 529)
        self.assertEqual([event["type"] for event in view["events"]], ["connected"])

    def test_real_lua_scene_frames_decode_for_both_game_protocols(self):
        root = Path(__file__).resolve().parent.parent
        for folder, magic in (("WoWMapCompanion", "WCP1"), ("WoWForeverCompanion", "WCF1")):
            fixture = root / folder / "tests" / "fixtures" / "lua-instance.bin"
            expected = json.loads(fixture.with_suffix(".json").read_text("utf-8"))
            self.assertEqual(expected["instanceType"], "pvp")
            self.assertEqual(expected["instanceID"], 529)
            self.assertEqual(decode_frame(fixture.read_bytes(), magic), expected)
            self.assertEqual(decode_pixels(pixels_for_frame(fixture.read_bytes(), 1), 64, 64, 1, magic), expected)
