"""Map coordinates stay optional, bounded and separate from companion events."""

import copy
import http.client
import json
import threading
import unittest
from pathlib import Path

from protocol import FrameError, decode_frame, decode_pixels, encode_frame, pixels_for_frame
from server import BridgeServer
from state import CompanionState
from test_bridge import snapshot


class CoordinateProtocolTests(unittest.TestCase):
    def test_real_lua_coordinate_fixtures_decode_at_one_pixel_per_cell(self):
        root = Path(__file__).resolve().parent.parent
        for folder, protocol in (("WoWMapCompanion", "WCP1"), ("WoWForeverCompanion", "WCF1")):
            with self.subTest(protocol=protocol):
                fixture = root / folder / "tests" / "fixtures" / "lua-position.bin"
                expected = json.loads(fixture.with_suffix(".json").read_text("utf-8"))
                self.assertEqual((expected["map"], expected["px"], expected["py"]), (84, 1235, 9877))
                frame = fixture.read_bytes()
                self.assertEqual(len(frame), 512)
                self.assertEqual(decode_frame(frame, protocol), expected)
                self.assertEqual(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, protocol), expected)

    def test_old_v3_frames_without_position_remain_readable(self):
        old = snapshot()
        old.pop("px", None)
        old.pop("py", None)
        for protocol in ("WCP1", "WCF1"):
            decoded = decode_frame(encode_frame(old, protocol), protocol)
            self.assertEqual(decoded["v"], 3)
            self.assertIsNone(decoded["px"])
            self.assertIsNone(decoded["py"])

    def test_position_round_trips_at_compact_grid_size(self):
        for protocol in ("WCP1", "WCF1"):
            for px, py in ((0, 0), (10000, 10000), (0, 10000), (1234, 5678), (None, None)):
                with self.subTest(protocol=protocol, px=px, py=py):
                    value = snapshot(px=px, py=py)
                    frame = encode_frame(value, protocol)
                    self.assertEqual(len(frame), 512)
                    self.assertEqual(decode_frame(frame, protocol), value)
                    pixels = pixels_for_frame(frame, 1)
                    self.assertEqual(decode_pixels(pixels, 64, 64, 1, protocol), value)

    def test_partial_and_malformed_position_are_rejected_even_when_offline(self):
        for changes in ({}, {"online": False}, {"map": 0}):
            for key in ("px", "py"):
                for item in (True, False, -1, 10001, 1.5, float("nan"), float("inf"), "1234", [], {}):
                    with self.subTest(changes=changes, key=key, item=item), self.assertRaises(FrameError):
                        encode_frame(snapshot(px=1234, py=5678, **changes) | {key: item})
                mixed_null = snapshot(px=1234, py=5678, **changes)
                mixed_null[key] = None
                with self.assertRaises(FrameError):
                    encode_frame(mixed_null)
                for other in (None, 1234):
                    missing = snapshot(px=other, py=other, **changes)
                    missing.pop(key)
                    with self.assertRaises(FrameError):
                        encode_frame(missing)

    def test_unavailable_map_or_offline_position_is_unknown(self):
        for changes in ({"map": 0}, {"online": False}, {"map": 0, "online": False}):
            with self.subTest(changes=changes):
                decoded = decode_frame(encode_frame(snapshot(px=1234, py=5678, **changes)))
                self.assertIsNone(decoded["px"])
                self.assertIsNone(decoded["py"])


class CoordinateStateTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.state = CompanionState(clock=lambda: self.now)

    def test_walking_updates_position_without_emitting_a_companion_event(self):
        self.state.ingest(snapshot(px=1234, py=5678))
        first = self.state.view()
        self.now += 1
        self.state.ingest(snapshot(seq=2, tick=2, px=2234, py=6678))
        view = self.state.view()
        self.assertEqual((view["snapshot"]["px"], view["snapshot"]["py"]), (2234, 6678))
        self.assertEqual(view["eventCursor"], first["eventCursor"])
        self.assertEqual([event["type"] for event in view["events"]], ["connected"])
        self.assertEqual(view["ageSeconds"], 0)

    def test_stale_and_paused_views_hide_current_position_but_keep_observation_history(self):
        self.state.ingest(snapshot(px=1234, py=5678))
        event = copy.deepcopy(self.state.view()["events"][0])
        self.now += 6
        stale = self.state.view()
        self.assertEqual(stale["status"], "stale")
        self.assertIsNone(stale["snapshot"]["px"])
        self.assertIsNone(stale["snapshot"]["py"])
        self.assertEqual(stale["events"][0], event)
        # Historical data remains inside the state, not rewritten by a view.
        self.assertEqual((self.state.snapshot["px"], self.state.snapshot["py"]), (1234, 5678))
        self.state.update_config({"paused": True})
        paused = self.state.view()
        self.assertIsNone(paused["snapshot"]["px"])
        self.assertIsNone(paused["snapshot"]["py"])

    def test_unknown_position_on_a_new_map_never_reuses_previous_map_coordinates(self):
        self.state.ingest(snapshot(px=1234, py=5678))
        self.state.ingest(snapshot(seq=2, tick=2, map=84, zone="暴风城", px=None, py=None))
        view = self.state.view()
        self.assertEqual(view["snapshot"]["map"], 84)
        self.assertIsNone(view["snapshot"]["px"])
        self.assertIsNone(view["snapshot"]["py"])
        self.assertEqual([event["type"] for event in view["events"]], ["connected", "zone"])

    def test_offline_view_hides_coordinates_even_for_direct_ingestion(self):
        self.state.ingest(snapshot(px=1234, py=5678))
        self.state.ingest(snapshot(seq=2, tick=2, online=False, px=1234, py=5678))
        view = self.state.view()
        self.assertEqual(view["status"], "waiting")
        self.assertIsNone(view["snapshot"]["px"])
        self.assertIsNone(view["snapshot"]["py"])


class CoordinateHttpTests(unittest.TestCase):
    def test_status_exposes_live_coordinates_and_hides_stale_position(self):
        now = [100.0]
        state = CompanionState(clock=lambda: now[0])
        state.ingest(decode_frame(encode_frame(snapshot(px=1234, py=5678))))
        server = BridgeServer(("127.0.0.1", 0), state)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def status():
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            try:
                connection.request("GET", "/api/status")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                return json.loads(response.read())
            finally:
                connection.close()

        try:
            live = status()
            self.assertEqual((live["snapshot"]["px"], live["snapshot"]["py"]), (1234, 5678))
            now[0] += 6
            stale = status()
            self.assertEqual(stale["status"], "stale")
            self.assertIsNone(stale["snapshot"]["px"])
            self.assertIsNone(stale["snapshot"]["py"])
            self.assertEqual((stale["events"][0]["snapshot"]["px"], stale["events"][0]["snapshot"]["py"]), (1234, 5678))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
