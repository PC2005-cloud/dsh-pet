from __future__ import annotations

import copy
import http.client
import json
import threading
import unittest
from pathlib import Path

from capture import to_bmp
from protocol import FrameError, decode_frame, decode_pixels, encode_frame, pixels_for_frame
from server import BridgeServer, allowed_origin
from state import CompanionState, validate_config


def snapshot(**changes):
    result = {"v": 3, "session": "test-session", "seq": 1, "tick": 1, "guid": "Player-1-TEST",
              "name": "旅行者", "realm": "艾泽拉斯", "level": 29, "class": "MAGE", "spec": 64,
              "faction": "Alliance", "race": "人类",
              "map": 37, "zone": "艾尔文森林", "px": None, "py": None, "combat": False, "dead": False, "online": True,
              "account": "test-account", "moneyEpoch": "test-epoch", "copper": 100000, "earned": 0, "spent": 0}
    result.update(changes)
    return result


class ProtocolTests(unittest.TestCase):
    def test_real_lua_generated_fixture(self):
        fixture = Path(__file__).resolve().parent.parent / "WoWMapCompanion" / "tests" / "fixtures" / "lua-wcp1.bin"
        if not fixture.exists():
            self.skipTest("需同级 WoWMapCompanion/tests/fixtures")
        expected = json.loads(fixture.with_suffix(".json").read_text(encoding="utf-8"))
        expected.setdefault("px", None)
        expected.setdefault("py", None)
        frame = fixture.read_bytes()
        self.assertEqual(decode_frame(frame), expected)
        self.assertEqual(decode_pixels(pixels_for_frame(frame), 128, 128, 2), expected)

    def test_utf8_round_trip_and_layout(self):
        frame = encode_frame(snapshot())
        self.assertEqual(len(frame), 512)
        self.assertEqual(frame[:4], b"WCP1")
        self.assertEqual(decode_frame(frame), snapshot())

    def test_pixels_round_trip_at_multiple_scales(self):
        frame = encode_frame(snapshot())
        for scale in (1, 2, 3, 4):
            pixels = pixels_for_frame(frame, scale)
            self.assertEqual(decode_pixels(pixels, 64 * scale, 64 * scale, scale), snapshot())

    def test_corruption_rejected(self):
        frame = bytearray(encode_frame(snapshot()))
        frame[30] ^= 1
        with self.assertRaisesRegex(FrameError, "CRC"):
            decode_frame(bytes(frame))

    def test_invalid_magic_size_schema_and_limits(self):
        for frame in (b"", bytes(512), b"WCP1" + b"\xff" * 508):
            with self.assertRaises(FrameError):
                decode_frame(frame)
        for changes in ({"level": True}, {"level": -1}, {"v": 1}, {"v": 2}, {"combat": 0}, {"guid": ""}, {"class": "<script>"}):
            with self.assertRaises(FrameError):
                encode_frame(snapshot(**changes))

    def test_faction_and_race_round_trip_including_unknown_without_inference(self):
        for protocol in ("WCP1", "WCF1"):
            for faction in ("Alliance", "Horde", "Neutral", None):
                for race in ("熊猫人", "族" * 16, None):
                    with self.subTest(protocol=protocol, faction=faction, race=race):
                        value = snapshot(faction=faction, race=race)
                        self.assertEqual(decode_frame(encode_frame(value, protocol), protocol), value)

    def test_legacy_snapshot_requires_all_components_to_be_updated(self):
        legacy = snapshot(v=2)
        del legacy["faction"]
        del legacy["race"]
        with self.assertRaisesRegex(FrameError, "v3.*插件、桥接和 AIRI"):
            encode_frame(legacy)

    def test_faction_and_race_reject_missing_invalid_types_and_control_characters(self):
        invalid_values = {
            "faction": ("horde", "部落", "Unknown", "", True, 1, [], {}),
            "race": (True, 1, [], {}, "", "x" * 49, "族" * 17, "人\x00类", "人\n类", "人\x7f类", "人\x85类", "\ud800"),
        }
        for key, values in invalid_values.items():
            missing = snapshot()
            del missing[key]
            with self.subTest(key=key, missing=True), self.assertRaises(FrameError):
                encode_frame(missing)
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(FrameError):
                    encode_frame(snapshot(**{key: value}))

    def test_copper_precision_null_and_strict_money_identity(self):
        for copper in (0, 100000000000, 9007199254740991, None):
            value = snapshot(copper=copper, earned=9007199254740991, spent=9007199254740991)
            self.assertEqual(decode_frame(encode_frame(value)), value)
        for key in ("copper", "earned", "spent"):
            for value in (True, -1, .5, 9007199254740992, "123"):
                with self.subTest(key=key, value=value), self.assertRaises(FrameError):
                    encode_frame(snapshot(**{key: value}))
            missing = snapshot()
            del missing[key]
            with self.assertRaises(FrameError):
                encode_frame(missing)
        for key in ("account", "moneyEpoch"):
            for value in ("", "x" * 41, "account@example.com", "账户", None):
                with self.subTest(key=key, value=value), self.assertRaises(FrameError):
                    encode_frame(snapshot(**{key: value}))

    def test_ambiguous_pixel_rejected(self):
        pixels = bytearray(pixels_for_frame(encode_frame(snapshot())))
        center = (128 + 1) * 4
        pixels[center:center + 3] = bytes((120, 120, 120))
        with self.assertRaisesRegex(FrameError, "模糊"):
            decode_pixels(bytes(pixels), 128, 128, 2)

    def test_bmp_header(self):
        bmp = to_bmp(bytes(16), 2, 2)
        self.assertEqual(bmp[:2], b"BM")
        self.assertEqual(len(bmp), 70)


class StateTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.state = CompanionState(clock=lambda: self.now)

    def kinds(self):
        return [e["type"] for e in self.state.view()["events"]]

    def test_instance_id_stable_within_process_unique_between_states(self):
        instance = self.state.view()["instanceId"]
        self.state.set_demo(True, "level_up")
        self.assertEqual(instance, self.state.view()["instanceId"])
        self.assertNotEqual(instance, CompanionState().view()["instanceId"])

    def test_initial_baseline_does_not_report_upgrade(self):
        self.state.ingest(snapshot(level=80))
        self.assertEqual(self.kinds(), ["connected"])
        self.assertEqual(self.state.view()["status"], "live")

    def test_change_detected_once_and_heartbeat_does_not_emit(self):
        self.state.ingest(snapshot())
        self.state.ingest(snapshot(seq=2, tick=2, level=30))
        self.state.ingest(snapshot(seq=2, tick=2, level=30))
        self.state.ingest(snapshot(seq=2, tick=3, level=30))
        self.assertEqual(self.kinds(), ["connected", "level_up"])

    def test_same_tick_business_update_accepted(self):
        self.state.ingest(snapshot())
        self.state.ingest(snapshot(seq=2, level=30))
        self.assertIn("level_up", self.kinds())

    def test_frozen_frame_becomes_stale_and_cannot_revive(self):
        self.state.ingest(snapshot())
        self.now += 6
        self.state.ingest(snapshot())
        self.assertEqual(self.state.view()["status"], "stale")
        self.state.ingest(snapshot(seq=2, level=30))
        self.assertNotIn("level_up", self.kinds())
        self.assertEqual(self.state.view()["status"], "stale")

    def test_resume_baselines_without_reporting_missed_changes(self):
        self.state.ingest(snapshot())
        self.now += 6
        self.state.ingest(snapshot(seq=2, tick=7, level=31))
        self.assertEqual(self.kinds(), ["connected", "connected"])
        self.assertEqual(self.state.view()["status"], "live")

    def test_new_character_and_session_reset_baseline(self):
        self.state.ingest(snapshot())
        self.state.ingest(snapshot(guid="Player-2-ALT", level=80))
        self.state.ingest(snapshot(guid="Player-2-ALT", session="reloaded", level=81))
        self.state.ingest(snapshot(guid="Player-2-ALT", session="reloaded", account="other-account", level=82))
        self.assertEqual(self.kinds(), ["connected", "connected", "connected", "connected"])

    def test_all_event_types_and_offline(self):
        self.state.ingest(snapshot())
        self.state.ingest(snapshot(seq=2, tick=2, zone="暴风城", map=84, dead=True, combat=True))
        self.state.ingest(snapshot(seq=3, tick=3, zone="暴风城", map=84))
        self.state.ingest(snapshot(seq=4, tick=4, online=False))
        self.assertEqual(self.kinds(), ["connected", "zone", "death", "combat_start", "revive", "combat_end", "offline"])
        self.assertEqual(self.state.view()["status"], "waiting")

    def test_event_snapshot_preserves_faction_and_race_at_event_time(self):
        self.state.ingest(snapshot(faction="Horde", race="亡灵"))
        death = snapshot(seq=2, tick=2, faction="Horde", race="亡灵", dead=True)
        self.state.ingest(death)
        death["race"] = "changed by caller"
        self.state.ingest(snapshot(seq=3, tick=3, faction=None, race=None, dead=True))
        view = self.state.view()
        self.assertIsNone(view["snapshot"]["faction"])
        self.assertIsNone(view["snapshot"]["race"])
        event = next(event for event in view["events"] if event["type"] == "death")
        self.assertEqual((event["snapshot"]["faction"], event["snapshot"]["race"]), ("Horde", "亡灵"))
        event["snapshot"]["faction"] = "Alliance"
        copied_event = next(event for event in self.state.view()["events"] if event["type"] == "death")
        self.assertEqual(copied_event["snapshot"]["faction"], "Horde")

    def test_old_sequence_does_not_replay(self):
        self.state.ingest(snapshot(seq=10))
        self.state.ingest(snapshot(seq=1, tick=2, level=30))
        self.assertEqual(self.state.view()["snapshot"]["seq"], 10)
        self.assertEqual(self.kinds(), ["connected"])

    def test_unknown_zone_does_not_emit_and_restores_same_region(self):
        for unknown in ({"map": 0, "zone": "当前位置暂不可用"},
                        {"map": 0, "zone": "艾尔文森林"},
                        {"map": 37, "zone": "当前位置暂不可用"}):
            with self.subTest(unknown=unknown):
                state = CompanionState(clock=lambda: self.now)
                state.ingest(snapshot())
                state.ingest(snapshot(seq=2, tick=2, **unknown))
                state.ingest(snapshot(seq=3, tick=3))
                self.assertEqual([event["type"] for event in state.view()["events"]], ["connected"])

    def test_unknown_zone_then_real_change_emits_once(self):
        self.state.ingest(snapshot())
        self.state.ingest(snapshot(seq=2, tick=2, map=0, zone="当前位置暂不可用"))
        self.state.ingest(snapshot(seq=3, tick=3, map=84, zone="暴风城"))
        self.state.ingest(snapshot(seq=4, tick=4, map=0, zone="当前位置暂不可用"))
        self.state.ingest(snapshot(seq=5, tick=5, map=84, zone="暴风城"))
        self.assertEqual(self.kinds(), ["connected", "zone"])

    def test_unknown_initial_zone_establishes_first_valid_baseline(self):
        self.state.ingest(snapshot(map=0, zone="当前位置暂不可用"))
        self.state.ingest(snapshot(seq=2, tick=2, map=84, zone="暴风城"))
        self.assertEqual(self.kinds(), ["connected"])

    def test_zone_baseline_resets_with_identity_session_offline_and_demo(self):
        for changed_identity in ({"guid": "Player-2-ALT"}, {"session": "new-session"}):
            with self.subTest(identity=changed_identity):
                state = CompanionState(clock=lambda: self.now)
                state.ingest(snapshot())
                state.ingest(snapshot(seq=2, tick=2, map=0, zone="当前位置暂不可用", **changed_identity))
                state.ingest(snapshot(seq=3, tick=3, map=84, zone="暴风城", **changed_identity))
                self.assertEqual([event["type"] for event in state.view()["events"]], ["connected", "connected"])
        self.state.ingest(snapshot())
        self.state.ingest(snapshot(seq=2, tick=2, online=False))
        self.assertIsNone(self.state.last_known_zone)
        self.state.ingest(snapshot(seq=3, tick=3, map=0, zone="当前位置暂不可用"))
        self.state.ingest(snapshot(seq=4, tick=4, map=84, zone="暴风城"))
        self.assertNotIn("zone", self.kinds())
        self.state.set_demo(True)
        self.state.set_demo(False)
        self.assertIsNone(self.state.last_known_zone)

    def test_pause_and_config_reset(self):
        self.state.ingest(snapshot())
        self.state.update_config({"paused": True})
        self.assertEqual(self.state.view()["status"], "paused")
        self.state.update_config({"paused": False})
        self.state.ingest(snapshot(seq=2, tick=2, level=30))
        self.assertNotIn("level_up", self.kinds())

    def test_demo_explicit_labeled_and_exit_clears_snapshot(self):
        self.state.set_demo(True, "level_up")
        self.assertEqual(self.state.view()["status"], "demo")
        self.assertTrue(all(event["demo"] for event in self.state.view()["events"]))
        self.assertEqual(self.state.view()["snapshot"]["v"], 3)
        self.assertEqual(self.state.view()["snapshot"]["faction"], "Alliance")
        self.assertEqual(self.state.view()["snapshot"]["race"], "人类")
        self.state.set_demo(False)
        self.assertIsNone(self.state.view()["snapshot"])
        self.assertEqual(self.state.view()["status"], "waiting")

    def test_event_ring_is_bounded_and_returned_data_is_detached(self):
        self.state.ingest(snapshot())
        for i in range(2, 240):
            self.state.ingest(snapshot(seq=i, tick=i, combat=i % 2 == 0))
        view = self.state.view()
        self.assertEqual(len(view["events"]), 200)
        view["snapshot"]["name"] = "modified"
        self.assertEqual(self.state.view()["snapshot"]["name"], "旅行者")

    def test_invalid_config_rejected(self):
        for value in ({"paused": 1}, {"cellSize": 0}, {"x": True}, {"pollMs": 5}, {"command": "anything"}):
            with self.assertRaises(ValueError):
                validate_config(value)

    def test_fast_capture_interval_defaults_and_inclusive_bounds(self):
        self.assertEqual(CompanionState().view()["config"]["pollMs"], 100)
        self.assertEqual(CompanionState(game="forever").view()["config"]["pollMs"], 100)
        for interval in (100, 250, 500, 5000):
            with self.subTest(interval=interval):
                self.assertEqual(validate_config({"pollMs": interval})["pollMs"], interval)
        for interval in (99, 5001, True, 100.0):
            with self.subTest(interval=interval):
                with self.assertRaises(ValueError):
                    validate_config({"pollMs": interval})


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = BridgeServer(("127.0.0.1", 0), CompanionState())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, method, path, data=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            conn.request(method, path, body=json.dumps(data) if data is not None else None, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_health_and_default_waiting(self):
        status, _, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["protocol"], "WCP1")
        self.assertEqual(json.loads(body)["version"], "2.19.0")

    def test_external_origin_and_dns_rebinding_rejected(self):
        self.assertEqual(self.request("GET", "/api/status", headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/status", headers={"Host": "evil.example:18765"})[0], 403)
        self.assertEqual(self.request("GET", "/api/status", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)

    def test_local_origin_cors_and_no_origin_native_client(self):
        status, headers, _ = self.request("GET", "/api/status", headers={"Origin": "http://localhost:5173"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:5173")
        self.assertEqual(self.request("GET", "/api/status")[0], 200)

    def test_writes_require_json_and_validate_shape(self):
        self.assertEqual(self.request("POST", "/api/config", {"x": 8})[0], 415)
        self.assertEqual(self.request("POST", "/api/config", {"x": "bad"}, {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("POST", "/api/config", {"x": 8}, {"Content-Type": "application/json"})[0], 200)

    def test_fast_capture_configuration_over_http(self):
        headers = {"Content-Type": "application/json"}
        status, _, body = self.request("POST", "/api/config", {"pollMs": 100}, headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["config"]["pollMs"], 100)
        self.assertEqual(self.request("POST", "/api/config", {"pollMs": 99}, headers)[0], 400)

    def test_demo_and_event_cursor(self):
        status, _, body = self.request("POST", "/api/demo", {"enabled": True, "action": "level_up"}, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        state = json.loads(body)
        self.assertEqual(state["status"], "demo")
        self.assertEqual((state["snapshot"]["faction"], state["snapshot"]["race"]), ("Alliance", "人类"))
        _, _, status_body = self.request("GET", "/api/status")
        self.assertEqual(json.loads(status_body)["snapshot"], state["snapshot"])
        _, _, event_body = self.request("GET", "/api/events?after=0")
        self.assertTrue(all(event["snapshot"]["faction"] == "Alliance" and event["snapshot"]["race"] == "人类"
                            for event in json.loads(event_body)["events"]))
        _, _, events = self.request("GET", "/api/events?after=" + str(state["eventCursor"]))
        self.assertEqual(json.loads(events)["events"], [])
        self.request("POST", "/api/demo", {"enabled": False}, {"Content-Type": "application/json"})

    def test_origin_validation(self):
        for origin in ("null", "https://localhost.evil.example", "https://evil@localhost", "file://", "http://localhost/path"):
            self.assertFalse(allowed_origin(origin))
        self.assertTrue(allowed_origin("airi://local"))


if __name__ == "__main__":
    unittest.main()
