"""Cut the slingshot game's small bubbles (aim guide / flight trail) out of the pet's own animation frames.

    python -I scripts/game-art/cut-props.py <framesDir> runtime/electron-helper/game-assets

<framesDir> holds RGBA PNG frames named "<animation>_<seconds>.png" (e.g. 鲸鱼吐泡泡特效_4.20.png),
grabbed from assets/webm with alpha by Chromium (see scripts/game-art/README.md — OpenCV/ffmpeg builds
without libvpx alpha drop the alpha plane, so frames are captured from a <video> element instead).

Each prop is the alpha-connected component that contains a known point of a known frame, so the
cut never includes the character. Bubbles get their fringe cleaned with a feathered circular mask
(fitted from the filled component), which also trims the little stems where a bubble was still
touching its neighbour.
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

FRAMES, OUT = Path(sys.argv[1]), Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

# (output name, source frame stem, a point inside the prop in 640x360 frame pixels, kind)
PROPS = [
    ('bubble-s1', '鲸鱼吐泡泡特效_5.70', (226, 62), 'bubble'),
    ('bubble-s2', '鲸鱼吐泡泡特效_5.40', (155, 112), 'bubble'),
    ('bubble-s3', '鲸鱼吐泡泡特效_4.80', (171, 147), 'bubble'),
]


def component_at(rgba: np.ndarray, pt: tuple[int, int]) -> np.ndarray:
    alpha = rgba[:, :, 3]
    mask = (alpha > 8).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    _, lab = cv2.connectedComponents(mask, connectivity=8)
    x, y = pt
    win = lab[max(0, y - 3) : y + 4, max(0, x - 3) : x + 4]
    ids = win[win > 0]
    if ids.size == 0:
        raise SystemExit(f'no component at {pt}')
    return lab == np.bincount(ids).argmax()


def clean_bubble(rgba: np.ndarray, comp: np.ndarray) -> np.ndarray:
    filled = comp.astype(np.uint8)
    contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    filled = cv2.morphologyEx(filled, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))  # drop stems
    ys, xs = np.nonzero(filled)
    cx, cy = xs.mean(), ys.mean()
    r = np.sqrt(len(xs) / np.pi)
    yy, xx = np.mgrid[0 : rgba.shape[0], 0 : rgba.shape[1]]
    d = np.hypot(xx - cx, yy - cy)
    feather = np.clip((r + 1.6 - d) / 1.6, 0, 1)
    out = rgba.astype(float)
    out[:, :, 3] *= feather * comp
    pad = int(np.ceil(r + 3))
    x0, y0 = int(round(cx)) - pad, int(round(cy)) - pad
    return crop(out, x0, y0, 2 * pad + 1, 2 * pad + 1)


def clean_sparkle(rgba: np.ndarray, comp: np.ndarray) -> np.ndarray:
    keep = cv2.dilate(comp.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    out = rgba.astype(float)
    out[:, :, 3] *= keep
    # drop the lantern's grey glow residue (it reads as dirt on light wallpapers); keep the star itself
    out[:, :, 3] = np.clip((out[:, :, 3] - 70) / (255 - 70), 0, 1) * 255
    x, y, w, h = cv2.boundingRect(keep.astype(np.uint8))
    side = max(w, h) + 4
    return crop(out, x + w // 2 - side // 2, y + h // 2 - side // 2, side, side)


def crop(img: np.ndarray, x0: int, y0: int, w: int, h: int) -> np.ndarray:
    canvas = np.zeros((h, w, 4), float)
    sx0, sy0 = max(0, x0), max(0, y0)
    sx1, sy1 = min(img.shape[1], x0 + w), min(img.shape[0], y0 + h)
    canvas[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0] = img[sy0:sy1, sx0:sx1]
    return canvas


for name, stem, pt, kind in PROPS:
    src = FRAMES / f'{stem}.png'
    rgba = np.array(Image.open(src).convert('RGBA'))
    comp = component_at(rgba, pt)
    out = clean_bubble(rgba, comp) if kind == 'bubble' else clean_sparkle(rgba, comp)
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), 'RGBA').save(OUT / f'{name}.png')
    print(f'{name}.png  {out.shape[1]}x{out.shape[0]}  <- {src.name}')
