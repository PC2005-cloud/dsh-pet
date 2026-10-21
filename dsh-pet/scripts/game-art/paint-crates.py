"""Paint the slingshot game's breakable wooden props as raster assets (offline, reproducible).

    python -I scripts/game-art/paint-crates.py runtime/electron-helper/game-assets

Outputs (3 px per logical scene unit, transparent PNG):
    crate.png / crate-cracked.png   square crate (framed boards + diagonal brace + nails), 54 units
    shard-1..3.png                  splinters thrown out when a crate breaks
    dust.png                        soft wood-dust puff for breaks / heavy landings

Same art spec as the slingshot (artlib.py / README.md): warm dark line art, light from the upper left,
one soft shadow tone + faint highlight per board bevel, low-contrast grain along each board, muted wood.
Every board is a rounded-rectangle signed distance field, composited back to front.
"""
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, shift

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from artlib import K, LIGHT, LINE, WOOD, fbm, save_rgba, smoothstep  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'game-assets')
OUT.mkdir(parents=True, exist_ok=True)

L2 = np.array([LIGHT[0], LIGHT[1]]) / np.hypot(LIGHT[0], LIGHT[1])  # light direction in the picture plane
INTERIOR = np.array([62, 42, 31], float)  # dark gap between boards
NAIL = np.array([58, 52, 50], float)


def grid(x0, x1, y0, y1):
    w, h = int(round((x1 - x0) * K)), int(round((y1 - y0) * K))
    gx, gy = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    return x0 + gx / K, y0 + gy / K


def board_field(px, py, cx, cy, length, width, angle, jag=0.0, seed=0):
    """Signed distance to a rounded board (<0 inside) + local along/across coords. jag = ragged ends."""
    c, s = np.cos(angle), np.sin(angle)
    u = (px - cx) * c + (py - cy) * s  # along the board
    v = -(px - cx) * s + (py - cy) * c  # across
    half_l = length / 2
    if jag:
        rng = np.random.default_rng(seed)
        phase = rng.random(4) * 6.28
        ragged = jag * (0.5 + 0.5 * np.sin(v * 2.3 + phase[0]) * np.sin(v * 5.1 + phase[1]))
        half_l = half_l - ragged * (u > 0) - jag * (0.5 + 0.5 * np.sin(v * 3.7 + phase[2])) * (u <= 0)
    r = min(0.7, width / 3)
    qx = np.abs(u) - half_l + r
    qy = np.abs(v) - width / 2 + r
    d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r
    return d, u, v


def shade_board(d, u, v, width, angle, tint, seed, line_w=0.75, grain_scale=1.0):
    """Flat board face: soft bevel light on edges facing the light, shadow on the others, grain along u."""
    gy, gx = np.gradient(d)
    gl = np.hypot(gx, gy) + 1e-9
    facing = (gx / gl) * L2[0] + (gy / gl) * L2[1]  # >0: edge faces the light (upper left)
    bevel = smoothstep(-1.4, -0.2, d)  # band just inside the edge
    base = WOOD['base'] * tint
    col = np.zeros(d.shape + (3,)) + base
    lit_edge = bevel * smoothstep(0.1, 0.6, facing)
    dark_edge = bevel * smoothstep(0.1, 0.6, -facing)
    col = col * (1 - lit_edge[..., None] * 0.55) + WOOD['light'] * lit_edge[..., None] * 0.55
    col = col * (1 - dark_edge[..., None] * 0.7) + WOOD['shadow'] * tint * dark_edge[..., None] * 0.7
    # broad, very soft face gradient: a touch lighter toward the light
    face = np.clip(0.5 - 0.5 * (v / (width / 2 + 1e-6)) * np.cos(angle - np.pi / 2), 0, 1)
    col = col * (0.96 + 0.06 * face[..., None])
    # grain: long streaks + fine lines along the board
    g = fbm((u * grain_scale, v * 3), 0.22, 1.2, seed) - 0.5
    fine = np.abs(np.sin(v * 7 + fbm((u, v), 0.12, 0.9, seed + 9) * 5)) ** 16
    gw = np.clip(g * 0.45 + 0.05, 0, 0.3) + fine * 0.2
    col = col * (1 - gw[..., None]) + WOOD['grain'] * tint * gw[..., None]
    side = np.clip(0.5 - 0.5 * facing / 0.8, 0, 1)
    lw = line_w * (0.75 + 0.5 * side)
    on_line = smoothstep(-lw - 0.08, -lw + 0.08, d)
    col = col * (1 - on_line[..., None]) + LINE * on_line[..., None]
    alpha = np.clip(-d * K + 0.5, 0, 1)
    return col, alpha


