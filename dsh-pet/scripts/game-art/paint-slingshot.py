"""Paint the slingshot game's wooden props as raster assets (offline, reproducible).

    python -I scripts/game-art/paint-slingshot.py runtime/electron-helper/game-assets

Outputs (all 3 px per logical scene unit, transparent PNG):
    sling.png    Y-shaped wooden slingshot (trunk + two prongs + leather wraps)
    sling.json   anchor metadata in logical units (origin = trunk base on the ground)
    sling-meta.js  the same metadata as a classic script (window.SLING_META) for the file:// game page
    band.png     rubber band strip (drawn stretched along the band at runtime)
    pouch.png    leather pouch
    shadow.png   soft contact shadow (slingshot base, pet on the ground)

Art spec (matches the dsh-pet character frames, see scripts/game-art/README.md):
    * soft anime cel shading: one shadow tone with a soft edge, a faint core highlight,
      a little bounce light on the shadow side; light from the upper left (same as the character)
    * thin dark-warm line art (character lines are deep navy rgb(21,27,35); wood uses the warm
      equivalent), thicker on the shadow side like a brush stroke
    * low-contrast longitudinal wood grain, one knot, worn leather wraps; muted, never saturated
Rendered as signed-distance tubes with 4x supersampling, then downsampled (antialiased).
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from artlib import K, LEATHER, LIGHT, LINE, PX, SS, WOOD, fbm, save_rgba, smoothstep  # noqa: E402

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'game-assets')
OUT.mkdir(parents=True, exist_ok=True)

def bezier(p0, p1, p2, n):
    t = np.linspace(0, 1, n)[:, None]
    pts = (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t**2 * p2
    tan = 2 * (1 - t) * (p1 - p0) + 2 * t * (p2 - p1)
    tan = tan / np.linalg.norm(tan, axis=1, keepdims=True)
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    return pts, tan, t[:, 0], seg


def tube_field(px, py, branch):
    """Signed distance (logical units, <0 inside), across-coordinate u, along-coordinate, wrap mask."""
    pts, tan, t, seg = bezier(*branch['ctrl'], 600)
    rad = np.interp(t, branch['rt'], branch['rr'])
    tree = cKDTree(pts)
    q = np.stack([px.ravel(), py.ravel()], 1)
    _, idx = tree.query(q)
    s, tg, r = pts[idx], tan[idx], rad[idx]
    v = q - s
    dist = np.linalg.norm(v, axis=1)
    nrm = np.stack([-tg[:, 1], tg[:, 0]], 1)
    u = np.einsum('ij,ij->i', v, nrm) / np.maximum(r, 1e-6)
    d = dist - r
    wrap = np.zeros_like(d)
    for a, b in branch.get('wraps', []):
        wrap = np.maximum(wrap, ((t[idx] >= a) & (t[idx] <= b)).astype(float))
    shp = px.shape
    return d.reshape(shp), u.reshape(shp), seg[idx].reshape(shp), r.reshape(shp), wrap.reshape(shp)


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b * (1 - h) + a * h - k * h * (1 - h), h


def shade_tube(d, r, gx, gy, mat, grain, wrap_lines, line_w):
    """Cel-shade a tube region given its SDF + gradient; returns rgba float image (0..255, alpha 0..1)."""
    s = np.clip(1 + d / np.maximum(r, 1e-6), 0, 1)
    gl = np.hypot(gx, gy) + 1e-9
    nx, ny = gx / gl * s, gy / gl * s
    nz = np.sqrt(np.clip(1 - s * s, 0, 1))
    lam = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]
    lit = smoothstep(0.34, 0.46, lam)  # soft cel edge
    col = mat['shadow'][None, None] * (1 - lit[..., None]) + mat['base'][None, None] * lit[..., None]
    # bounce light along the far shadow edge
    bounce = smoothstep(0.55, 0.92, s) * (1 - lit) * smoothstep(0.0, 0.5, -(nx * LIGHT[0] + ny * LIGHT[1]))
    col = col + (mat['bounce'] - mat['shadow'])[None, None] * bounce[..., None] * 0.8
    # faint core highlight
    hi = smoothstep(0.86, 0.95, lam) * 0.55
    col = col * (1 - hi[..., None]) + mat['light'][None, None] * hi[..., None]
    col = col * (1 - grain[..., None]) + mat['grain'][None, None] * grain[..., None]
    col = col * (1 - wrap_lines[..., None]) + LINE[None, None] * wrap_lines[..., None]
    # line art: thicker on the shadow side (brush feel)
    side = np.clip(0.5 + 0.5 * ((gx / gl) * -LIGHT[0] + (gy / gl) * -LIGHT[1]) / 0.8, 0, 1)
    lw = line_w * (0.7 + 0.6 * side)
    on_line = smoothstep(-lw - 0.08, -lw + 0.08, d)
    col = col * (1 - on_line[..., None]) + LINE[None, None] * on_line[..., None]
    alpha = np.clip(-d * K + 0.5, 0, 1)
    return col, alpha


def paint_sling():
    # logical extent (origin = trunk base on the ground, y down)
    x0, x1, y0, y1 = -46.0, 46.0, -128.0, 0.0  # cut flat at the ground line
    w, h = int((x1 - x0) * K), int((y1 - y0) * K)
    gx, gy = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    px, py = x0 + gx / K, y0 + gy / K
    joint = np.array([0.6, -62.0])
    trunk = {
        'ctrl': (np.array([0.0, 2.0]), np.array([2.4, -30.0]), joint),
        'rt': [0, 0.5, 1], 'rr': [7.3, 6.9, 6.4],
    }
    left = {
        'ctrl': (joint + [-0.6, 3.0], np.array([-18.0, -78.0]), np.array([-31.0, -116.0])),
        'rt': [0, 0.3, 0.78, 0.8, 0.95, 0.97, 1], 'rr': [5.9, 5.2, 4.6, 5.3, 5.1, 4.5, 4.3],
        'wraps': [(0.79, 0.955)],
    }
    right = {
        'ctrl': (joint + [0.6, 3.0], np.array([19.0, -79.0]), np.array([31.5, -114.0])),
        'rt': [0, 0.3, 0.78, 0.8, 0.95, 0.97, 1], 'rr': [5.9, 5.2, 4.6, 5.3, 5.1, 4.5, 4.3],
        'wraps': [(0.79, 0.955)],
    }
    dt, ut, at, rt, _ = tube_field(px, py, trunk)
    dl, ul, al, rl, wl = tube_field(px, py, left)
    dr, ur, ar, rr, wr = tube_field(px, py, right)
    dlr, hlr = smin(dl, dr, 1.2)
    d, h2 = smin(dt, dlr, 3.2)  # organic fork joint
    r = rt * (1 - h2) + (rl * hlr + rr * (1 - hlr)) * h2
    along = np.where(dt < dlr, at, np.where(dl < dr, al + 70, ar + 140))
    across = np.where(dt < dlr, ut, np.where(dl < dr, ul, ur))
    wrap = np.where(dt < dlr, 0.0, np.where(dl < dr, wl, wr))
    gyd, gxd = np.gradient(d)
    # wood grain: long streaks along the branch + fine lines
    grain = fbm((along, across * 3), 0.25, 1.3, 11) - 0.5
    fine = np.abs(np.sin((across * 9 + fbm((along, across), 0.15, 1.0, 21) * 6))) ** 18
    grain_w = np.clip(grain * 0.5 + 0.06, 0, 0.32) + fine * 0.22
    # knot on the trunk
    kx, ky = 2.0, -36.0
    kd = np.hypot((px - kx) / 1.7, (py - ky) / 3.0)
    knot = (smoothstep(1.2, 0.9, kd) * smoothstep(0.3, 0.6, kd)) * 0.22 + smoothstep(0.5, 0.0, kd) * 0.18
    grain_w = np.clip(grain_w + knot * (dt < 0) * (d < -0.8), 0, 0.85)
    # wrap: leather colour + diagonal wrap seams
    seam = (np.abs(((along + across * 3.2) / 2.2) % 1 - 0.5) < 0.07).astype(float) * 0.55
    wcol, alpha = shade_tube(d, r, gxd, gyd, WOOD, grain_w, np.zeros_like(d), 0.95)
    lcol, _ = shade_tube(d, r, gxd, gyd, LEATHER, np.clip(grain * 0.3, 0, 0.2), seam, 0.95)
    col = wcol * (1 - wrap[..., None]) + lcol * wrap[..., None]
    save_rgba(col, alpha, OUT / 'sling.png')

    def tip_attach(branch, t):
        pts, tan, ts, _ = bezier(*branch['ctrl'], 600)
        i = int(t * 599)
        return [round(float(pts[i, 0]), 2), round(float(pts[i, 1]), 2)]

    meta = {
        'pxPerUnit': PX,
        'origin': [-x0, -y0],  # trunk base position inside the PNG (logical units from its top-left)
        'size': [x1 - x0, y1 - y0],
        'backTip': tip_attach(left, 0.87),
        'frontTip': tip_attach(right, 0.87),
    }
    text = json.dumps(meta, indent=2)
    (OUT / 'sling.json').write_text(text + '\n', encoding='utf-8')
    # runtime copy: the game page is a file:// page where fetch() is blocked, so ship it as a classic script
    (OUT / 'sling-meta.js').write_text(
        '// generated by scripts/game-art/paint-slingshot.py - do not edit\n'
        "'use strict';\nwindow.SLING_META = " + text + ';\n',
        encoding='utf-8',
    )


def paint_band():
    """Rubber band: shading across the thickness only, so it stretches cleanly along its length."""
    w, h = 64 * SS, 12 * SS
    y = (np.arange(h) + 0.5) / h * 2 - 1  # -1 top .. 1 bottom
    s = np.abs(y)
    lit = smoothstep(-0.1, 0.25, -y)  # upper half lit
    base, shadow = np.array([158, 106, 72.0]), np.array([110, 70, 48.0])
    col = shadow * (1 - lit[:, None]) + base * lit[:, None]
    hi = smoothstep(0.62, 0.38, np.abs(y + 0.42)) * 0.6
    col = col * (1 - hi[:, None]) + np.array([228, 190, 150.0]) * hi[:, None]
    line = smoothstep(0.66, 0.8, s)
    col = col * (1 - line[:, None]) + LINE * line[:, None]
    alpha = np.clip((1 - s) * h / 2 + 0.5, 0, 1)
    col = np.repeat(col[:, None, :], w, 1)
    alpha = np.repeat(alpha[:, None], w, 1)
    save_rgba(col, alpha, OUT / 'band.png')


def paint_pouch():
    """Leather pouch: a slightly curved lens with stitching and two eyelets."""
    x0, x1, y0, y1 = -13.0, 13.0, -6.0, 6.0
    w, h = int((x1 - x0) * K), int((y1 - y0) * K)
    gx, gy = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    px, py = x0 + gx / K, y0 + gy / K
    bend = 0.016 * px * px  # cradle curve
    qy = py + bend - 1.2
    d = np.hypot(px / 11.0, qy / 3.6) - 1
    d = d * 3.6
    r = np.full_like(d, 3.6)
    gyd, gxd = np.gradient(d)
    grain = np.clip(fbm((px * 3, qy * 3), 0.5, 0.5, 31) - 0.45, 0, 0.25)
    e = np.hypot(px / 8.6, qy / 2.0)
    stitch = ((np.abs(e - 1) < 0.08) & ((np.arctan2(qy, px) * 9 % 1) < 0.5)).astype(float)
    holes = np.zeros_like(d)
    for hx in (-9.0, 9.0):
        hd = np.hypot(px - hx, qy - 0.1)
        holes = np.maximum(holes, smoothstep(1.0, 0.7, hd))
    col, alpha = shade_tube(d, r, gxd, gyd, LEATHER, grain, holes * 0.85, 0.8)
    light_stitch = np.array([200, 168, 130.0])
    col = col * (1 - stitch[..., None] * 0.7) + light_stitch * stitch[..., None] * 0.7
    save_rgba(col, alpha, OUT / 'pouch.png')


def paint_shadow():
    w, h = 80 * SS, 18 * SS
    gx, gy = np.meshgrid((np.arange(w) + 0.5) / w * 2 - 1, (np.arange(h) + 0.5) / h * 2 - 1)
    r = np.hypot(gx, gy)
    alpha = np.exp(-(r**2) * 3.2) * smoothstep(1.0, 0.7, r) * 0.32
    col = np.zeros((h, w, 3)) + np.array([26, 30, 42.0])
    save_rgba(col, alpha, OUT / 'shadow.png')


paint_sling()
paint_band()
paint_pouch()
paint_shadow()
print('painted ->', OUT)
