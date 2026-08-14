"""Crop 235 px from the left and right edges of every video in `video/`."""

from __future__ import annotations

import subprocess
from pathlib import Path


# 脚本位于 scripts/ 子目录，素材目录（video/、step01-04/）在工作区根（上一级）
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "video"
OUT = ROOT / "step01"
# 统一使用工作区自带的 ffmpeg（素材处理链零第三方依赖）
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")
CROP_FILTER = "crop=iw-470:ih:235:0"


def crop_video(src: Path, dst: Path) -> None:
    cmd = [
        FFMPEG,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-vf",
        CROP_FILTER,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-c:a",
        "copy",
        "-map_metadata",
        "0",
        str(dst),
    ]
    result = subprocess.run(
        cmd,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())


def main() -> int:
    OUT.mkdir(exist_ok=True)
    videos = sorted(SRC.glob("*.mp4"))
    if not videos:
        print(f"No MP4 files found in {SRC}")
        return 1

    for index, video in enumerate(videos, start=1):
        print(f"[{index}/{len(videos)}] {video.name}")
        crop_video(video, OUT / video.name)

    print(f"Done. {len(videos)} videos written to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
