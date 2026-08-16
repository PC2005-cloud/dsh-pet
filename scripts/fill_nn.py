"""纯最近邻水印填充：每个水印像素 = 第 k 近的"非水印像素"的颜色

- 流式逐帧处理（内存占用小）
- scipy distance_transform_edt(return_indices) 算最近非水印像素坐标
- k>1：跳过紧贴水印的取色源（淡入淡出的未标记水印字空洞），取更远的真背景
- mask=0 像素不变（距离0 → 取自身）

用法: python fill_nn.py <视频> <mask> <输出> [时长] [k]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parent.parent
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")
W, H, FPS = 1280, 720, 24


def read_exact(stream, n):
    """阻塞读满 n 字节（管道 read 可能部分返回，必须循环）。EOF 时返回不足。"""
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            break
        buf += chunk
    return buf


def kth_nearest(wm: np.ndarray, k: int):
    """返回每个水印像素第 k 近的非水印像素坐标 (iy, ix)。

    distance_transform_edt 的 indices = 每个像素到最近"零元素"的索引；
    传入 wm（水印=非零、非水印=零）→ indices 即"每个像素最近的【非水印】坐标"。
    第 k 近：把前 k-1 轮被引用的取色源并入 wm（变成非零），使其不再被指向。
    """
    cur = wm.copy()
    for _ in range(k):
        _, idx = distance_transform_edt(cur, return_indices=True)
        iy, ix = idx
        used = np.zeros_like(cur, bool)
        used[iy[wm], ix[wm]] = True
        cur = cur | used
    return iy, ix


def fill_nn(video: Path, mask_path: Path, dst: Path, dur: int = 10, k: int = 1) -> int:
    # 输入管道：原视频 rgb24 流
    p1 = subprocess.Popen(
        [FFMPEG, "-loglevel", "error", "-i", str(video),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE)
    # 输入管道：mask gray 流
    p2 = subprocess.Popen(
        [FFMPEG, "-loglevel", "error", "-i", str(mask_path),
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE)
    # 输出管道：rgb24 流 → libx264
    p3 = subprocess.Popen(
        [FFMPEG, "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "fast", str(dst)],
        stdin=subprocess.PIPE)

    frame_size = W * H * 3
    n = 0
    while True:
        buf = read_exact(p1.stdout, frame_size)
        if len(buf) < frame_size:
            break
        mbuf = read_exact(p2.stdout, W * H)
        if len(mbuf) < W * H:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(H, W, 3).copy()  # copy: frombuffer 只读
        mask = np.frombuffer(mbuf, np.uint8).reshape(H, W)
        wm = mask == 255
        if wm.any():
            iy, ix = kth_nearest(wm, k)
            # 只重映射水印像素；clip 防御边缘越界。非水印像素绝不改动。
            yi = np.clip(iy[wm], 0, H - 1)
            xi = np.clip(ix[wm], 0, W - 1)
            frame[wm] = frame[yi, xi]
        p3.stdin.write(frame.tobytes())
        n += 1
    p1.stdout.close()
    p2.stdout.close()
    p3.stdin.close()
    rc1, rc2, rc3 = p1.wait(), p2.wait(), p3.wait()
    print(f"填充完成: {dst} ({n}帧, rc={rc3})")
    return rc3


if __name__ == "__main__":
    video = Path(sys.argv[1])
    mask = Path(sys.argv[2])
    dst = Path(sys.argv[3])
    dur = int(sys.argv[4]) if len(sys.argv) > 4 else 10
    k = int(sys.argv[5]) if len(sys.argv) > 5 else 1
    raise SystemExit(fill_nn(video, mask, dst, dur, k))