def over(dst, src):
    """Alpha-composite src (col, a) over dst (col, a)."""
    dc, da = dst
    sc, sa = src
    out_a = sa + da * (1 - sa)
    out_c = (sc * sa[..., None] + dc * da[..., None] * (1 - sa[..., None])) / np.maximum(out_a[..., None], 1e-6)
    return out_c, out_a


def empty(px):
    return np.zeros(px.shape + (3,)), np.zeros(px.shape)


def nail(px, py, x, y):
    d = np.hypot(px - x, py - y) - 0.95
    a = np.clip(-d * K + 0.5, 0, 1)
    col = np.zeros(px.shape + (3,)) + NAIL
    hi = smoothstep(0.55, 0.0, np.hypot(px - x + 0.3, py - y + 0.35))
    col = col * (1 - hi[..., None] * 0.6) + np.array([170, 160, 150.0]) * hi[..., None] * 0.6
    return col, a


def crack_overlay(px, py, ex, ey, seed, strokes, sides=(0, 1, 2, 3), step=(3.0, 6.0)):
    """Hand-drawn style cracks on a box of half extents (ex, ey): dark jagged lines with a pale chipped edge.
    Each crack starts on one of `sides` (0 top, 1 right, 2 bottom, 3 left) and wanders inward."""
    rng = np.random.default_rng(seed)
    dark = np.zeros(px.shape)
    pale = np.zeros(px.shape)
    for _ in range(strokes):
        side = sides[rng.integers(len(sides))]
        tx, ty = rng.uniform(-0.6, 0.6) * ex, rng.uniform(-0.35, 0.35) * ey
        p = np.array([[tx, -ey], [ex, ty], [tx, ey], [-ex, ty]][side], float)
        heading = np.arctan2(-p[1] * ex / max(ey, 1e-6), -p[0]) + rng.uniform(-0.5, 0.5)
        pts = [p.copy()]
        for _ in range(rng.integers(4, 7)):
            heading += rng.uniform(-0.7, 0.7)
            p = p + np.array([np.cos(heading), np.sin(heading)]) * rng.uniform(*step)
            pts.append(p.copy())
        for a, b in zip(pts[:-1], pts[1:]):
            ab = b - a
            tt = np.clip(((px - a[0]) * ab[0] + (py - a[1]) * ab[1]) / (ab @ ab + 1e-9), 0, 1)
            dist = np.hypot(px - (a[0] + tt * ab[0]), py - (a[1] + tt * ab[1]))
            width = 0.55 * (1 - 0.5 * tt)
            dark = np.maximum(dark, smoothstep(width + 0.12, width - 0.12, dist))
            dist2 = np.hypot(px - (a[0] + tt * ab[0]) - 0.55, py - (a[1] + tt * ab[1]) - 0.55)
            pale = np.maximum(pale, smoothstep(0.5, 0.2, dist2))
    return dark, pale * (1 - dark)


