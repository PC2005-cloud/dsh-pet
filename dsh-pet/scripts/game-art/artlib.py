"""Shared painting kit for the slingshot game's props (same palette / light / line spec everywhere).

Imported by paint-slingshot.py and paint-crates.py so every painted prop follows one art spec
(see README.md): 3 px per logical unit, 4x supersampling, warm dark line art, light from the upper left.
"""
import numpy as np
from PIL import Image

PX = 3  # final px per logical unit
SS = 4  # supersampling
K = PX * SS

LINE = np.array([52, 33, 24], float)
WOOD = {
    'base': np.array([168, 120, 82], float),
    'shadow': np.array([116, 78, 55], float),
    'light': np.array([214, 172, 126], float),
    'bounce': np.array([142, 100, 72], float),
    'grain': np.array([128, 86, 58], float),
}
LEATHER = {
    'base': np.array([104, 70, 54], float),
    'shadow': np.array([70, 46, 37], float),
    'light': np.array([150, 108, 84], float),
    'bounce': np.array([86, 58, 46], float),
    'grain': np.array([60, 40, 32], float),
}
LIGHT = np.array([-0.5, -0.62, 0.6])
LIGHT = LIGHT / np.linalg.norm(LIGHT)
RNG = np.random.default_rng(7340)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def value_noise(shape_xy, scale_x, scale_y, seed):
    """Smooth 2D value noise sampled at pixel coords (x, y) scaled independently (stretched grain)."""
    xs, ys = shape_xy
    rng = np.random.default_rng(seed)
    grid = rng.random((512, 512))
    fx, fy = xs * scale_x, ys * scale_y
    x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    tx, ty = fx - x0, fy - y0
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    g = lambda ix, iy: grid[iy % 512, ix % 512]
    a = g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx
    b = g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx
    return a * (1 - ty) + b * ty


def fbm(coords, sx, sy, seed, octaves=4):
    total, amp, norm = 0, 1.0, 0
    for o in range(octaves):
        total = total + amp * value_noise(coords, sx * 2**o, sy * 2**o, seed + o)
        norm += amp
        amp *= 0.5
    return total / norm


def save_rgba(col, alpha, path):
    rgba = np.dstack([np.clip(col, 0, 255), np.clip(alpha, 0, 1) * 255]).astype(np.uint8)
    im = Image.fromarray(rgba, 'RGBA')
    im = im.resize((im.width // SS, im.height // SS), Image.LANCZOS)
    im.save(path)
    return im
