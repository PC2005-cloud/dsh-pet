"""Window recovery tests use real codecs and temporary calibration files, never live game windows."""
from __future__ import annotations

import json
import http.client
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from connection import ConnectionReader
from geometry import Image
from protocol import FrameError, encode_frame, pixels_for_frame
from state import CompanionState
from server import BridgeServer
from test_bridge import snapshot
from test_equipment import fragments
from test_geometry import FakeCapture
from window import GameWindow, WindowFailure, WindowPixels


class FakeWindows:
    def __init__(self):
        self.current = GameWindow(11, 22, 33, (0, 0, 400, 300))

    def discover(self, game):
        return [self.current] if self.current else []

    def inspect(self, handle, game):
        return self.current if self.current and handle == self.current.handle else None


def scene(tick, origin=(8, 8), pitch=1, protocol="WCP1"):
    raw = pixels_for_frame(encode_frame(snapshot(tick=tick), protocol), 1)
    pixels = bytearray(900 * 600 * 4)
    side = int(64 * pitch)
    for y in range(side):
        for x in range(side):
            source = (int(y / pitch) * 64 + int(x / pitch)) * 4
            target = ((y + origin[1]) * 900 + x + origin[0]) * 4
            pixels[target:target + 4] = raw[source:source + 4]
    return Image(bytes(pixels), 900, 600)


class ConnectionTests(unittest.TestCase):
    config = {"x": 8, "y": 8, "cellSize": 1, "pollMs": 100, "paused": False}

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "calibration.json"
        self.windows = FakeWindows()
        self.now = 0.0
        self.reader = ConnectionReader(self.windows, "retail", self.path, clock=lambda: self.now)
        self.capture = FakeCapture(scene(1))

    def read(self, tick, origin=(8, 8), pitch=1):
        self.capture.image = scene(tick, origin, pitch)
        self.now += .2
        return self.reader.read(self.capture, self.config, "WCP1")

    def confirm(self):
        self.assertIsNone(self.read(1))
        self.assertIsNone(self.read(2))
        self.assertEqual(self.read(3)["tick"], 3)

    def test_three_advancing_heartbeats_commit_once_without_character_data(self):
        self.assertIsNone(self.read(1))
        self.assertFalse(self.path.exists())
        self.assertIsNone(self.read(1))
        self.assertEqual(self.reader.diagnostic["consecutive"], 1)
        self.assertIsNone(self.read(2))
        self.assertEqual(self.read(3)["tick"], 3)
        saved = json.loads(self.path.read_text())
        self.assertEqual(saved["offset"], [8, 8])
        self.assertNotIn("Player", self.path.read_text())
        self.assertEqual(self.reader.diagnostic["phase"], "connected")

    def test_move_revalidates_same_client_and_never_captures_outside_it(self):
        self.confirm()
        self.windows.current = GameWindow(11, 22, 33, (100, 50, 400, 300))
        self.capture.rects.clear()
        self.assertIsNone(self.read(4, (108, 58)))
        self.assertIsNone(self.read(5, (108, 58)))
        self.assertEqual(self.read(6, (108, 58))["tick"], 6)
        self.assertEqual(self.reader.diagnostic["calibration"]["x"], 108)
        for x, y, width, height in self.capture.rects:
            self.assertGreaterEqual(x, 100)
            self.assertGreaterEqual(y, 50)
            self.assertLessEqual(x + width, 500)
            self.assertLessEqual(y + height, 350)

    def test_resize_projects_persisted_fractional_sampling(self):
        self.confirm()
        self.windows.current = GameWindow(11, 22, 33, (0, 0, 600, 450))
        self.assertIsNone(self.read(4, (12, 12), 1.5))
        self.assertIsNone(self.read(5, (12, 12), 1.5))
        self.assertEqual(self.read(6, (12, 12), 1.5)["tick"], 6)
        self.assertEqual(self.reader.diagnostic["calibration"]["pitchX"], 1.5)

    def test_restart_reuses_sampling_but_never_reuses_heartbeat_proof(self):
        self.confirm()
        self.reader = ConnectionReader(self.windows, "retail", self.path, clock=lambda: self.now)
        self.assertIsNone(self.read(4))
        self.assertEqual(self.reader.diagnostic["consecutive"], 1)
        self.assertIsNone(self.read(5))
        self.assertEqual(self.read(6)["tick"], 6)

    def test_a_retry_invalidates_an_older_pending_calibration_write(self):
        state = CompanionState()
        self.read(1)
        self.read(2)
        state.retry_connection()
        self.capture.image = scene(3)
        with self.assertRaisesRegex(FrameError, "画面读取已作废"):
            self.reader.read(self.capture, self.config, "WCP1", commit_guard=state.calibration_guard(self.config, 0))
        self.assertFalse(self.path.exists())

    def test_missing_window_discovery_is_throttled_and_retry_bypasses_backoff(self):
        self.windows.current = None
        with patch.object(self.windows, "discover", wraps=self.windows.discover) as discover:
            for _ in range(3):
                with self.assertRaisesRegex(WindowFailure, "window-missing"):
                    self.read(1)
            self.assertEqual(discover.call_count, 1)
            self.reader.reset()
            with self.assertRaises(WindowFailure):
                self.read(1)
            self.assertEqual(discover.call_count, 2)

    def test_frozen_frames_and_foreign_protocol_cannot_save_calibration(self):
        for _ in range(20):
            self.assertIsNone(self.read(1))
        self.assertFalse(self.path.exists())
        self.capture.image = scene(2, protocol="WCF1")
        with self.assertRaises(FrameError):
            self.reader.read(self.capture, self.config, "WCP1")
        self.assertFalse(self.path.exists())

    def test_minimization_and_mid_capture_window_changes_reject_pixels(self):
        self.windows.current = GameWindow(11, 22, 33, (0, 0, 400, 300), minimized=True)
        with self.assertRaisesRegex(WindowFailure, "window-minimized"):
            self.read(1)
        self.windows.current = GameWindow(11, 22, 33, (0, 0, 400, 300))
        window_pixels = WindowPixels(self.capture, self.windows, self.windows.current, "retail")
        original = self.capture.grab

        def moved(*rect):
            result = original(*rect)
            self.windows.current = GameWindow(11, 22, 99, (0, 0, 400, 300))
            return result

        self.capture.grab = moved
        with self.assertRaisesRegex(WindowFailure, "window-changed"):
            window_pixels.grab(8, 8, 64, 64)

    def test_save_failure_retains_old_calibration(self):
        self.path.write_text('{"previous": true}')
        self.read(1)
        self.read(2)
        with patch("connection.os.replace", side_effect=OSError("denied")):
            with self.assertRaisesRegex(WindowFailure, "calibration-save-failed"):
                self.read(3)
        self.assertEqual(json.loads(self.path.read_text()), {"previous": True})
        self.assertFalse(self.reader.proven)


