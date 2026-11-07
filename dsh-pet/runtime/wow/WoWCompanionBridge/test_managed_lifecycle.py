"""Check that the real managed bridge exits when its parent pipe closes."""
from __future__ import annotations

import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


class ManagedLifecycleTests(unittest.TestCase):
    def test_parent_pipe_closure_stops_the_http_server(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix="wow-managed-bridge-") as directory:
            child = subprocess.Popen(
                [sys.executable, "-u", str(Path(__file__).with_name("server.py")),
                 "--port", str(port), "--config", str(Path(directory) / "config.json"), "--managed-stdin"],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            try:
                deadline = time.monotonic() + 8
                while True:
                    try:
                        with urlopen(f"http://127.0.0.1:{port}/health", timeout=.5) as response:
                            self.assertEqual(response.status, 200)
                        break
                    except (URLError, TimeoutError):
                        if child.poll() is not None or time.monotonic() >= deadline:
                            self.fail("Managed bridge did not become ready")
                        time.sleep(.05)
                self.assertIsNone(child.poll())
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
