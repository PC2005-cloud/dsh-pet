"""Unify character size across step02 videos into step03.

整帧等比缩放 + overlay 平移到 1200x1200 透明画布：
- 站立高度 700（按首尾站立帧的平均高度计算缩放比例）
- 水平居中，脚底对齐 y=1100（按全帧内容最低点对齐，保证动画不裁剪）
- 不裁剪人物/动作内容，底部超出的透明空白直接裁掉
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "step02"
OUT = ROOT / "step03"
# 统一使用工作区自带的 ffmpeg（素材处理链零第三方依赖）
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")

CANVAS_W = 1200
CANVAS_H = 1200
TARGET_HEIGHT = 900
FEET_Y = CANVAS_H - 100  # 距底 100

SRC_W = 810
SRC_H = 720
FPS = 24
HEAD_FRAMES = 5
TAIL_SEEK = -0.2  # 从末尾取帧，避免取到收尾动作

_BBOX_RE = re.compile(r"x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)")


def scan_bbox(video: Path, seek: float | None = None, frames: int | None = None) -> list[tuple[int, int, int, int]]:
    """用 alphaextract,bbox 滤镜扫描帧内容边界，返回 [(x1, x2, y1, y2)] 列表。"""
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "info", "-c:v", "libvpx-vp9"]
    if seek is not None:
        cmd += ["-sseof", str(seek)]
    cmd += ["-i", str(video)]
    if frames is not None:
        cmd += ["-frames:v", str(frames)]
    cmd += ["-vf", "alphaextract,bbox", "-f", "null", "-"]
    # text=True 时显式指定 UTF-8 解码（Windows 默认 GBK 会解不了 ffmpeg 的 UTF-8 输出）
    result = subprocess.run(cmd, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return [tuple(int(g) for g in m.groups()) for m in _BBOX_RE.finditer(result.stderr)]


def measure_standing(video: Path) -> dict:
    """首尾各 5 帧站立姿态的 (高度, 脚底 y, 中心 x) 平均值，作为缩放与对齐基准。"""
    boxes = scan_bbox(video, frames=HEAD_FRAMES) + scan_bbox(video, seek=TAIL_SEEK, frames=HEAD_FRAMES)
    if not boxes:
        raise RuntimeError(f"No opaque pixels found in {video.name}")
    return {
        "height": sum(y2 - y1 + 1 for _, _, y1, y2 in boxes) / len(boxes),
        "max_y": sum(y2 for _, _, _, y2 in boxes) / len(boxes),
        "center_x": sum((x1 + x2) / 2 for x1, x2, _, _ in boxes) / len(boxes),
    }


def measure_content_union(video: Path) -> tuple[int, int, int, int]:
    """全帧扫描内容范围并集 (x1, y1, x2, y2)，用于校验动画内容是否被裁。"""
    boxes = scan_bbox(video)
    if not boxes:
        raise RuntimeError(f"No opaque pixels found in {video.name}")
    return (
        min(b[0] for b in boxes),
        min(b[2] for b in boxes),
        max(b[1] for b in boxes),
        max(b[3] for b in boxes),
    )


def build_filter(scale: float, standing: dict) -> str:
    """整帧缩放 + overlay 平移到透明画布，站立中心 x=600、站立脚底 y=1100。"""
    scaled_w = int(SRC_W * scale) // 2 * 2
    scaled_h = int(SRC_H * scale) // 2 * 2
    overlay_x = CANVAS_W / 2 - standing["center_x"] * scale
    overlay_y = FEET_Y - standing["max_y"] * scale
    return (
        f"color=c=black@0:s={CANVAS_W}x{CANVAS_H}:r={FPS}[bg];"
        f"[0:v]scale={scaled_w}:{scaled_h}[sc];"
        f"[bg][sc]overlay={overlay_x:.1f}:{overlay_y:.1f}:shortest=1,format=yuva420p[v]"
    )


def convert_video(src: Path, dst: Path, filter_complex: str) -> None:
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
        "-filter_complex",
        filter_complex,
        "-map",
        "[v]",
        "-map",
        "0:a?",
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
    videos = sorted(SRC.glob("*.webm"))
    if not videos:
        print(f"No WebM files found in {SRC}")
        return 1

    payload = {"canvas": f"{CANVAS_W}x{CANVAS_H}", "target_height": TARGET_HEIGHT, "feet_y": FEET_Y, "videos": []}
    for index, video in enumerate(videos, start=1):
        dst = OUT / (video.stem + ".webm")
        # 断点续跑：输出已存在、非残缺（>50KB）、且不比源旧 → 跳过转码（支持被中断后增量续跑）；
        # 但跳过时仍做轻量测量（仅 bbox 扫描，不转码），保证 params.json 始终包含全部视频条目。
        if dst.exists() and dst.stat().st_size > 50_000 and dst.stat().st_mtime >= video.stat().st_mtime:
            standing = measure_standing(video)
            union = measure_content_union(video)
            scale = TARGET_HEIGHT / standing["height"]
            entry = {
                "file": video.name,
                "standing": {k: round(v, 1) for k, v in standing.items()},
                "content_union": {"x1": union[0], "y1": union[1], "x2": union[2], "y2": union[3]},
                "scale": round(scale, 6),
            }
            payload["videos"].append(entry)
            print(f"[{index}/{len(videos)}] SKIP {video.name} (already normalized)", flush=True)
            continue
        standing = measure_standing(video)
        union = measure_content_union(video)
        scale = TARGET_HEIGHT / standing["height"]
        filter_complex = build_filter(scale, standing)
        entry = {
            "file": video.name,
            "standing": {k: round(v, 1) for k, v in standing.items()},
            "content_union": {"x1": union[0], "y1": union[1], "x2": union[2], "y2": union[3]},
            "scale": round(scale, 6),
        }
        print(json.dumps({"video": entry, "filter": filter_complex, "output": dst.name}, ensure_ascii=False), flush=True)
        convert_video(video, dst, filter_complex)
        payload["videos"].append(entry)

    (OUT / "params.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