def paint_crate(size, cracked):
    e = size / 2
    px, py = grid(-e - 1, e + 1, -e - 1, e + 1)
    frame = 8.0
    inner = size - 2 * frame
    acc = empty(px)
    # dark interior visible in the gaps between planks
    d_in, _, _ = board_field(px, py, 0, 0, size - 2, size - 2, 0)
    acc = over(acc, (np.zeros(px.shape + (3,)) + INTERIOR, np.clip(-d_in * K + 0.5, 0, 1)))
    # three vertical inner planks with a little tint variation
    pw = inner / 3
    for i, tint in enumerate((0.97, 1.05, 0.99)):
        cx = -inner / 2 + pw * (i + 0.5)
        d, u, v = board_field(px, py, cx, 0, inner + 2, pw - 0.6, np.pi / 2)
        col, a = shade_board(d, u, v, pw - 0.6, np.pi / 2, tint, 100 + i)
        # ambient occlusion near the frame
        ao = smoothstep(inner / 2 - 4, inner / 2, np.maximum(np.abs(px), np.abs(py)))
        col = col * (1 - ao[..., None] * 0.25)
        acc = over(acc, (col, a))
    # diagonal brace (bottom-left -> top-right) with a soft cast shadow on the planks
    ang = -np.pi / 4
    blen = inner * np.sqrt(2) + 2
    d, u, v = board_field(px, py, 0, 0, blen, 7.0, ang)
    clip_inner = np.clip(-board_field(px, py, 0, 0, inner + 0.5, inner + 0.5, 0)[0] * K + 0.5, 0, 1)
    shadow = gaussian_filter(np.clip(-d * K + 0.5, 0, 1), 1.1 * K)
    shadow = shift(shadow, (1.6 * K, 1.2 * K), order=1) * clip_inner
    acc = (acc[0] * (1 - shadow[..., None] * 0.35), acc[1])
    col, a = shade_board(d, u, v, 7.0, ang, 1.02, 120)
    acc = over(acc, (col, a * clip_inner))
    # frame: top / bottom full width, left / right between them
    for cx, cy, length, angle, tint, seed in (
        (0, -e + frame / 2, size, 0, 1.0, 130),
        (0, e - frame / 2, size, 0, 0.97, 131),
        (-e + frame / 2, 0, inner, np.pi / 2, 1.02, 132),
        (e - frame / 2, 0, inner, np.pi / 2, 0.98, 133),
    ):
        d, u, v = board_field(px, py, cx, cy, length, frame, angle)
        col, a = shade_board(d, u, v, frame, angle, tint, seed, line_w=0.85)
        acc = over(acc, (col, a))
    # nails at the frame joints
    for sx in (-1, 1):
        for sy in (-1, 1):
            acc = over(acc, nail(px, py, sx * (e - frame / 2), sy * (e - frame / 2)))
            acc = over(acc, nail(px, py, sx * (e - frame / 2), sy * (e - frame - 3.2)))
    col, a = acc
    if cracked:
        dark, pale = crack_overlay(px, py, e, e, 7 + int(size), 3)
        inside = np.clip(-d_in * K + 0.5, 0, 1)
        col = col * (1 - pale[..., None] * 0.45 * inside[..., None]) + np.array([214, 178, 138.0]) * pale[
            ..., None
        ] * 0.45 * inside[..., None]
        col = col * (1 - dark[..., None] * inside[..., None]) + LINE * dark[..., None] * inside[..., None]
    return col, a


def paint_shard(length, width, angle, seed):
    ext = length / 2 + 2
    px, py = grid(-ext, ext, -ext, ext)
    d, u, v = board_field(px, py, 0, 0, length, width, angle, jag=2.6, seed=seed)
    return shade_board(d, u, v, width, angle, 1.0 + (seed % 3 - 1) * 0.03, seed, line_w=0.7)


def paint_dust():
    px, py = grid(-16, 16, -12, 12)
    rng = np.random.default_rng(55)
    d = np.full(px.shape, 9e9)
    for _ in range(7):
        cx, cy = rng.uniform(-8, 8), rng.uniform(-4, 4)
        r = rng.uniform(4.5, 7.5)
        di = np.hypot(px - cx, py - cy) - r
        h = np.clip(0.5 + 0.5 * (di - d) / 3.0, 0, 1)
        d = di * (1 - h) + d * h - 3.0 * h * (1 - h)
    base = np.array([226, 216, 202.0])
    shade = np.array([186, 172, 156.0])
    lit = smoothstep(4, -6, py + px * 0.3)
    col = shade * (1 - lit[..., None]) + base * lit[..., None]
    soft = smoothstep(0.5, -4.0, d)  # soft edge, no outline (like the sparkles / bubbles)
    alpha = soft * (0.55 + 0.25 * (fbm((px, py), 0.25, 0.25, 77) - 0.5))
    return col, np.clip(alpha, 0, 0.85)


for name, (col, a) in {
    'crate': paint_crate(54, False),
    'crate-cracked': paint_crate(54, True),
    'shard-1': paint_shard(20, 6.5, 0.3, 201),
    'shard-2': paint_shard(15, 5.5, -0.5, 202),
    'shard-3': paint_shard(24, 7.0, 1.1, 203),
    'dust': paint_dust(),
}.items():
    im = save_rgba(col, a, OUT / f'{name}.png')
    print(f'{name}.png  {im.width}x{im.height}')
