"""Windows input for one verified foreground Warcraft window. No shell commands or macro execution."""
from __future__ import annotations

import ctypes as c
from ctypes import wintypes as w
import os
import re

from macro_import import ImportFailure


class Keyboard(c.Structure):
    _fields_ = [("vk", w.WORD), ("scan", w.WORD), ("flags", w.DWORD), ("time", w.DWORD), ("extra", c.c_size_t)]


class Mouse(c.Structure):
    _fields_ = [("x", w.LONG), ("y", w.LONG), ("data", w.DWORD), ("flags", w.DWORD), ("time", w.DWORD), ("extra", c.c_size_t)]


class InputUnion(c.Union):
    _fields_ = [("keyboard", Keyboard), ("mouse", Mouse)]


class Input(c.Structure):
    _fields_ = [("kind", w.DWORD), ("value", InputUnion)]


class WindowsMacroInput:
    def __init__(self, window):
        if os.name != "nt":
            raise ImportFailure("windows-required")
        self.window = window
        self.handle = int(window["handle"])
        self.user = c.WinDLL("user32", use_last_error=True)
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        signatures = [
            (self.user, "GetForegroundWindow", [], w.HWND),
            (self.user, "SetForegroundWindow", [w.HWND], w.BOOL),
            (self.user, "IsWindowVisible", [w.HWND], w.BOOL),
            (self.user, "IsIconic", [w.HWND], w.BOOL),
            (self.user, "GetWindowThreadProcessId", [w.HWND, c.POINTER(w.DWORD)], w.DWORD),
            (self.user, "GetAsyncKeyState", [c.c_int], c.c_short),
            (self.user, "SendInput", [w.UINT, c.POINTER(Input), c.c_int], w.UINT),
            (self.user, "OpenClipboard", [w.HWND], w.BOOL),
            (self.user, "EmptyClipboard", [], w.BOOL),
            (self.user, "CloseClipboard", [], w.BOOL),
            (self.user, "SetClipboardData", [w.UINT, w.HANDLE], w.HANDLE),
            (self.kernel, "GlobalAlloc", [w.UINT, c.c_size_t], w.HANDLE),
            (self.kernel, "GlobalLock", [w.HANDLE], c.c_void_p),
            (self.kernel, "GlobalUnlock", [w.HANDLE], w.BOOL),
            (self.kernel, "GlobalFree", [w.HANDLE], w.HANDLE),
            (self.kernel, "OpenProcess", [w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
            (self.kernel, "QueryFullProcessImageNameW", [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)], w.BOOL),
            (self.kernel, "GetProcessTimes", [w.HANDLE, c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME), c.POINTER(w.FILETIME)], w.BOOL),
            (self.kernel, "CloseHandle", [w.HANDLE], w.BOOL),
            (self.kernel, "CreateMutexW", [c.c_void_p, w.BOOL, w.LPCWSTR], w.HANDLE),
        ]
        for library, name, args, result in signatures:
            function = getattr(library, name)
            function.argtypes, function.restype = args, result
        self.mutex = self.kernel.CreateMutexW(None, False, "Local\\WoWCompanionMacroImport")
        if not self.mutex or c.get_last_error() == 183:
            if self.mutex:
                self.kernel.CloseHandle(self.mutex)
            self.mutex = None
            raise ImportFailure("busy")

    def check(self, foreground=True):
        pid = w.DWORD()
        self.user.GetWindowThreadProcessId(self.handle, c.byref(pid))
        if pid.value != self.window["processId"] or not self.user.IsWindowVisible(self.handle) or self.user.IsIconic(self.handle):
            raise ImportFailure("window-changed")
        process = self.kernel.OpenProcess(0x1000, False, pid.value)
        if not process:
            raise ImportFailure("window-changed")
        try:
            path, size = c.create_unicode_buffer(32768), w.DWORD(32768)
            if not self.kernel.QueryFullProcessImageNameW(process, 0, path, c.byref(size)) or os.path.normcase(path.value) != os.path.normcase(self.window["path"]):
                raise ImportFailure("window-changed")
            created, exited, kernel, user = w.FILETIME(), w.FILETIME(), w.FILETIME(), w.FILETIME()
            if not self.kernel.GetProcessTimes(process, c.byref(created), c.byref(exited), c.byref(kernel), c.byref(user)):
                raise ImportFailure("window-changed")
            ticks = (created.dwHighDateTime << 32) + created.dwLowDateTime + 504911232000000000
            if str(ticks) != self.window["processStartedAt"]:
                raise ImportFailure("window-changed")
        finally:
            self.kernel.CloseHandle(process)
        if foreground and self.user.GetForegroundWindow() != self.handle:
            raise ImportFailure("focus-lost")
        if self.user.GetAsyncKeyState(0x1B) & 0x8000:
            raise ImportFailure("cancelled")

    def activate(self):
        self.check(False)
        self.user.SetForegroundWindow(self.handle)
        # Windows can deny activation or finish it asynchronously. The workflow waits before sending any input.

    def copy(self, text):
        self.check(False)
        data = (text + "\0").encode("utf-16-le")
        allocation = self.kernel.GlobalAlloc(0x0042, len(data))
        if not allocation:
            raise ImportFailure("clipboard-failed")
        try:
            pointer = self.kernel.GlobalLock(allocation)
            if not pointer:
                raise ImportFailure("clipboard-failed")
            c.memmove(pointer, data, len(data))
            self.kernel.GlobalUnlock(allocation)
            # A real window owner is required after EmptyClipboard for SetClipboardData.
            if not self.user.OpenClipboard(self.handle):
                raise ImportFailure("clipboard-busy")
            try:
                if not self.user.EmptyClipboard() or not self.user.SetClipboardData(13, allocation):
                    raise ImportFailure("clipboard-failed")
                allocation = None
            finally:
                self.user.CloseClipboard()
        finally:
            if allocation:
                self.kernel.GlobalFree(allocation)

    def send(self, events):
        self.check()
        if any(self.user.GetAsyncKeyState(key) & 0x8000 for key in (0x10, 0x11, 0x12, 0x5B, 0x5C)):
            raise ImportFailure("modifier-held")
        array = (Input * len(events))(*[Input(1, InputUnion(keyboard=Keyboard(vk, scan, flags, 0, 0))) for vk, scan, flags in events])
        if self.user.SendInput(len(array), array, c.sizeof(Input)) != len(array):
            # A partial chord must not leave Control held down.
            releases = (Input * 1)(Input(1, InputUnion(keyboard=Keyboard(0x11, 0, 2, 0, 0))))
            self.user.SendInput(1, releases, c.sizeof(Input))
            raise ImportFailure("input-failed")

    def press(self, action):
        if action == "enter":
            self.send([(0x0D, 0, 0), (0x0D, 0, 2)])
        elif action in ("paste", "save"):
            key = 0x56 if action == "paste" else 0x0D
            self.send([(0x11, 0, 0), (key, 0, 0), (key, 0, 2), (0x11, 0, 2)])
        else:
            raise ImportFailure("invalid-action")

    def command(self, text):
        if not re.fullmatch(r"/import-marco [0-9a-f]{32}", text):
            raise ImportFailure("invalid-command")
        events = []
        for char in text:
            events.extend([(0, ord(char), 4), (0, ord(char), 6)])
        events.extend([(0x0D, 0, 0), (0x0D, 0, 2)])
        self.send(events)

    def close(self):
        if self.mutex:
            self.kernel.CloseHandle(self.mutex)
            self.mutex = None
