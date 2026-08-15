"""Remove green backgrounds from step01 videos into transparent WebM files in step02/."""

from __future__ import annotations

import subprocess
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "step01"
OUT = ROOT / "step02"
# 统一使用工作区自带的 ffmpeg（素材处理链零第三方依赖）
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")

SIMILARITY = 0.04
SMOOTHNESS = 0.0

WIDTH = 320
HEIGHT = 180
MARGIN_X = WIDTH // 10
MARGIN_Y = HEIGHT // 10
FRAMES_PER_VIDEO = 10
QUANTIZE = 8

GREEN_HUE_MIN = 70.0
GREEN_HUE_MAX = 170.0
SATURATION_MIN = 0.15
VALUE_MIN = 0.15


def rgb_to_hsv(r: int, g: int, b: int) -> tuple[float, float, float]:
    rn, gn, bn = r / 255.0, g / 255.0, b / 255.0
    mx = max(rn, gn, bn)
    mn = min(rn, gn, bn)
    delta = mx - mn
    if delta == 0:
        return 0.0, 0.0, mx
    if mx == rn:
        hue = 60.0 * (((gn - bn) / delta) % 6.0)
    elif mx == gn:
        hue = 60.0 * (((bn - rn) / delta) + 2.0)
    else:
        hue = 60.0 * (((rn - gn) / delta) + 4.0)
    saturation = delta / mx if mx else 0.0
    return hue, saturation, mx


def sample_background_color(video: Path) -> str:
    cmd = [
        FFMPEG,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video),
        "-an",
        "-vf",
        f"fps=1,scale={WIDTH}:{HEIGHT}",
        "-frames:v",
        str(FRAMES_PER_VIDEO),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]
    result = subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_size = WIDTH * HEIGHT * 3
    counter: Counter = Counter()

    for offset in range(0, len(result.stdout) - frame_size + 1, frame_size):
        frame = result.stdout[offset : offset + frame_size]
        for y in range(HEIGHT):
            for x in range(WIDTH):
                if MARGIN_X <= x < WIDTH - MARGIN_X and MARGIN_Y <= y < HEIGHT - MARGIN_Y:
                    continue
                index = (y * WIDTH + x) * 3
                r, g, b = frame[index], frame[index + 1], frame[index + 2]
                hue, sat, val = rgb_to_hsv(r, g, b)
                if GREEN_HUE_MIN <= hue <= GREEN_HUE_MAX and sat >= SATURATION_MIN and val >= VALUE_MIN:
                    q = (r // QUANTIZE * QUANTIZE, g // QUANTIZE * QUANTIZE, b // QUANTIZE * QUANTIZE)
                    counter[q] += 1

    if not counter:
        raise RuntimeError(f"No green pixels found in border of {video.name}")
    (r, g, b), _ = counter.most_common(1)[0]
    return "#%02X%02X%02X" % (r, g, b)


def convert_video(src: Path, dst: Path, color: str) -> None:
    vf = f"chromakey=0x{color.lstrip('#')}:{SIMILARITY}:{SMOOTHNESS},format=yuva420p"
    cmd = [
        FFMPEG,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-vf",
        vf,
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "30",
        "-b:v",
        "0",
        "-auto-alt-ref",
        "0",
        "-deadline",
        "good",
        "-cpu-used",
        "4",
        "-c:a",
        "libopus",
        "-b:a",
        "128k",
        str(dst),
    ]
    result = subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())


def main() -> int:
    OUT.mkdir(exist_ok=True)
    videos = sorted(SRC.glob("*.mp4"))
    if not videos:
        print(f"No MP4 files found in {SRC}")
        return 1

    for index, video in enumerate(videos, start=1):
        dst = OUT / (video.stem + ".webm")
        # 断点续跑：输出已存在、非残缺（>50KB）、且不比源旧 → 跳过（支持增量续跑）
        if dst.exists() and dst.stat().st_size > 50_000 and dst.stat().st_mtime >= video.stat().st_mtime:
            print(f"[{index}/{len(videos)}] SKIP {video.name} (already chroma'd)", flush=True)
            continue
        color = sample_background_color(video)
        print(f"[{index}/{len(videos)}] {video.name} -> {dst.name} ({color})", flush=True)
        convert_video(video, dst, color)

    print(f"Done. {len(videos)} videos written to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