class ReceptionTests(unittest.TestCase):
    def test_replayed_fragment_counts_cannot_rewrite_completed_progress(self):
        state = CompanionState()
        state.ingest(snapshot())
        parts = fragments()
        for part in parts:
            state.ingest(part)
        state.ingest({**parts[0], "n": len(parts) + 1})
        row = state.view()["transfers"][0]
        self.assertEqual((row["received"], row["total"]), (len(parts), len(parts)))

    def test_reconnect_http_validates_the_command_and_keeps_manual_configuration(self):
        state = CompanionState()
        server = BridgeServer(("127.0.0.1", 0), state)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            client = http.client.HTTPConnection("127.0.0.1", server.server_address[1])
            client.request("POST", "/api/reconnect", '{"unexpected":1}', {"Content-Type": "application/json"})
            response = client.getresponse()
            self.assertEqual(response.status, 400)
            response.read()
            client.request("POST", "/api/reconnect", '{}', {"Content-Type": "application/json"})
            response = client.getresponse()
            result = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(result["connection"]["phase"], "locating")
            self.assertEqual(result["config"]["x"], 8)
            self.assertEqual(state.capture_revision, 1)
            client.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def test_unique_fragment_progress_timeout_and_retry_do_not_refresh_heartbeat(self):
        now = [0.0]
        state = CompanionState(clock=lambda: now[0])
        state.ingest(snapshot())
        parts = fragments()
        state.ingest(parts[0])
        state.ingest(parts[0])
        row = state.view()["transfers"][0]
        self.assertEqual((row["received"], row["total"], row["phase"]), (1, len(parts), "receiving"))
        now[0] = 181
        self.assertEqual(state.view()["transfers"][0]["phase"], "timed-out")
        self.assertEqual(state.view()["status"], "stale")
        revision = state.capture_revision
        state.retry_connection()
        self.assertEqual(state.capture_revision, revision + 1)
        self.assertEqual(state.view()["transfers"], [])
        self.assertEqual(state.view()["connection"]["phase"], "locating")

    def test_completed_records_survive_reconnect_and_remain_distinct_from_freshness(self):
        state = CompanionState()
        state.ingest(snapshot())
        for part in fragments():
            state.ingest(part)
        self.assertEqual(state.view()["transfers"][0]["phase"], "complete")
        before = state.view()["equipment"]
        state.retry_connection()
        self.assertEqual(state.view()["equipment"], before)
        self.assertEqual(state.view()["status"], "waiting")
