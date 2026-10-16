"""Import hand-keyed MOV files from pr/ and write transparent WebM into step02/.

针对自动绿幕抠像（chroma_step02.py）对「包含第三方物品」的动作效果不佳的情况：
用户在 PR 里手动抠像，导出携带 alpha 通道的 .mov。本脚本直接用 ffmpeg 把这批
mov 转成透明 webm，写入 step02/，覆盖该动作此前的自动抠像结果。之后继续走
normalize_step03.py → encode_thumbs.py，整条素材链其余环节不变。

使用：
  1. 把 PR 导出的透明 mov 放进 pr/，文件名与动作名一致（如 吃汤圆.mov）。
  2. 运行 `python pr_import_step02.py` → 生成 step02/吃汤圆.webm。
  3. 接着跑 normalize_step03.py、encode_thumbs.py（增量：本动作重做，其余 SKIP）。
  4. 把 step04 结果同步到 dsh-pet/assets/thumb/。

注意：
  - mov 必须携带 alpha 通道（如 ProRes 4444 with alpha，或 PNG 序列封装），
    ffmpeg 解码端才能读回透明；否则输出为不透明。
  - 转换参数按用户指定：-c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 32 -an。
"""

from __future__ import annotations

import subprocess
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "pr"                    # PR 扣好的透明 mov
OUT = ROOT / "step02"                # 直接覆盖 step02（等价于 chroma_step02 产物）
# 统一使用工作区自带的 ffmpeg（素材处理链零第三方依赖）
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")
FFPROBE = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffprobe.exe")

PARALLEL = 4
# 转码参数（用户指定：VP9 + 透明 + 恒定质量 CRF32）
CRF = 32       # VP9 恒定质量参数（0-63，越小越清晰越大）


def _mov_files() -> list[Path]:
    """收集 pr/ 下的 mov（大小写不敏感），按名排序，保持稳定顺序。"""
    return sorted(p for p in SRC.iterdir() if p.suffix.lower() == ".mov")


def convert_video(src: Path, dst: Path) -> None:
    """把带 alpha 的 mov 转码为透明 VP9 webm（保持原始分辨率，不做缩放）。

    注意：
    - 解码端不做强制指定：PR 导出的 mov 自带 alpha（ProRes/PNG 封装），ffmpeg
      自动解码器能读回 rgba；若源不含 alpha 则结果不透明（见模块 docstring）。
    - 编码端必须 -c:v libvpx-vp9 + -pix_fmt yuva420p 才能把 alpha 写进 WebM。
    """
    cmd = [
        FFMPEG,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-c:v",
        "libvpx-vp9",   # VP9 编码（WebM 标准，支持 alpha）
        "-pix_fmt",
        "yuva420p",     # 强制 4:2:0 + alpha 平面
        "-b:v",
        "0",            # 恒定质量模式（CRF）
        "-crf",
        str(CRF),
        "-row-mt",
        "1",            # 多行并行（加速编码）
        "-an",          # 丢弃音轨（动画无声音，省体积）
        str(dst),
    ]
    result = subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())


def _is_valid(dst: Path, src: Path, min_size: int = 20_000) -> bool:
    """断点续跑完整性检查：存在、够大、不比源旧、且能被 ffprobe 读到视频流。"""
    if not dst.exists() or dst.stat().st_size <= min_size:
        return False
    if dst.stat().st_mtime < src.stat().st_mtime:
        return False
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_name",
                        "-of", "csv=p=0", str(dst)], capture_output=True)
    return bool(r.stdout.strip())


def _process_one(video: Path) -> tuple[str, int, int, bool]:
    """处理单个 mov（worker 函数，必须模块级以支持 Windows spawn）。"""
    src_size = video.stat().st_size
    dst = OUT / (video.stem + ".webm")
    if _is_valid(dst, video):
        return video.name, src_size, 0, True
    convert_video(video, dst)
    return video.name, src_size, dst.stat().st_size, False


def main() -> int:
    OUT.mkdir(exist_ok=True)
    videos = _mov_files()
    if not videos:
        print(f"No MOV files found in {SRC}")
        return 1

    src_total = 0
    out_total = 0
    total = len(videos)
    with ProcessPoolExecutor(max_workers=PARALLEL) as ex:
        for index, (name, src_size, out_size, skipped) in enumerate(ex.map(_process_one, videos), start=1):
            src_total += src_size
            out_total += out_size
            if skipped:
                print(f"[{index}/{total}] SKIP {name} (already in step02)", flush=True)
            else:
                print(f"[{index}/{total}] {name}  {src_size / 1e6:.1f}MB -> {out_size / 1e6:.1f}MB", flush=True)

    print(f"\n=== summary ===")
    print(f"mov imported: {total}")
    print(f"source total: {src_total / 1e6:.1f}MB")
    print(f"step02 total: {out_total / 1e6:.1f}MB")
    print("接下来跑 normalize_step03.py 和 encode_thumbs.py，再把 step04 同步到 assets/thumb/。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
