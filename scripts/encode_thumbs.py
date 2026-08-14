"""Transcode step03 masters into 360x360 playback thumbnails (step04).

素材处理链的第 4 步（转码）：把归一化后的 1200x1200 透明母版（step03/）
转成 360x360 播放变体（step04/），供 dsh-pet 插件运行时使用。

完整处理链（与 crop_step01.py / chroma_step02.py / normalize_step03.py 同级）：
  step01（原始视频）→ crop_step01.py → chroma_step02.py（绿幕抠像）
  → step02（透明 810x720）→ normalize_step03.py（归一化 1200x1200 统一站立）
  → step03（母版）→ 本脚本 → step04（360x360 播放变体）

step04 是素材处理链的最终产物。发布/安装插件时把 step04 的内容
同步到 dsh-pet/assets/thumb/（npm 包需要自包含的播放资源）。

为什么需要转码：
- 播放时宠物只显示约 260px，360 分辨率已足够清晰，1200 是 4.6 倍冗余
- 1200 全量 172MB 超过 npm 包体积上限；转码后仅 ~10MB，可以发布
- 播放更省内存、切换更快

双轨设计：
- thumb（本脚本产物，360x360，step04）→ 同步进 npm 包 assets/thumb/，运行时播放
- full（step03 原始 1200x1200）→ 不进 npm 包，发布到 GitHub Releases 存档
"""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "step03"
OUT = ROOT / "step04"
# 统一使用工作区自带的 ffmpeg（素材处理链零第三方依赖）
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")

# 转码参数（调这里改画质/分辨率）
TARGET = 360   # thumb 画布边长（正方形，与 1200 母版同比例）
CRF = 40       # VP9 质量参数（0-63，越小越清晰越大；40 偏轻，透明区域省码）
FPS = 24       # 帧率（与母版一致，保持动作节奏）


def convert_video(src: Path, dst: Path) -> None:
    """转码单个视频。

    注意：
    - 解码端必须指定 -c:v libvpx-vp9（libvpx 解码才能保留 VP9 alpha，与
      normalize_step03.py 一致）；ffmpeg 自动选解码器会丢 alpha 导致黑底。
    - scale 滤镜默认也会丢 alpha，需 format=yuva420p 强制保留。
    """
    cmd = [
        FFMPEG,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-c:v",
        "libvpx-vp9",  # 关键：libvpx 解码才能保留 VP9 alpha
        "-i",
        str(src),
        "-vf",
        f"scale={TARGET}:{TARGET},format=yuva420p",
        "-c:v",
        "libvpx-vp9",  # VP9 编码（WebM 标准）
        "-crf",
        str(CRF),
        "-b:v",
        "0",  # 恒定质量模式（CRF）
        "-row-mt",
        "1",  # 多行并行（加速编码）
        "-r",
        str(FPS),
        "-an",  # 丢弃音轨（动画无声音，省体积）
        str(dst),
    ]
    result = subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())


def main() -> int:
    OUT.mkdir(exist_ok=True)
    videos = sorted(SRC.glob("*.webm"))
    if not videos:
        print(f"No WebM masters found in {SRC}")
        return 1

    src_total = 0
    out_total = 0
    for index, video in enumerate(videos, start=1):
        src_size = video.stat().st_size
        src_total += src_size
        dst = OUT / video.name

        convert_video(video, dst)
        out_size = dst.stat().st_size
        out_total += out_size
        print(f"[{index}/{len(videos)}] {video.name}  {src_size / 1e6:.1f}MB -> {out_size / 1e6:.1f}MB", flush=True)

    print(f"\n=== summary ===")
    print(f"masters: {len(videos)}")
    print(f"source total: {src_total / 1e6:.1f}MB")
    print(f"thumb total: {out_total / 1e6:.1f}MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
