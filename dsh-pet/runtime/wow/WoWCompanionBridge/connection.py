"""Window-bound recovery and calibration persistence. Only CRC-valid advancing heartbeats commit a position."""
from __future__ import annotations

from datetime import datetime, timezone
from contextlib import nullcontext
import json
import math
import os
from pathlib import Path
import time

from geometry import DATA_ERRORS, AdaptiveCaptureReader, Geometry
from protocol import FrameError
from window import WindowFailure, WindowPixels


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class ConnectionReader:
    def __init__(self, windows, game: str, path: Path | None = None, *, clock=time.monotonic):
        self.windows, self.game, self.path, self.clock = windows, game, path, clock
        self.reader = AdaptiveCaptureReader(clock=clock)
        self.window = None
        self.signature = None
        self.anchor = None
        self.last_heartbeat = None
        self.last_advance = None
        self.proven = False
        self.image = None
        self.fallback = None
        self.next_discovery = 0.0
        self.discovery_reason = "window-missing"
        self.diagnostic = {"phase": "locating", "reason": None, "attempts": 0, "consecutive": 0,
                           "lastFrameAt": None, "calibratedAt": None, "retrySeconds": 0, "calibration": None}

    def reset(self):
        self.reader = AdaptiveCaptureReader(clock=self.clock)
        self.window = None
        self.last_heartbeat, self.last_advance = None, None
        self.proven = False
        self.next_discovery = 0.0
        self.diagnostic.update(phase="locating", reason=None, consecutive=0, retrySeconds=0)

    def blocked(self, code: str):
        self.proven = False
        self.last_heartbeat, self.last_advance = None, None
        self.diagnostic.update(phase="blocked", reason=code, consecutive=0)

    def _load(self, basis):
        if self.path is None or not self.path.exists():
            return None
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
            if value["game"] != self.game or value["basis"] != basis:
                return None
            numbers = [*value["offset"], *value["size"], *value["sample"]]
            if (len(value["offset"]) != 2 or len(value["size"]) != 2 or len(value["sample"]) != 4
                    or not all(type(n) in (float, int) and math.isfinite(n) for n in numbers)
                    or not all(-1400 <= n <= 32768 for n in value["offset"])
                    or not all(64 <= n <= 32768 for n in value["size"])
                    or not all(0 <= n <= 18 for n in value["sample"][:2])
                    or not all(1 <= n <= 18 for n in value["sample"][2:])):
                return None
            return value
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _position(self, config, protocol, window):
        self.reader = AdaptiveCaptureReader(clock=self.clock)
        wx, wy, width, height = window.rect
        if self.anchor:
            sx, sy = width / self.anchor["size"][0], height / self.anchor["size"][1]
            ox, oy = self.anchor["offset"]
            cx, cy, px, py = self.anchor["sample"]
            rect = (round(wx + ox * sx), round(wy + oy * sy), math.ceil(64 * px * sx), math.ceil(64 * py * sy))
            self.reader.geometry = Geometry(rect, cx * sx, cy * sy, px * sx, py * sy)
            x, y = rect[:2]
        elif wx <= config["x"] < wx + width and wy <= config["y"] < wy + height:
            x, y = config["x"], config["y"]
        else:
            # The bundled addon defaults to an eight-pixel client offset. Saved fullscreen coordinates also serve as local offsets.
            x = wx + (config["x"] if 0 <= config["x"] < width else 8)
            y = wy + (config["y"] if 0 <= config["y"] < height else 8)
        x = min(max(wx, x), wx + width - 64)
        y = min(max(wy, y), wy + height - 64)
        effective = {**config, "x": x, "y": y}
        self.reader.signature = (x, y, config["cellSize"], protocol)
        self.window, self.effective = window, effective
        relative = (wx + (config["x"] if 0 <= config["x"] <= width - 64 else 8),
                    wy + (config["y"] if 0 <= config["y"] <= height - 64 else 8))
        self.fallback = relative if relative != (x, y) else None
        self.last_heartbeat, self.last_advance = None, None
        self.proven = False
        self.diagnostic.update(phase="locating", reason=None, consecutive=0,
                               attempts=self.diagnostic["attempts"] + 1)

    def _commit(self, config):
        grid = self.reader.geometry
        if grid is None:
            n = self.effective["cellSize"]
            grid = Geometry((self.effective["x"], self.effective["y"], 64 * n, 64 * n), n / 2, n / 2, n, n)
        wx, wy, width, height = self.window.rect
        value = {"game": self.game, "basis": [config["x"], config["y"], config["cellSize"]],
                 "offset": [grid.rect[0] - wx, grid.rect[1] - wy], "size": [width, height],
                 "sample": [grid.center_x, grid.center_y, grid.pitch_x, grid.pitch_y]}
        if self.path is not None and value != self.anchor:
            temporary = self.path.with_name(self.path.name + ".tmp")
            try:
                temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
                os.replace(temporary, self.path)
            except OSError:
                self.diagnostic.update(phase="error", reason="calibration-save-failed")
                raise WindowFailure("calibration-save-failed")
        self.anchor = value
        self.proven = True
        self.diagnostic.update(phase="connected", reason=None, calibratedAt=stamp(),
                               calibration={"x": grid.rect[0], "y": grid.rect[1], "pitchX": grid.pitch_x, "pitchY": grid.pitch_y})

    def read(self, capture, config, protocol, *, commit_guard=None):
        self.image = None
        basis = [config["x"], config["y"], config["cellSize"]]
        signature = (*basis, protocol)
        if signature != self.signature:
            self.signature = signature
            self.anchor = self._load(basis)
            self.reset()
        window = self.windows.inspect(self.window.handle, self.game) if self.window else None
        if window is None:
            if self.clock() < self.next_discovery:
                self.diagnostic["retrySeconds"] = round(max(0, self.next_discovery - self.clock()), 1)
                raise WindowFailure(self.discovery_reason)
            self.next_discovery = self.clock() + 1
            found = [item for item in self.windows.discover(self.game) if item.rect[2] >= 64 and item.rect[3] >= 64]
            if not found:
                self.discovery_reason = "window-missing"
                raise WindowFailure("window-missing")
            visible = [item for item in found if item.visible]
            if len(visible) > 1 or (not visible and len(found) > 1):
                self.discovery_reason = "multiple-windows"
                raise WindowFailure("multiple-windows")
            window = (visible or found)[0]
        if window.minimized:
            raise WindowFailure("window-minimized")
        if not window.visible:
            raise WindowFailure("window-hidden")
        if self.window is None or (window.identity, window.rect) != (self.window.identity, self.window.rect):
            self._position(config, protocol, window)
        pixels = WindowPixels(capture, self.windows, window, self.game)
        searched = self.clock() >= self.reader.next_search
        try:
            message = self.reader.read(pixels, self.effective, protocol)
            self.image = self.reader.image
        except DATA_ERRORS:
            self.image = self.reader.image
            raise
        except FrameError:
            self.proven = False
            self.last_heartbeat, self.last_advance = None, None
            self.diagnostic.update(phase="locating", reason="grid-unreadable", consecutive=0,
                                   retrySeconds=round(max(0, self.reader.next_search - self.clock()), 1))
            if self.fallback is not None and searched:
                previous = (self.effective["x"], self.effective["y"])
                self.effective = {**self.effective, "x": self.fallback[0], "y": self.fallback[1]}
                self.fallback = previous
                self.reader = AdaptiveCaptureReader(clock=self.clock)
                self.reader.signature = (self.effective["x"], self.effective["y"], config["cellSize"], protocol)
                self.reader.next_search = self.clock() + 2
            raise
        self.diagnostic["lastFrameAt"] = stamp()
        self.diagnostic["retrySeconds"] = 0
        if not message.get("kind"):
            heartbeat = (message["guid"], message["session"], message["tick"])
            if self.last_heartbeat is None or heartbeat[:2] != self.last_heartbeat[:2]:
                self.diagnostic["consecutive"] = 1
                self.proven = False
                self.last_advance = self.clock()
            elif heartbeat[2] > self.last_heartbeat[2]:
                self.diagnostic["consecutive"] = min(3, self.diagnostic["consecutive"] + 1)
                self.last_advance = self.clock()
            elif heartbeat[2] < self.last_heartbeat[2]:
                self.blocked("heartbeat-stale")
            self.last_heartbeat = heartbeat
        if self.last_advance is not None and self.clock() - self.last_advance > 5:
            self.blocked("heartbeat-stale")
        if not self.proven and self.diagnostic["consecutive"] >= 3:
            with commit_guard if commit_guard is not None else nullcontext():
                pixels.check()
                self._commit(config)
        if not self.proven:
            self.diagnostic["phase"] = "validating"
            return None
        return message
