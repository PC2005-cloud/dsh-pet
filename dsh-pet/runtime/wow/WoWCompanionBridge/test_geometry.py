from __future__ import annotations

import math
import time
import unittest

from geometry import AdaptiveCaptureReader, Geometry, Image, decode_geometry, find_geometry
from protocol import FrameError, encode_frame, pixels_for_frame
from test_bridge import snapshot
from state import CompanionState


def stretched(frame: bytes, *, origin=(10.3, 41.2), scale=(1.289, 1.15)) -> Image:
    """Synthetic bilinear window stretch, with independent axis scales."""
    source = pixels_for_frame(frame, 2)
    result = bytearray(256 * 256 * 4)
    for y in range(256):
        source_y = (y - origin[1]) / scale[1]
        iy = math.floor(source_y)
        fy = source_y - iy
        for x in range(256):
            source_x = (x - origin[0]) / scale[0]
            ix = math.floor(source_x)
            fx = source_x - ix
            def value(xx, yy):
                return source[(yy * 128 + xx) * 4] if 0 <= xx < 128 and 0 <= yy < 128 else 0
            level = round((value(ix, iy) * (1 - fx) + value(ix + 1, iy) * fx) * (1 - fy)
                          + (value(ix, iy + 1) * (1 - fx) + value(ix + 1, iy + 1) * fx) * fy)
            pos = (y * 256 + x) * 4
            result[pos:pos + 4] = bytes((level, level, level, 255))
    return Image(bytes(result), 256, 256)


class FakeCapture:
    def __init__(self, image):
        self.image = image
        self.rects = []

    def grab(self, x, y, width, height):
        self.rects.append((x, y, width, height))
        rows = []
        for yy in range(y, y + height):
            row = bytearray()
            for xx in range(x, x + width):
                if 0 <= xx < self.image.width and 0 <= yy < self.image.height:
                    pos = (yy * self.image.width + xx) * 4
                    row.extend(self.image.pixels[pos:pos + 4])
                else:
                    row.extend(b"\0\0\0\xff")
            rows.append(bytes(row))
        return b"".join(rows)


