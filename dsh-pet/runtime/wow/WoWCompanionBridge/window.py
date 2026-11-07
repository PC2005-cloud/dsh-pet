"""Read-only Windows client discovery, bound to executable paths and process lifetimes."""
from __future__ import annotations

import ctypes as c
from ctypes import wintypes as w
from dataclasses import dataclass
import ntpath
import os


class WindowFailure(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class GameWindow:
    handle: int
    process: int
    started: int
    rect: tuple[int, int, int, int]
    minimized: bool = False
    visible: bool = True

    @property
    def identity(self):
        return self.handle, self.process, self.started


class WindowsGameWindows:
    def __init__(self):
        if os.name != "nt":
            raise WindowFailure("unsupported-platform")
        self.user = c.WinDLL("user32", use_last_error=True)
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        self.callback = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
        signatures = [
            (self.user, "EnumWindows", [self.callback, w.LPARAM], w.BOOL),
            (self.user, "GetWindowThreadProcessId", [w.HWND, c.POINTER(w.DWORD)], w.DWORD),
            (self.user, "IsWindowVisible", [w.HWND], w.BOOL),
            (self.user, "IsIconic", [w.HWND], w.BOOL),
            (self.user, "GetClientRect", [w.HWND, c.POINTER(w.RECT)], w.BOOL),
            (self.user, "ClientToScreen", [w.HWND, c.POINTER(w.POINT)], w.BOOL),
            (self.kernel, "OpenProcess", [w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
            (self.kernel, "CloseHandle", [w.HANDLE], w.BOOL),
            (self.kernel, "QueryFullProcessImageNameW", [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)], w.BOOL),
            (self.kernel, "GetProcessTimes", [w.HANDLE, *([c.POINTER(w.FILETIME)] * 4)], w.BOOL),
        ]
        for library, name, arguments, result in signatures:
            function = getattr(library, name)
            function.argtypes, function.restype = arguments, result

    def inspect(self, handle: int, game: str) -> GameWindow | None:
        pid = w.DWORD()
        if not self.user.GetWindowThreadProcessId(handle, c.byref(pid)):
            return None
        process = self.kernel.OpenProcess(0x1000, False, pid.value)
        if not process:
            return None
        try:
            path, size = c.create_unicode_buffer(32768), w.DWORD(32768)
            if not self.kernel.QueryFullProcessImageNameW(process, 0, path, c.byref(size)):
                return None
            folder = "_retail_" if game == "retail" else "_forever_"
            if (ntpath.basename(path.value).lower() not in ("wow.exe", "wow-arm64.exe")
                    or ntpath.basename(ntpath.dirname(path.value)).lower() != folder):
                return None
            created, exited, kernel, user = w.FILETIME(), w.FILETIME(), w.FILETIME(), w.FILETIME()
            if not self.kernel.GetProcessTimes(process, c.byref(created), c.byref(exited), c.byref(kernel), c.byref(user)):
                raise WindowFailure("access-denied")
            rect, point = w.RECT(), w.POINT()
            if not self.user.GetClientRect(handle, c.byref(rect)) or not self.user.ClientToScreen(handle, c.byref(point)):
                raise WindowFailure("window-changed")
            return GameWindow(int(handle), pid.value, (created.dwHighDateTime << 32) | created.dwLowDateTime,
                              (point.x, point.y, rect.right, rect.bottom),
                              bool(self.user.IsIconic(handle)), bool(self.user.IsWindowVisible(handle)))
        finally:
            self.kernel.CloseHandle(process)

    def discover(self, game: str) -> list[GameWindow]:
        found, failures = [], []

        def visit(handle, _parameter):
            try:
                window = self.inspect(handle, game)
                if window is not None:
                    found.append(window)
            except WindowFailure as error:
                failures.append(error)
            return True

        if not self.user.EnumWindows(self.callback(visit), 0):
            raise WindowFailure("window-query-failed")
        if not found and failures:
            raise failures[0]
        return found


class WindowPixels:
    """Capture only the verified client intersection. Padding outside that client is synthetic black, never desktop pixels."""

    def __init__(self, capture, windows, window: GameWindow, game: str):
        self.capture, self.windows, self.window, self.game = capture, windows, window, game

    def check(self):
        current = self.windows.inspect(self.window.handle, self.game)
        if current is None or current.identity != self.window.identity or current.rect != self.window.rect:
            raise WindowFailure("window-changed")
        if current.minimized:
            raise WindowFailure("window-minimized")
        if not current.visible:
            raise WindowFailure("window-hidden")

    def grab(self, x: int, y: int, width: int, height: int) -> bytes:
        self.check()
        if not 1 <= width <= 1400 or not 1 <= height <= 1400:
            raise WindowFailure("capture-failed")
        wx, wy, ww, wh = self.window.rect
        left, top, right, bottom = max(x, wx), max(y, wy), min(x + width, wx + ww), min(y + height, wy + wh)
        if left >= right or top >= bottom:
            raise WindowFailure("grid-unreadable")
        pixels = self.capture.grab(left, top, right - left, bottom - top)
        self.check()
        result = bytearray(b"\0\0\0\xff" * (width * height))
        for row in range(bottom - top):
            offset = ((top - y + row) * width + left - x) * 4
            result[offset:offset + (right - left) * 4] = pixels[row * (right - left) * 4:(row + 1) * (right - left) * 4]
        return bytes(result)
