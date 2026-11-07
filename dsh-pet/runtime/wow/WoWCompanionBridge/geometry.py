"""Bounded local geometry recovery; every result still passes the original codec.

Windows can stretch a window after the addon has calculated its physical pixel
size. Only the sampling positions are learned here. No decoded data is cached.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import struct
import time

from protocol import (COLS, ROWS, FRAME_BYTES, MAX_PAYLOAD, FrameError,
                      EquipmentComparisonError, EquipmentOfferError, EquipmentSwapError, EquipmentLoadoutError, InventoryError, QuestError, TalentError,
                      decode_frame, decode_pixels, frame_magic)

DATA_ERRORS = (EquipmentComparisonError, EquipmentOfferError, EquipmentSwapError, EquipmentLoadoutError, InventoryError, QuestError, TalentError)
RETRY_SECONDS = 2.0
SEARCH_SECONDS = 1.5
COMPACT_SEARCH_SECONDS = .35


@dataclass(frozen=True)
class Image:
    pixels: bytes
    width: int
    height: int


@dataclass(frozen=True)
class Geometry:
    rect: tuple[int, int, int, int]
    center_x: float
    center_y: float
    pitch_x: float
    pitch_y: float


def _levels(image: Image) -> list[int]:
    if image.width <= 0 or image.height <= 0 or len(image.pixels) != image.width * image.height * 4:
        raise FrameError("截图尺寸与网格配置不匹配")
    raw = image.pixels
    return [(raw[i] + raw[i + 1] + raw[i + 2]) // 3 for i in range(0, len(raw), 4)]


def _sample(levels: list[int], width: int, height: int, xs: tuple[int, ...], ys: tuple[int, ...], protocol: str) -> dict:
    if (len(xs) != COLS or len(ys) != ROWS or min(xs) < 0 or min(ys) < 0
            or max(xs) >= width or max(ys) >= height):
        raise FrameError("截图尺寸与网格配置不匹配")
    frame = bytearray(FRAME_BYTES)
    i = 0
    for y in ys:
        row = y * width
        for x in xs:
            intensity = levels[row + x]
            # Exactly the same exclusion and bit thresholds as decode_pixels.
            if 96 < intensity < 160:
                raise FrameError("网格像素模糊或被遮挡，请检查缩放、位置和 HDR")
            if intensity >= 160:
                frame[i // 8] |= 1 << (7 - i % 8)
            i += 1
    return decode_frame(bytes(frame), protocol)


def decode_geometry(image: Image, geometry: Geometry, protocol: str) -> dict:
    xs = tuple(math.floor(geometry.center_x + i * geometry.pitch_x) for i in range(COLS))
    ys = tuple(math.floor(geometry.center_y + i * geometry.pitch_y) for i in range(ROWS))
    return _sample(_levels(image), image.width, image.height, xs, ys, protocol)


def find_geometry(image: Image, rect: tuple[int, int, int, int], nominal: int,
                  protocol: str, *, clock=time.monotonic, budget=SEARCH_SECONDS) -> tuple[Geometry, dict] | None:
    """Look near the configured origin, with independent X/Y pitches.

    Magic bytes and a legal length filter candidates. Black/white endpoint
    distance ranks them; that score never changes the strict acceptance rules.
    A time budget, local anchor bound and fixed candidate caps bound the work.
    """
    width, height = image.width, image.height
    maximum = math.ceil(COLS * nominal * 1.5) + nominal * 8
    if (not 1 <= nominal <= 12 or rect[2:] != (width, height)
            or width > maximum or height > maximum):
        raise FrameError("自动校准截图超出局部搜索范围")
    started = clock()
    deadline = started + budget
    values = _levels(image)
    categories = [0 if z <= 96 else 1 if z >= 160 else -1 for z in values]
    expected = tuple((byte >> (7 - bit)) & 1 for byte in frame_magic(protocol) for bit in range(8))
    minimum_pitch, maximum_pitch = max(1.0, nominal * .75), nominal * 1.5
    pitch_steps = range(math.ceil(minimum_pitch * 64), math.floor(maximum_pitch * 64) + 1)
    pitches = tuple(step / 64 for step in pitch_steps)
    anchor_limit = min(nominal * 16, width - 1, height - 1)
    header_rows = tuple(categories[y * width:(y + 1) * width] for y in range(anchor_limit + 1))
    candidates = {}
    examined = 0
    for pitch in pitches:
        for quarter in range(anchor_limit * 4 + 1):
            center = quarter / 4
            xs = tuple(math.floor(center + i * pitch) for i in range(COLS))
            if xs[-1] >= width:
                continue
            examined += 1
            if examined % 32 == 0 and clock() >= deadline:
                return None
            for y, row in enumerate(header_rows):
                if not all(row[xs[j]] == expected[j] for j in range(32)):
                    continue
                bits = tuple(row[x] for x in xs)
                if -1 in bits:
                    continue
                header = bytes(sum(bits[j + k] << (7 - k) for k in range(8)) for j in range(32, 64, 8))
                length, _crc = struct.unpack("<HH", header)
                if 1 <= length <= MAX_PAYLOAD:
                    candidates.setdefault((xs, y), (center, pitch))
    if not candidates:
        return None
    # Integrating columns over the grid suppresses phase choices that hit
    # interpolated cell borders. Search uses no game-specific payload content.
    column_scores = {}
    for y in {key[1] for key in candidates}:
        stop = min(height, y + math.ceil(maximum_pitch * ROWS))
        column_scores[y] = [sum(min(values[yy * width + x], 255 - values[yy * width + x])
                                for yy in range(y, stop)) for x in range(width)]
    ranked = sorted(candidates.items(), key=lambda item: sum(column_scores[item[0][1]][x] for x in item[0][0]))[:24]
    for (xs, first_y), (center_x, pitch_x) in ranked:
        if clock() >= deadline:
            return None
        row_scores = [sum(min(values[y * width + x], 255 - values[y * width + x]) for x in xs) for y in range(height)]
        y_candidates = {}
        for pitch_y in pitches:
            for phase in (.5, .25, .75, 0.0):
                center_y = first_y + phase
                ys = tuple(math.floor(center_y + i * pitch_y) for i in range(ROWS))
                if ys[-1] >= height or ys in y_candidates:
                    continue
                y_candidates[ys] = (sum(row_scores[y] for y in ys), center_y, pitch_y)
        for ys, (_score, center_y, pitch_y) in sorted(y_candidates.items(), key=lambda item: item[1][0])[:32]:
            if clock() >= deadline:
                return None
            try:
                message = _sample(values, width, height, xs, ys, protocol)
            except FrameError:
                continue
            return Geometry(rect, center_x, center_y, pitch_x, pitch_y), message
    return None


class AdaptiveCaptureReader:
    """Fast integer capture, then verified geometry; retry searches at most 2s."""

    def __init__(self, *, clock=time.monotonic):
        self.clock = clock
        self.geometry: Geometry | None = None
        self.signature = None
        self.next_search = 0.0
        self.image: Image | None = None
        self.searches = 0

    def _grab(self, capture, rect: tuple[int, int, int, int]) -> Image:
        x, y, width, height = rect
        self.image = Image(capture.grab(x, y, width, height), width, height)
        return self.image

    def _remember(self, image: Image, geometry: Geometry) -> None:
        # Cache only sampling positions and crop the preview to their actual grid bounds.
        left = max(0, math.floor(geometry.center_x - geometry.pitch_x / 2))
        top = max(0, math.floor(geometry.center_y - geometry.pitch_y / 2))
        right = min(image.width, math.ceil(geometry.center_x + (COLS - .5) * geometry.pitch_x))
        bottom = min(image.height, math.ceil(geometry.center_y + (ROWS - .5) * geometry.pitch_y))
        width, height = right - left, bottom - top
        pixels = b"".join(image.pixels[(y * image.width + left) * 4:(y * image.width + right) * 4]
                          for y in range(top, bottom))
        self.image = Image(pixels, width, height)
        self.geometry = Geometry((geometry.rect[0] + left, geometry.rect[1] + top, width, height),
                                 geometry.center_x - left, geometry.center_y - top,
                                 geometry.pitch_x, geometry.pitch_y)

    def read(self, capture, config: dict, protocol: str) -> dict:
        self.image = None
        signature = (config["x"], config["y"], config["cellSize"], protocol)
        if signature != self.signature:
            self.signature = signature
            self.geometry = None
            self.next_search = 0.0
        if self.geometry is not None:
            try:
                return decode_geometry(self._grab(capture, self.geometry.rect), self.geometry, protocol)
            except DATA_ERRORS:
                raise
            except FrameError:
                self.geometry = None
        nominal = config["cellSize"]
        rect = (config["x"], config["y"], COLS * nominal, ROWS * nominal)
        image = self._grab(capture, rect)
        try:
            return decode_pixels(image.pixels, image.width, image.height, nominal, protocol)
        except DATA_ERRORS:
            raise
        except FrameError as original:
            # Addon upgrades shrink existing layouts to one pixel without moving their origin.
            # Try that exact grid before any slower search, including during search backoff.
            if nominal != 1:
                compact_rect = (config["x"], config["y"], COLS, ROWS)
                compact = self._grab(capture, compact_rect)
                try:
                    message = decode_pixels(compact.pixels, COLS, ROWS, 1, protocol)
                except DATA_ERRORS:
                    raise
                except FrameError:
                    pass
                else:
                    self.geometry = Geometry(compact_rect, .5, .5, 1, 1)
                    return message
            if self.clock() < self.next_search:
                raise original
            self.next_search = self.clock() + RETRY_SECONDS
            deadline = self.clock() + SEARCH_SECONDS
            self.searches += 1
            if nominal != 1:
                # A stretched compact grid may have a fractional pitch below the old nominal range.
                compact_rect = (config["x"] - 4, config["y"] - 4, 104, 104)
                compact = self._grab(capture, compact_rect)
                found = find_geometry(compact, compact_rect, 1, protocol, clock=self.clock,
                                      budget=min(COMPACT_SEARCH_SECONDS, max(0, deadline - self.clock())))
                if found is not None:
                    geometry, message = found
                    self._remember(compact, geometry)
                    return message
            padding = nominal * 4
            side = math.ceil(COLS * nominal * 1.5) + padding * 2
            local_rect = (config["x"] - padding, config["y"] - padding, side, side)
            image = self._grab(capture, local_rect)
            found = find_geometry(image, local_rect, nominal, protocol, clock=self.clock,
                                  budget=max(0, deadline - self.clock()))
            if found is None:
                raise original
            geometry, message = found
            self._remember(image, geometry)
            return message
