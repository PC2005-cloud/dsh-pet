"""Generate animated GIF previews from thumbnails (assets/thumb -> assets/preview).

素材处理链的附属步骤：把插件实际播放的 360x360 透明 WebM（dsh-pet/assets/thumb/）
转成 GIF 预览（dsh-pet/assets/preview/），供 GitHub README 等 Markdown 页面展示。

为什么需要这一步：
- GitHub 的 Markdown 渲染器只为「网页端上传的附件」生成内联视频播放器；
  仓库内通过 <video> 引用的 webm 不会播放（raw 返回 audio/webm MIME）。
- 仓库内图片（含 GIF）用 Markdown 图片语法可以正常内联显示。
- 故 README 预览区用 GIF 演示，完整透明视频仍以 webm 形式保留在 assets/thumb/。

透明处理：GIF 支持 1bit 透明。源 webm 是透明背景，直接转 GIF 会把透明区域
转成黑色；本脚本用 palettegen/paletteuse 保留 alpha，透明部分在页面上显示为底色。

用法：
  python scripts/encode_preview_gifs.py          # 全部（按名称排序）
  python scripts/encode_preview_gifs.py 待机呼吸休闲  # 指定一个/多个
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "dsh-pet" / "assets" / "thumb"
OUT = ROOT / "dsh-pet" / "assets" / "preview"
# 统一使用工作区自带的 ffmpeg（素材处理链零第三方依赖）
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")

# GIF 参数（GIF 体积大，预览用低帧率 + 中等尺寸即可）
WIDTH = 220    # 预览宽度（保持宽高比）
FPS = 12       # 预览帧率（webm 24fps → 12fps，体积减半且足够流畅）


def convert_gif(name: str) -> Path:
    src = SRC / f"{name}.webm"
    if not src.exists():
        raise FileNotFoundError(f"{src} 不存在")
    dst = OUT / f"{name}.gif"
    # 调色板两遍法：先生成全局调色板，再按调色板转 GIF，保留 alpha
    cmd = [
        FFMPEG,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-c:v",
        "libvpx-vp9",  # 与 encode_thumbs.py 一致：libvpx 解码保留 VP9 alpha
        "-i",
        str(src),
        "-vf",
        (
            f"fps={FPS},scale={WIDTH}:-1:flags=lanczos,"
            "split[s0][s1];"
            "[s0]palettegen=stats_mode=diff[p];"
            "[s1][p]paletteuse=dither=bayer:diff_mode=rectangle"
        ),
        "-loop",
        "0",
        str(dst),
    ]
    result = subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return dst


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    names = sys.argv[1:] or sorted(p.stem for p in SRC.glob("*.webm"))
    total = 0
    for i, name in enumerate(names, start=1):
        try:
            dst = convert_gif(name)
            size = dst.stat().st_size
            total += size
            print(f"[{i}/{len(names)}] {name}.gif  {size / 1e6:.1f}MB", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[{i}/{len(names)}] {name}  FAIL: {exc}", flush=True)
            return 1
    print(f"\n=== summary ===")
    print(f"gifs: {len(names)}")
    print(f"preview total: {total / 1e6:.1f}MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
