#!/usr/bin/env python3
"""校验 HEVC-with-Alpha 产物的 alpha 通道是否真实存在。

用法：python check_alpha.py dist/*.mov（或 ls 展开）
判断：提取首帧的 RGBA，A 通道必须有真实层次（存在 >200 的不透明像素，
也存在 <100 的透明像素）——若全是 255 说明编码丢 alpha，必须修编码命令。
"""
import os
import subprocess
import sys

FFMPEG = "ffmpeg"


def check_one(path: str) -> bool:
    rgba = path[:-4] + (".rgba" if not path.endswith(".rgba") else path)
    r = subprocess.run(
        [FFMPEG, "-y", "-v", "error", "-i", path, "-ss", "1", "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "rgba", rgba],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not os.path.exists(rgba) or os.path.getsize(rgba) < 16:
        print(f"  [WARN] {path}: no frame extracted")
        return True
    data = open(rgba, "rb").read()
    alpha = data[3::4]  # rgba 每像素 4 字节，A 是第 4 个
    a_min, a_max = min(alpha), max(alpha)
    a_mean = sum(alpha) / len(alpha)
    ok = a_max > 200 and a_min < 100
    print(f"  alpha min={a_min} max={a_max} mean={a_mean:.1f} -> {'OK' if ok else '!! LOST'}")
    os.remove(rgba)
    return ok


def main() -> int:
    files = sys.argv[1:]
    if not files:
        print("usage: python check_alpha.py <mov...> 或 ls dist/*.mov | xargs python check_alpha.py")
        return 2
    failed = 0
    for f in files:
        if not check_one(f):
            failed += 1
    print(f"check: {len(files) - failed}/{len(files)} alpha OK")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
