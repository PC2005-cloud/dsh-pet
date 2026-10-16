"""从纯黑视频生成精确水印 mask：亮度>阈值 = 水印像素（黑背景无干扰）

用法: python make_mask_black.py [输出.mkv] [阈值]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")
BLACK_VIDEO = Path(r"D:\Source\windows\Downloads\生成10秒纯黑视频.mp4")

W, H = 1280, 720
FPS = 24
DEFAULT_LUM_THRESH = 20


def make_mask(dst: Path, lum_thresh: int = DEFAULT_LUM_THRESH) -> None:
    cmd = [FFMPEG, "-i", str(BLACK_VIDEO), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_size = W * H * 3
    mask_size = W * H
    frames = 0
    with open(dst.with_suffix(".raw"), "wb") as fw:
        while True:
            buf = proc.stdout.read(frame_size)
            if len(buf) < frame_size:
                break
            mask = bytearray(mask_size)
            for y in range(H):
                row = y * W * 3
                mrow = y * W
                for x in range(W):
                    i = row + x * 3
                    if (buf[i] + buf[i + 1] + buf[i + 2]) // 3 > lum_thresh:
                        mask[mrow + x] = 255
            fw.write(mask)
            frames += 1
    proc.stdout.close()
    proc.wait()
    print(f"分析帧数: {frames}")

    enc = [FFMPEG, "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(FPS),
           "-i", str(dst.with_suffix(".raw")),
           "-c:v", "ffv1", "-pix_fmt", "gray", str(dst)]
    r = subprocess.run(enc)
    if r.returncode != 0:
        raise RuntimeError("mask 编码失败")
    dst.with_suffix(".raw").unlink()
    print(f"mask 已生成: {dst} ({dst.stat().st_size / 1024:.0f}KB)")


if __name__ == "__main__":
    dst = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "watermark_mask_precise.mkv"
    thresh = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_LUM_THRESH
    print(f"阈值: {thresh}")
    make_mask(dst, thresh)