class GeometryTests(unittest.TestCase):
    config = {"x": 8, "y": 32, "cellSize": 2, "pollMs": 100, "paused": False}

    @classmethod
    def setUpClass(cls):
        cls.frame = encode_frame(snapshot())
        cls.stretch = stretched(cls.frame)

    def test_integer_fast_path_is_unchanged(self):
        image = Image(pixels_for_frame(self.frame), 128, 128)
        capture = FakeCapture(image)
        reader = AdaptiveCaptureReader()
        result = reader.read(capture, {**self.config, "x": 0, "y": 0}, "WCP1")
        self.assertEqual(result, snapshot())
        self.assertIsNone(reader.geometry)
        self.assertEqual(reader.searches, 0)
        self.assertEqual(capture.rects, [(0, 0, 128, 128)])

    def test_nonuniform_fractional_stretch_is_recovered(self):
        capture = FakeCapture(self.stretch)
        reader = AdaptiveCaptureReader()
        started = time.perf_counter()
        self.assertEqual(reader.read(capture, self.config, "WCP1"), snapshot())
        elapsed = time.perf_counter() - started
        self.assertIsNotNone(reader.geometry)
        self.assertGreater(abs(reader.geometry.pitch_x - reader.geometry.pitch_y), .1)
        self.assertEqual(reader.searches, 1)
        self.assertLess(elapsed, 2.5)
        self.assertTrue(all(rect[2] <= 208 and rect[3] <= 208 for rect in capture.rects))

    def test_cache_still_decodes_each_new_frame(self):
        capture = FakeCapture(self.stretch)
        reader = AdaptiveCaptureReader()
        self.assertEqual(reader.read(capture, self.config, "WCP1")["tick"], 1)
        for tick in (2, 3):
            capture.image = stretched(encode_frame(snapshot(tick=tick)))
            self.assertEqual(reader.read(capture, self.config, "WCP1")["tick"], tick)
        self.assertEqual(reader.searches, 1)

    def test_cache_failure_and_retry_backoff_never_return_old_data(self):
        now = [10.0]
        reader = AdaptiveCaptureReader(clock=lambda: now[0])
        capture = FakeCapture(self.stretch)
        reader.read(capture, self.config, "WCP1")
        capture.image = Image(bytes(256 * 256 * 4), 256, 256)
        with self.assertRaises(FrameError):
            reader.read(capture, self.config, "WCP1")
        self.assertIsNone(reader.geometry)
        self.assertEqual(reader.searches, 1)
        now[0] += 2.01
        with self.assertRaises(FrameError):
            reader.read(capture, self.config, "WCP1")
        self.assertEqual(reader.searches, 2)

    def test_config_change_discards_cached_geometry(self):
        capture = FakeCapture(self.stretch)
        reader = AdaptiveCaptureReader()
        reader.read(capture, self.config, "WCP1")
        capture.image = Image(pixels_for_frame(self.frame), 128, 128)
        self.assertEqual(reader.read(capture, {**self.config, "x": 0, "y": 0}, "WCP1"), snapshot())
        self.assertIsNone(reader.geometry)

    def test_gray_and_crc_damage_are_strictly_rejected(self):
        geometry = Geometry((0, 0, 128, 128), 1, 1, 2, 2)
        raw = bytearray(pixels_for_frame(self.frame))
        raw[(1 * 128 + 1) * 4:(1 * 128 + 1) * 4 + 3] = b"\x80\x80\x80"
        with self.assertRaisesRegex(FrameError, "模糊"):
            decode_geometry(Image(bytes(raw), 128, 128), geometry, "WCP1")
        damaged = bytearray(self.frame)
        damaged[30] ^= 1
        with self.assertRaisesRegex(FrameError, "CRC"):
            decode_geometry(Image(pixels_for_frame(bytes(damaged)), 128, 128), geometry, "WCP1")
        reader = AdaptiveCaptureReader()
        with self.assertRaises(FrameError):
            reader.read(FakeCapture(stretched(bytes(damaged))), self.config, "WCP1")
        self.assertIsNone(reader.geometry)

    def test_both_profiles_default_to_compact_without_overwriting_saved_calibration(self):
        for game in ("retail", "forever"):
            self.assertEqual(CompanionState(game=game).config["cellSize"], 1)
            saved = {"x": 17, "y": 29, "cellSize": 3}
            state = CompanionState(saved, game=game)
            self.assertEqual((state.config["x"], state.config["y"], state.config["cellSize"]), (17, 29, 3))

    def test_compact_frames_accept_both_magic_values(self):
        for protocol in ("WCP1", "WCF1"):
            frame = encode_frame(snapshot(), protocol)
            reader = AdaptiveCaptureReader()
            capture = FakeCapture(Image(pixels_for_frame(frame, 1), 64, 64))
            self.assertEqual(reader.read(capture, {**self.config, "x": 0, "y": 0, "cellSize": 1}, protocol), snapshot())
            self.assertEqual(capture.rects, [(0, 0, 64, 64)])
            self.assertEqual((reader.image.width, reader.image.height), (64, 64))

    def test_old_calibration_recovers_compact_grid_before_search(self):
        for nominal in (2, 3, 12):
            for protocol in ("WCP1", "WCF1"):
                frame = encode_frame(snapshot(), protocol)
                reader = AdaptiveCaptureReader()
                capture = FakeCapture(Image(pixels_for_frame(frame, 1), 64, 64))
                config = {**self.config, "x": 0, "y": 0, "cellSize": nominal}
                self.assertEqual(reader.read(capture, config, protocol), snapshot())
                self.assertEqual(config["cellSize"], nominal)
                self.assertEqual(reader.searches, 0)
                self.assertEqual(reader.geometry.rect, (0, 0, 64, 64))
                self.assertEqual((reader.image.width, reader.image.height), (64, 64))
                capture.image = Image(pixels_for_frame(encode_frame(snapshot(tick=2), protocol), 1), 64, 64)
                self.assertEqual(reader.read(capture, config, protocol)["tick"], 2)
                self.assertEqual(capture.rects[-1], (0, 0, 64, 64))

    def test_compact_fractional_geometry_and_cropped_preview(self):
        frame = pixels_for_frame(self.frame, 1)
        width = height = 128
        pixels = bytearray(width * height * 4)
        for y in range(height):
            for x in range(width):
                xx, yy = math.floor((x - 8.2) / 1.25), math.floor((y - 32.1) / 1.125)
                level = frame[(yy * 64 + xx) * 4] if 0 <= xx < 64 and 0 <= yy < 64 else 0
                pos = (y * width + x) * 4
                pixels[pos:pos + 4] = bytes((level, level, level, 255))
        capture = FakeCapture(Image(bytes(pixels), width, height))
        reader = AdaptiveCaptureReader()
        self.assertEqual(reader.read(capture, self.config, "WCP1"), snapshot())
        self.assertEqual(reader.searches, 1)
        self.assertLess(reader.geometry.pitch_x, 1.5)
        self.assertLessEqual(reader.image.width, 82)
        self.assertLessEqual(reader.image.height, 74)
        self.assertEqual(reader.read(capture, self.config, "WCP1"), snapshot())

    def test_compact_cache_never_reuses_data_or_another_profile(self):
        reader = AdaptiveCaptureReader()
        config = {**self.config, "x": 0, "y": 0}
        capture = FakeCapture(Image(pixels_for_frame(self.frame, 1), 64, 64))
        self.assertEqual(reader.read(capture, config, "WCP1"), snapshot())
        for invalid in ("gray", "crc", "profile"):
            raw = bytearray(pixels_for_frame(self.frame, 1))
            protocol = "WCP1"
            if invalid == "gray":
                raw[:3] = b"\x80\x80\x80"
            elif invalid == "crc":
                damaged = bytearray(self.frame)
                damaged[30] ^= 1
                raw = pixels_for_frame(bytes(damaged), 1)
            else:
                protocol = "WCF1"
            capture.image = Image(bytes(raw), 64, 64)
            with self.assertRaises(FrameError):
                reader.read(capture, config, protocol)
            self.assertIsNone(reader.geometry)

    def test_search_bounds_and_deadline(self):
        with self.assertRaisesRegex(FrameError, "范围"):
            find_geometry(self.stretch, (0, 0, 256, 256), 2, "WCP1")
        image = Image(bytes(208 * 208 * 4), 208, 208)
        self.assertIsNone(find_geometry(image, (0, 24, 208, 208), 2, "WCP1", budget=0))


if __name__ == "__main__":
    unittest.main()
