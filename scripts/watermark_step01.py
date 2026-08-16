"""水印填充（step01）：video/*.mp4 → step01/*.mp4（水印像素用第5近背景色填充）

素材处理链第 1 步（替代原 crop_step01 的职责——去水印，且更精确）：
  video/（1280x720 原视频）→ 本脚本 → step01/（水印去除后的 1280x720）
  → chroma_step02.py（绿幕抠像）→ normalize_step03.py → encode_thumbs.py

方案（已验证）：
- mask：video/watermark_mask_v5.mkv（黑视频亮度>10 生成，覆盖淡入淡出水印）
- 取色：每个水印像素取第 5 近的"非水印像素"颜色（跳过紧贴的未标记水印字空洞）
- 输出：libx264 crf18 yuv420p，与原视频同尺寸/帧率，供 chromakey 抠像

并发：PARALLEL 个视频同时处理（每视频独立 Python 进程 + 3 个 ffmpeg 子进程）。
"""
from __future__ import annotations

import re
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "video"
OUT = ROOT / "step01"
MASK = SRC / "watermark_mask_v5.mkv"
K = 5
PARALLEL = 4
# 统一使用工作区自带的 ffmpeg（素材处理链零第三方依赖）
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")
FFPROBE = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffprobe.exe")
sys.path.insert(0, str(ROOT / "scripts"))
from fill_nn import fill_nn  # noqa: E402


def duration(video: Path) -> int:
    r = subprocess.run([FFMPEG, "-i", str(video), "-f", "null", "-"],
                       capture_output=True, text=True, errors="replace")
    m = re.findall(r"Duration:\s*(\d+):(\d+):(\d+)\.(\d+)", r.stderr)
    if not m:
        return 10
    h, mi, s, cs = map(int, m[0])
    return max(1, h * 3600 + mi * 60 + s + (1 if cs else 0))


def _is_valid(dst: Path, src: Path, min_size: int = 50_000) -> bool:
    """断点续跑完整性检查：存在、够大、不比源旧、且能被 ffprobe 读到视频流。

    ffprobe 验证防止"中断时正在写、大小看似足够但已损坏"的文件被误判为已完成。
    """
    if not dst.exists() or dst.stat().st_size <= min_size:
        return False
    if dst.stat().st_mtime < src.stat().st_mtime:
        return False
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_name",
                        "-of", "csv=p=0", str(dst)], capture_output=True)
    return bool(r.stdout.strip())


def _process_one(video: Path) -> tuple[str, str]:
    """处理单个视频（worker 函数，必须模块级以支持 Windows spawn）。"""
    dst = OUT / video.name
    if _is_valid(dst, video):
        return video.name, "SKIP"
    rc = fill_nn(video, MASK, dst, duration(video), K)
    return video.name, "OK" if rc == 0 else f"FAIL rc={rc}"


def main() -> int:
    OUT.mkdir(exist_ok=True)
    videos = sorted(SRC.glob("*.mp4"))
    if not videos:
        print(f"No MP4 files found in {SRC}")
        return 1
    if not MASK.exists():
        print(f"Missing mask: {MASK}")
        return 1

    total = len(videos)
    with ProcessPoolExecutor(max_workers=PARALLEL) as ex:
        for index, (name, status) in enumerate(ex.map(_process_one, videos), start=1):
            print(f"[{index}/{total}] {name} {status}", flush=True)

    print(f"Done. {total} videos written to {OUT} (parallel={PARALLEL})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
