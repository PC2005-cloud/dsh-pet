"""Check game isolation at the frame, HTTP, and managed-process boundaries."""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from protocol import FrameError, decode_frame, decode_pixels, encode_frame, pixels_for_frame
from server import BridgeServer
from state import CompanionState
from test_bridge import snapshot


class GameProtocolTests(unittest.TestCase):
    def test_profiles_reject_each_others_pixels(self):
        for protocol, other in (("WCP1", "WCF1"), ("WCF1", "WCP1")):
            frame = encode_frame(snapshot(), protocol)
            pixels = pixels_for_frame(frame, 1)
            self.assertEqual(decode_pixels(pixels, 64, 64, 1, protocol), snapshot())
            with self.assertRaisesRegex(FrameError, "另一个魔兽世界版本"):
                decode_pixels(pixels, 64, 64, 1, other)
        with self.assertRaises(ValueError):
            encode_frame(snapshot(), "OTHER")

    def test_forever_lua_fixture_at_native_cell_size(self):
        fixture = Path(__file__).resolve().parent.parent / "WoWForeverCompanion/tests/fixtures/lua-wcf1.bin"
        expected = json.loads(fixture.with_suffix(".json").read_text(encoding="utf-8"))
        expected.setdefault("px", None)
        expected.setdefault("py", None)
        frame = fixture.read_bytes()
        self.assertEqual(decode_frame(frame, "WCF1"), expected)
        self.assertEqual(decode_pixels(pixels_for_frame(frame, 1), 64, 64, 1, "WCF1"), expected)

    def test_same_account_and_guid_keep_separate_state_and_defaults(self):
        retail, forever = CompanionState(), CompanionState(game="forever")
        self.assertEqual((retail.config["cellSize"], forever.config["cellSize"]), (1, 1))
        for state in (retail, forever):
            state.ingest(snapshot())
        forever.ingest(snapshot(seq=2, tick=2, level=30, earned=1000))
        self.assertEqual(retail.view()["snapshot"], snapshot())
        self.assertEqual(len(retail.view()["events"]), 1)
        self.assertEqual(len(forever.view()["events"]), 2)
        forever.update_config({"x": 90})
        forever.set_demo(True)
        self.assertEqual(retail.config["x"], 8)
        self.assertEqual(retail.view()["source"], "screen")
        self.assertEqual(forever.view()["snapshot"]["realm"], "无限服演示")
        with self.assertRaises(ValueError):
            CompanionState(game="unknown")


class GameHttpTests(unittest.TestCase):
    def test_two_servers_persist_capture_settings_and_demo_separately(self):
        servers = []
        with tempfile.TemporaryDirectory(prefix="wow-profiles-") as directory:
            try:
                for game in ("retail", "forever"):
                    path = Path(directory) / f"{game}.json"
                    server = BridgeServer(("127.0.0.1", 0), CompanionState(game=game), path)
                    thread = threading.Thread(target=server.serve_forever, daemon=True)
                    thread.start()
                    servers.append((game, server, thread, path))

                def call(server, path, body=None):
                    request = Request(f"http://127.0.0.1:{server.server_port}{path}",
                                      data=json.dumps(body).encode() if body is not None else None,
                                      headers={"Content-Type": "application/json"})
                    with urlopen(request, timeout=3) as response:
                        return json.load(response)

                for game, server, _, path in servers:
                    health = call(server, "/health")
                    self.assertEqual(health["game"], game)
                    self.assertEqual(health["protocol"], "WCP1" if game == "retail" else "WCF1")
                    x = 20 if game == "retail" else 200
                    call(server, "/api/config", {"x": x})
                    self.assertEqual(json.loads(path.read_text())["x"], x)
                    with self.assertRaises(HTTPError) as error:
                        call(server, "/api/config", {"game": "retail"})
                    self.assertEqual(error.exception.code, 400)
                retail, forever = servers[0][1], servers[1][1]
                call(forever, "/api/demo", {"enabled": True, "action": "level_up"})
                self.assertEqual(call(retail, "/api/status")["status"], "waiting")
                self.assertEqual(call(forever, "/api/status")["status"], "demo")
                self.assertEqual(call(retail, "/api/status")["config"]["x"], 20)
            finally:
                for _, server, thread, _ in servers:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)

    def test_managed_forever_cli_selects_protocol_and_exits_on_parent_eof(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix="wow-forever-cli-") as directory:
            child = subprocess.Popen(
                [sys.executable, "-u", str(Path(__file__).with_name("server.py")),
                 "--game", "forever", "--port", str(port), "--config", str(Path(directory) / "config.json"),
                 "--demo", "--managed-stdin"], stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            try:
                deadline = time.monotonic() + 8
                while True:
                    try:
                        with urlopen(f"http://127.0.0.1:{port}/api/status", timeout=.5) as response:
                            state = json.load(response)
                        break
                    except (URLError, TimeoutError):
                        if child.poll() is not None or time.monotonic() >= deadline:
                            self.fail("Forever bridge did not start")
                        time.sleep(.05)
                self.assertEqual((state["game"], state["protocol"], state["config"]["cellSize"]), ("forever", "WCF1", 1))
                child.stdin.close()
                self.assertEqual(child.wait(timeout=5), 0)
                with self.assertRaises(URLError):
                    urlopen(f"http://127.0.0.1:{port}/health", timeout=.5)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                child.stdin.close()
                child.stderr.close()


if __name__ == "__main__":
    unittest.main()
