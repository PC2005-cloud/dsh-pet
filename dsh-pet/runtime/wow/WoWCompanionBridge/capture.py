"""Windows screen capture with GDI; reads rendered pixels, never process memory."""

from __future__ import annotations

import ctypes
import os
import struct
from ctypes import wintypes


def enable_dpi_awareness() -> None:
    if os.name != "nt":
        return
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except (AttributeError, OSError):
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except (AttributeError, OSError):
            ctypes.windll.user32.SetProcessDPIAware()


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG), ("biYPelsPerMeter", wintypes.LONG),
                ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


class ScreenCapture:
    def __init__(self):
        if os.name != "nt":
            raise RuntimeError("真实屏幕采集仅支持 Windows；其他系统可运行显式演示模式")
        enable_dpi_awareness()
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
        self.user32.GetDC.argtypes = [wintypes.HWND]
        self.user32.GetDC.restype = wintypes.HDC
        self.user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        self.user32.ReleaseDC.restype = ctypes.c_int
        self.gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
        self.gdi32.CreateCompatibleDC.restype = wintypes.HDC
        self.gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
                                               ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE, wintypes.DWORD]
        self.gdi32.CreateDIBSection.restype = wintypes.HBITMAP
        self.gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
        self.gdi32.SelectObject.restype = wintypes.HGDIOBJ
        self.gdi32.BitBlt.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                     wintypes.HDC, ctypes.c_int, ctypes.c_int, wintypes.DWORD]
        self.gdi32.BitBlt.restype = wintypes.BOOL
        self.gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
        self.gdi32.DeleteDC.argtypes = [wintypes.HDC]

    def grab(self, x: int, y: int, width: int, height: int) -> bytes:
        screen = self.user32.GetDC(None)
        if not screen:
            raise ctypes.WinError(ctypes.get_last_error())
        memory = self.gdi32.CreateCompatibleDC(screen)
        bitmap = old = None
        try:
            info = BITMAPINFO()
            info.bmiHeader = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), width, -height, 1, 32, 0,
                                              width * height * 4, 0, 0, 0, 0)
            pointer = ctypes.c_void_p()
            bitmap = self.gdi32.CreateDIBSection(screen, ctypes.byref(info), 0, ctypes.byref(pointer), None, 0)
            if not memory or not bitmap or not pointer:
                raise ctypes.WinError(ctypes.get_last_error())
            old = self.gdi32.SelectObject(memory, bitmap)
            if not self.gdi32.BitBlt(memory, 0, 0, width, height, screen, x, y, 0x00CC0020 | 0x40000000):
                raise ctypes.WinError(ctypes.get_last_error())
            return ctypes.string_at(pointer, width * height * 4)
        finally:
            if old:
                self.gdi32.SelectObject(memory, old)
            if bitmap:
                self.gdi32.DeleteObject(bitmap)
            if memory:
                self.gdi32.DeleteDC(memory)
            self.user32.ReleaseDC(None, screen)


def to_bmp(bgra: bytes, width: int, height: int) -> bytes:
    header = struct.pack("<2sIHHI", b"BM", 54 + len(bgra), 0, 0, 54)
    dib = struct.pack("<IiiHHIIiiII", 40, width, -height, 1, 32, 0, len(bgra), 0, 0, 0, 0)
    return header + dib + bgra
