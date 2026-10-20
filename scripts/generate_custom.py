#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通用动作视频生成脚本（云端 V100 适用）：从提示词文档提取动作 → VACE 参考图 → 720P / 10s / 16:9 绿幕源片。

与 generate.py 的区别：
  • 动作不再硬编码——--titles 从提示词文档按标题提取段落做 prompt（正文含按秒分镜与最终帧要求）
  • 内置全量前置检查（--check 只体检不生成）：依赖 / GPU / 磁盘 / 模型缓存 / 参考图 / 文档标题
  • V100 等老卡（compute capability < 8.0）自动 bf16 → fp16，杜绝精度报错
  • 模型仍只从 ModelScope 下载（不碰 HuggingFace），下载后校验关键文件完整性

云端用法（Linux，脚本 / 参考图 / 提示词文档放同一目录）：
  # ① 体检（只检查不下载不生成）——先跑这个，把输出贴回来
  python generate_custom.py --check

  # ② 单条试跑（确认效果再放量；--steps 30 快速档）
  python generate_custom.py --titles "吐泡泡" --steps 30

  # ③ 多条正式生成（模型缓存建议落数据盘）
  python generate_custom.py --titles "吐泡泡,原地小憩" --cache-dir /mnt/data/models

  # 显存紧张时降档：--width 832 --height 480 或 --num-frames 81（5 秒）

规格：默认 1280x720（720P）、161 帧 @16fps ≈ 10.06 秒、16:9。
宽高必须为 16 的倍数；帧数必须满足 4k+1。
断点续跑：输出目录同名 mp4 已存在且 >20KB 自动跳过；单条失败不影响其余。
"""

from __future__ import annotations

import os

# 必须在 import 任何第三方库之前设置：
# modelscope 会间接 import TensorFlow，TF 默认预占整卡显存，导致 torch 连 20MB 都分不到
# （权重常驻模式下 pipe.to("cuda") 直接 OOM）。ALLOW_GROWTH 让 TF 按需少量分配。
os.environ.setdefault("TF_FORCE_GPU_ALLOW_GROWTH", "true")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import argparse
import importlib
import importlib.metadata as importlib_meta
import re
import shutil
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# ---------------------------------------------------------------- 路径与常量

ROOT = Path(__file__).resolve().parent          # 云端约定：脚本/参考图/文档同目录
OUT_DIR = ROOT / "video"
DEFAULT_REF = ROOT / "ref.png"
DEFAULT_DOC = ROOT / "桌面宠物 10 秒动作提示词.md"
DEFAULT_MODEL = "Wan-AI/Wan2.1-VACE-1.3B-diffusers"
FPS = 16                                        # 81 帧 ≈ 5.06s / 161 帧 ≈ 10.06s

# 必需依赖 + 最低版本（版本不足视为"未就绪"，体检阶段就拦截）
# 兼容矩阵（实测）：
#   • torch 2.3.1 + diffusers 0.34.0 + transformers 4.55.4：import 全通过、可加载推理（已验证）
#   • diffusers 0.35+ 调用 torch.accelerator（torch 2.7 才有），torch<2.6 直接 import 炸
#   • 最新 diffusers 依赖 transformers 5.x（需 torch>=2.6），与 torch 2.3.1 路线 ResolutionImpossible
#   • diffusers 0.34 的 fp16 sequential offload 钩子有 dtype bug → torch<2.6 时自动改常驻显存
#   • transformers 5.x 要求 torch >= 2.6
REQUIRED_DEPS: dict[str, str | None] = {
    "torch":          "2.1",
    "diffusers":       "0.33",
    "transformers":    "4.36",
    "accelerate":      None,
    "modelscope":      None,
    "ftfy":            None,
    "pillow":          None,
    "imageio":         None,
    "imageio-ffmpeg":  None,
    "einops":          None,
}

# 跨包兼容性约束：当 when 条件满足时，package 必须满足 then 约束
COMPAT_RULES: list[dict] = [
    {
        "package": "diffusers",
        "when": {"pkg": "torch", "op": "<", "ver": "2.6"},
        "then":  {"op": "<", "ver": "0.35", "reason": "diffusers 0.35+ 需要 torch.accelerator（torch 2.7+）"},
    },
    {
        "package": "transformers",
        "when": {"pkg": "torch", "op": "<", "ver": "2.6"},
        "then":  {"op": "<", "ver": "5.0", "reason": "transformers 5.x 要求 torch >= 2.6"},
    },
]

# ---------------------------------------------------------------- 提示词公共段（与 generate.py 保持一致）

CHARACTER = (
    "角色（外观必须完全继承参考图）："
    "Q版手绘卡通小女孩，约三头身比例，棕色长直发、整齐齐刘海，棕褐色大眼睛，皮肤白皙，脸颊微红；"
    "身穿白色露肩宽松长袖毛衣（衣身布满均匀的黑色细横条纹）、"
    "黑色毛边短裤（裤身有白色小猫布贴图案和白色手写涂鸦）、白色短袜、黑白低帮帆布鞋。"
    "她没有呆毛、没有兽耳、没有任何尾巴，不穿女仆装，没有围裙和裙摆。"
)

CAMERA_RULES = (
    "镜头与画面（最高优先级，必须严格遵守）："
    "16:9横屏；单一固定机位、定焦、平视中景，全程严禁任何推拉摇移、缩放、旋转、抖动、运镜或镜头切换，"
    "构图从头到尾完全不变；"
    "背景是纯净、均匀、平整的标准绿幕色（饱和的 Chroma Key Green 纯绿），"
    "全片绿色色值完全一致，无杂物、无家具、无阴影、无渐变、无边框、无地面透视；"
    "女孩始终位于画面水平正中，双脚并拢锚定在同一个落点（脚底约在画面83%高度、头顶约22%高度），"
    "全身完整入镜；全程只允许原地的上半身与手脚动作，严禁任何水平或纵深方向的位移；"
    "手、脚、头发、衣角、道具、特效的最高点/最外点距画面任一边缘至少10%安全距离，不得出画或被裁切；"
    "开场第一帧和最后一帧都是干净的标准正面站立（双脚并拢、双臂自然垂于身侧、目光平视、表情平和，"
    "没有任何道具与特效）；道具、卡片、气泡、光点一律由角色以魔法手势从无到有凝聚出现，"
    "结束前化为光点消散，首尾绝不残留；"
    "整体为Q版手绘动画风格，黑色干净描边，平涂色彩，动作自然流畅、节奏轻快。"
)

END_FRONT = (
    "第10秒结束时必须彻底恢复为与开场第一帧完全一致的标准正面站立："
    "双脚并拢、双臂自然垂于身侧、目光平视前方、表情平和，"
    "画面中没有任何道具、卡片、气泡、星星、汗珠或线条残留。"
)

NEGATIVE_PROMPT = (
    "Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, "
    "images, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, "
    "extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, "
    "fused fingers, still picture, messy background, three legs, many people in the background, "
    "walking backwards, camera movement, zoom in, zoom out, panning, tilting, rotating camera, "
    "close-up, wide shot, scene change, two girls, multiple characters, "
    "ahoge, animal ears, tail, fins, maid outfit, frilled apron, long dress, skirt, watermark, "
    "text, logo, border, "
    "镜头移动, 推拉摇移, 缩放, 旋转画面, 特写, 远景切换, 场景切换, 多人, 两个女孩, "
    "呆毛, 头顶翘起的呆毛, 兽耳, 尾巴, 鱼鳍, 女仆装, 围裙, 长裙, 裙摆, 水印, 字幕, 文字, 边框"
)

# ---------------------------------------------------------------- 前置检查

DEP_IMPORT_NAMES = {"pillow": "PIL", "imageio-ffmpeg": "imageio_ffmpeg"}


def _parse_ver(s: str) -> tuple[int, ...]:
    """把 '2.3.1' 解析成 (2, 3, 1)，越界补 0，便于 tuple 比较。"""
    parts = []
    for p in s.replace("-", ".").split("."):
        try:
            parts.append(int(p))
        except ValueError:
            break
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def dep_status() -> tuple[list[tuple[str, str, str, str | None]], list[str], list[str]]:
    """逐个 import + 版本下限检查 + 跨包兼容性检查。

    返回 ([(名称, 版本, 状态, 最低版本)], 缺失清单, 需升级/降级清单)。
    状态：OK / MISS / UPGRADE / DOWNGRADE（兼容性强制降级）
    """
    results: list[tuple[str, str, str, str | None]] = []
    missing: list[str] = []
    need_fix: list[str] = []           # 需升级或降级的包（统一走 pip -U）
    pkg_ver: dict[str, str] = {}        # 已安装包版本映射（供兼容性检查）
    for name, min_ver in REQUIRED_DEPS.items():
        mod = DEP_IMPORT_NAMES.get(name, name.replace("-", "_"))
        try:
            importlib.import_module(mod)
        except Exception:
            missing.append(name)
            results.append((name, "-", "MISS", min_ver))
            continue
        try:
            ver = importlib_meta.version(name)
        except Exception:
            ver = "?"
        pkg_ver[name] = ver
        if min_ver is not None and _parse_ver(ver) < _parse_ver(min_ver):
            need_fix.append(name)
            results.append((name, ver, "UPGRADE", min_ver))
        else:
            results.append((name, ver, "OK", min_ver))

    # 跨包兼容性检查
    for rule in COMPAT_RULES:
        pkg = rule["package"]
        if pkg in missing or pkg not in pkg_ver:
            continue
        when = rule["when"]
        when_pkg = when["pkg"]
        if when_pkg in missing or when_pkg not in pkg_ver:
            continue
        when_ver = pkg_ver[when_pkg]
        when_ok = (
            (when["op"] == "<" and _parse_ver(when_ver) < _parse_ver(when["ver"]))
            or (when["op"] == "<=" and _parse_ver(when_ver) <= _parse_ver(when["ver"]))
            or (when["op"] == ">=" and _parse_ver(when_ver) >= _parse_ver(when["ver"]))
            or (when["op"] == ">" and _parse_ver(when_ver) > _parse_ver(when["ver"]))
        )
        if not when_ok:
            continue
        # 触发条件满足，检查 then 约束
        then = rule["then"]
        cur_ver = pkg_ver[pkg]
        then_ok = (
            (then["op"] == "<" and _parse_ver(cur_ver) < _parse_ver(then["ver"]))
            or (then["op"] == "<=" and _parse_ver(cur_ver) <= _parse_ver(then["ver"]))
            or (then["op"] == ">=" and _parse_ver(cur_ver) >= _parse_ver(then["ver"]))
            or (then["op"] == ">" and _parse_ver(cur_ver) > _parse_ver(then["ver"]))
        )
        if not then_ok:
            # 兼容性违规 → 标记为 DOWNGRADE
            need_fix.append(pkg)
            new_results: list[tuple[str, str, str, str | None]] = []
            for name2, ver2, status2, min_ver2 in results:
                if name2 == pkg:
                    new_results.append((pkg, cur_ver, "DOWNGRADE", f"{then['op']}{then['ver']} ({then['reason']})"))
                else:
                    new_results.append((name2, ver2, status2, min_ver2))
            results = new_results

    return results, missing, need_fix


def pip_spec(name: str) -> str:
    """生成 pip 安装包名+版本约束字符串（考虑 REQUIRED_DEPS 最低版本 + COMPAT_RULES 上限）。"""
    min_v = REQUIRED_DEPS.get(name)
    spec = name
    if min_v:
        spec += f">={min_v}"
    # 查 COMPAT_RULES 里对该包的上限约束
    for rule in COMPAT_RULES:
        if rule["package"] != name:
            continue
        when = rule["when"]
        # 只有当触发条件满足时才加上限（但在 dep_status 之后调用时，调用方已知 need_fix 里有它）
        spec += f",{rule['then']['op']}{rule['then']['ver']}"
        break
    return spec


def pip_install_cmd(pkgs: list[str], force_torch: bool = False) -> str:
    """生成 pip install -U 命令。

    版本约束必须带引号——bash 会把 >=/< 解析成重定向符导致命令失败或静默跑偏。
    统一 -U：对缺失包等价于安装，对降级/升级必需。
    """
    if not pkgs:
        return ""
    torch_first = ""
    if "torch" in pkgs:
        torch_first = f'"{pip_spec("torch")}" --index-url https://download.pytorch.org/whl/cu124 '
    rest = [p for p in pkgs if p != "torch"]
    rest_str = " ".join(f'"{pip_spec(p)}"' for p in rest)
    return f"pip install -U {torch_first}{rest_str}".strip()


def check_gpu() -> tuple[str, float, tuple[int, int]]:
    """CUDA 可用性检查，返回 (GPU名, 显存GB, compute capability)。"""
    import torch
    if not torch.cuda.is_available():
        sys.exit(
            "[环境错误] 未检测到可用 CUDA。请确认：\n"
            "  1) nvidia-smi 驱动正常；\n"
            "  2) 安装 CUDA 版 PyTorch：pip install torch --index-url https://download.pytorch.org/whl/cu124"
        )
    prop = torch.cuda.get_device_properties(0)
    cc = (prop.major, prop.minor)
    return prop.name, prop.total_memory / 1e9, cc


def check_disk(path: Path, need_gb: float) -> float:
    """磁盘剩余空间检查，返回剩余 GB。"""
    free_gb = shutil.disk_usage(path).free / 1e9
    if free_gb < need_gb:
        sys.exit(f"[错误] {path} 剩余 {free_gb:.1f}GB，不足所需 {need_gb}GB（换大盘或清理后重试）")
    return free_gb


def verify_model_dir(path: Path) -> None:
    """模型目录完整性校验：关键文件/目录存在才算下载成功。"""
    missing = [str(m.relative_to(path)) for m in
               (path / "model_index.json", path / "transformer", path / "vae") if not m.exists()]
    if missing:
        sys.exit(f"[错误] 模型目录不完整（缺 {missing}）：{path}\n"
                 f"      删除该目录后重新运行即可重新下载。")


def resolve_model_path(model_ref: str, cache_dir: str, need_gb: float = 25.0) -> Path:
    """本地路径直接用（校验完整性）；ModelScope 仓库 ID 则 snapshot_download 后校验。"""
    if model_ref.startswith(("/", "./", "~")) or (os.name == "nt" and re.match(r"^[A-Za-z]:\\", model_ref)):
        local = Path(model_ref).expanduser().resolve()
        if not local.exists():
            sys.exit(f"[错误] 指定的本地模型路径不存在：{local}")
        print(f"[模型] 使用本地目录：{local}", flush=True)
        verify_model_dir(local)
        return local
    try:
        from modelscope import snapshot_download
    except ImportError:
        sys.exit("[错误] 缺少 modelscope，无法从 ModelScope 下载：pip install modelscope")
    check_disk(Path(cache_dir).expanduser() if cache_dir else Path.home(), need_gb)
    print(f"[模型] 从 ModelScope 下载：{model_ref}（首次约十几 GB，落盘到 "
          f"{cache_dir or '~/.cache/modelscope/hub'}）", flush=True)
    local = Path(snapshot_download(model_id=model_ref, cache_dir=cache_dir or None))
    verify_model_dir(local)
    print(f"[模型] 下载完成并校验通过：{local}", flush=True)
    return local


# ---------------------------------------------------------------- 提示词文档解析

def parse_doc_sections(doc: Path) -> dict[str, str]:
    """按 '## 标题' 切分文档，清洗 markdown 符号，返回 {标题: 正文}。"""
    text = doc.read_text(encoding="utf-8")
    sections: dict[str, str] = {}
    for part in re.split(r"^## ", text, flags=re.M)[1:]:
        lines = part.splitlines()
        title = lines[0].strip()
        body = "\n".join(lines[1:])
        body = body.replace("**", "")
        body = re.sub(r"^>\s?", "", body, flags=re.M)
        sections[title] = body.strip()
    return sections


def pick_sections(sections: dict[str, str], titles: str) -> list[tuple[str, str]]:
    """按子串匹配标题挑段落；空正文/未命中直接报错列出可选项。"""
    keys = [k.strip() for k in titles.split(",") if k.strip()]
    picked: list[tuple[str, str]] = []
    for key in keys:
        hits = [(t, b) for t, b in sections.items() if key in t]
        if not hits:
            sys.exit(f"[错误] 「{key}」未命中任何标题。可用标题：\n  " + "\n  ".join(sections))
        for t, b in hits:
            if len(b) < 50:
                sys.exit(f"[错误] 「{t}」正文过短（{len(b)} 字符），疑似分类标题而非动作段，请换更精确的标题")
            picked.append((t, b))
    return picked


def build_prompt(section_body: str) -> str:
    """公共段 + 动作正文；正文已含最终帧/结束状态时不再追加 END_FRONT。"""
    tail = "" if ("最终帧" in section_body or "动作结束后状态" in section_body) else "\n" + END_FRONT
    return f"{CHARACTER}\n{CAMERA_RULES}\n{section_body}{tail}"


# ---------------------------------------------------------------- 推理

def load_pipeline(local_path: Path, dtype_name: str, no_offload: bool):
    import torch
    from diffusers import WanVACEPipeline
    dtype = torch.bfloat16 if dtype_name == "bf16" else torch.float16
    print(f"[加载模型] WanVACEPipeline ← {local_path}（{dtype_name}） ...", flush=True)
    pipe = WanVACEPipeline.from_pretrained(str(local_path), torch_dtype=dtype)
    if no_offload:
        pipe.to("cuda")
        print("[显存策略] 全部权重常驻 CUDA（--no-offload）", flush=True)
    else:
        pipe.enable_sequential_cpu_offload()
        pipe.enable_attention_slicing("auto")
        if hasattr(pipe, "enable_vae_slicing"):
            pipe.enable_vae_slicing()
        print("[显存策略] sequential offload + attention slicing + VAE slicing", flush=True)
    if hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
        print("[显存策略] VAE tiling 已开启", flush=True)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    pipe.set_progress_bar_config(disable=True)
    return pipe


def make_step_printer(tag: str, total: int):
    def callback(_pipe, step: int, _timestep, _kwargs):
        if step % 10 == 0 or step == total - 1:
            print(f"  [{tag}] 去噪 {step + 1}/{total}", flush=True)
        return _kwargs  # diffusers 要求回调必须返回 kwargs 字典
    return callback


# ---------------------------------------------------------------- 参数

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="通用动作生成（VACE 参考图 / ModelScope / 全量前置检查）")
    p.add_argument("--check", action="store_true", help="只做环境与资源体检，不下载模型、不生成")
    p.add_argument("--titles", default="", help="动作标题（提示词文档 ## 标题，子串匹配，逗号分隔多选）")
    p.add_argument("--doc", default=str(DEFAULT_DOC), help=f"提示词文档路径（默认 {DEFAULT_DOC.name}）")
    p.add_argument("--reference-image", default=str(DEFAULT_REF), help=f"参考图路径（默认 {DEFAULT_REF.name}）")
    p.add_argument("--out", default=str(OUT_DIR), help="输出目录（默认 ./video）")
    p.add_argument("--model", default=DEFAULT_MODEL, help="ModelScope 仓库 ID 或本地模型目录")
    p.add_argument("--cache-dir", default="", help="ModelScope 缓存目录（建议数据盘，如 /mnt/data/models）")
    p.add_argument("--width", type=int, default=1280, help="宽（默认 1280=720P，16 的倍数）")
    p.add_argument("--height", type=int, default=720, help="高（默认 720=720P，16 的倍数）")
    p.add_argument("--num-frames", type=int, default=161, help="帧数 4k+1（161≈10s / 81≈5s @16fps）")
    p.add_argument("--steps", type=int, default=50, help="去噪步数（默认 50，快速档 30）")
    p.add_argument("--guidance", type=float, default=5.0, help="CFG 引导强度")
    p.add_argument("--seed", type=int, default=20261016, help="基础随机种子（每动作 +序号）")
    p.add_argument("--dtype", choices=("bf16", "fp16"), default="bf16",
                   help="推理精度（V100 等老卡自动降为 fp16，无需手动指定）")
    p.add_argument("--no-offload", action="store_true", help="权重全程常驻显存（更快更吃显存）")
    p.add_argument("--cpu-threads", type=int, default=min(8, os.cpu_count() or 8))
    return p.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.width % 16 or args.height % 16:
        sys.exit(f"[错误] --width/--height 必须是 16 的倍数，当前 {args.width}x{args.height}")
    if (args.num_frames - 1) % 4:
        sys.exit(f"[错误] --num-frames 必须满足 4k+1（81/121/161），当前 {args.num_frames}")
    if args.steps <= 0 or args.guidance <= 0:
        sys.exit("[错误] --steps/--guidance 必须为正数")


# ---------------------------------------------------------------- 体检模式

def run_check(args: argparse.Namespace) -> int:
    print("=" * 24, "环境体检（只读，不改动任何资源）", "=" * 24, flush=True)
    print(f"[Python] {sys.version.split()[0]}（{sys.executable}）")

    deps, missing, need_fix = dep_status()
    ready = len(deps) - len(missing) - len(need_fix)
    print(f"[依赖] {ready}/{len(deps)} 就绪 （{len(missing)} 缺失 / {len(need_fix)} 需修复）")
    for name, ver, status, min_ver in deps:
        if status == "OK":
            mark, tag = "  OK   ", ""
        elif status == "UPGRADE":
            mark, tag = "  UPG  ", f"  (需 >= {min_ver})"
        elif status == "DOWNGRADE":
            mark, tag = "  COMPAT", f"  {min_ver}"
        else:
            mark, tag = "  MISS ", f"  (需 >= {min_ver})"
        print(f"  {mark} {name:14s} {ver}{tag}")
    action_pkgs = missing + need_fix
    if action_pkgs:
        print(f"\n[依赖修复] 请先执行：\n  {pip_install_cmd(action_pkgs, force_torch='torch' in action_pkgs)}")
        if "diffusers" in need_fix or "diffusers" in missing:
            print("  ⚠️ diffusers < 0.41 已知 fp16 sequential offload 有 dtype 钩子 bug，务必升级")
        if "transformers" in need_fix:
            print("  ⚠️ transformers 5.x 已禁用 torch < 2.6 的支持，必须降到 4.x")
        if "ftfy" in missing:
            print("  ⚠️ ftfy 缺失曾导致运行时 NameError，务必安装")

    try:
        name, vram, cc = check_gpu()
        print(f"[GPU] {name} / {vram:.1f}GB / compute capability {cc[0]}.{cc[1]}")
        if cc[0] < 8:
            print("  ℹ️ 该卡不支持 bf16，正式运行将自动使用 fp16（V100 实测可用）")
    except ImportError:
        print("[GPU] torch 未安装，跳过（先补依赖）")
    except SystemExit as exc:
        print(str(exc))

    for label, path, need in [("工作目录", ROOT, 5.0),
                              ("模型缓存", Path(args.cache_dir).expanduser() if args.cache_dir else Path.home(), 25.0)]:
        try:
            print(f"[磁盘] {label} {path}：剩余 {shutil.disk_usage(path).free / 1e9:.1f}GB"
                  f"（模型下载需 ≥{need:.0f}GB）")
        except Exception as exc:
            print(f"[磁盘] {label} {path}：检查失败 {exc}")

    ref = Path(args.reference_image).expanduser()
    if ref.is_file():
        from PIL import Image
        with Image.open(ref) as im:
            print(f"[参考图] {ref} 存在（{im.size[0]}x{im.size[1]}，{ref.stat().st_size / 1e3:.0f}KB）")
    else:
        print(f"[参考图] ⚠️ 不存在：{ref}（请上传 scripts/ref.png）")

    doc = Path(args.doc).expanduser()
    if doc.is_file():
        sections = parse_doc_sections(doc)
        print(f"[文档] {doc} 存在，共 {len(sections)} 个标题段")
        for t in sections:
            print(f"    - {t}")
        if args.titles.strip():
            picked = pick_sections(sections, args.titles)
            print(f"[匹配] --titles 命中 {len(picked)} 段：")
            for t, b in picked:
                head = b[:60].replace("\n", " ")
                print(f"    ✅ {t}（{len(b)} 字符）{head}...")
    else:
        print(f"[文档] ⚠️ 不存在：{doc}（请上传 prompts/桌面宠物 10 秒动作提示词.md）")

    model_ref = args.model
    local = Path(model_ref).expanduser()
    if local.exists() and local.is_dir():
        print(f"[模型] 本地目录已存在：{local}")
        try:
            verify_model_dir(local)
            print("       完整性校验通过（无需重新下载）")
        except SystemExit as exc:
            print(f"       ⚠️ {exc}")
    else:
        print(f"[模型] 将从 ModelScope 下载：{model_ref}（--check 模式不执行下载）")

    print("=" * 30, "体检结束", "=" * 30, flush=True)
    return 0


# ---------------------------------------------------------------- 主流程

def main() -> int:
    args = parse_args()
    if args.check:
        return run_check(args)
    validate_args(args)

    # 1. 资源检查先行：文档与标题（避免白下模型后才报错）
    doc = Path(args.doc).expanduser()
    if not doc.is_file():
        sys.exit(f"[错误] 提示词文档不存在：{doc}")
    sections = parse_doc_sections(doc)
    picked = pick_sections(sections, args.titles) if args.titles.strip() else sys.exit(
        "[错误] 请用 --titles 指定动作标题（多个用英文逗号分隔）。可先跑 --check 查看全部标题")
    print(f"[动作] 计划生成 {len(picked)} 条：{[t for t, _ in picked]}", flush=True)

    # 2. 参考图检查
    ref = Path(args.reference_image).expanduser()
    if not ref.is_file():
        sys.exit(f"[错误] 参考图不存在：{ref}（请上传 scripts/ref.png）")

    # 3. 依赖检查（版本不足 + 跨包兼容性一起拦截）
    _, missing, need_fix = dep_status()
    action_pkgs = missing + need_fix
    if action_pkgs:
        sys.exit(f"[错误] 依赖未就绪（缺失 {missing} / 需修复 {need_fix}），请先执行：\n"
                 f"  {pip_install_cmd(action_pkgs, force_torch='torch' in action_pkgs)}")

    # 4. GPU 检查 + 老卡自动 fp16
    import torch
    gpu_name, vram, cc = check_gpu()
    # bf16 有两类不可用：① 硬件不支持（cc<8）；② 旧版 diffusers 对 bf16 的 dtype 传播不完整
    if args.dtype == "bf16":
        dv_pre = importlib_meta.version("diffusers")
        if cc[0] < 8:
            print(f"[精度] {gpu_name}（cc {cc[0]}.{cc[1]}）不支持 bf16，自动降级 fp16", flush=True)
            args.dtype = "fp16"
        elif _parse_ver(dv_pre) < _parse_ver("0.35"):
            print(f"[精度] diffusers {dv_pre} 对 bf16 的 dtype 传播不完整（权重 half、输入 float32），"
                  f"自动降级 fp16", flush=True)
            args.dtype = "fp16"
    torch.set_num_threads(args.cpu_threads)
    print(f"[环境] GPU：{gpu_name} / {vram:.1f}GB", flush=True)
    print(f"[参考图] {ref}（仅约束外观，视频首帧由 prompt 自由决定）", flush=True)
    print(f"[参数] {args.width}x{args.height} / {args.num_frames}帧 / {FPS}fps / "
          f"{args.steps}步 / guidance={args.guidance}", flush=True)

    # 5. 模型下载/校验
    local_model = resolve_model_path(args.model, args.cache_dir)

    # 6. 加载 pipeline 与参考图
    #    旧版 diffusers（<0.35）的 fp16 sequential offload 钩子有 dtype bug
    #    （Input type float vs bias c10::Half，已在 V100 实测复现），自动改权重常驻绕开
    if not args.no_offload:
        dv = importlib_meta.version("diffusers")
        if _parse_ver(dv) < _parse_ver("0.35"):
            args.no_offload = True
            print(f"[显存策略] diffusers {dv} 的 fp16 offload 钩子有 dtype bug，自动改为权重常驻"
                  f"（若 720P 显存不足请降 --width 832 --height 480）", flush=True)
    pipe = load_pipeline(local_model, args.dtype, args.no_offload)
    from PIL import Image
    ref_pil = Image.open(ref).convert("RGB")
    print(f"[参考图] 尺寸 {ref_pil.size[0]}x{ref_pil.size[1]}（管线内部等比缩放居中）", flush=True)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    done: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []
    encoder_pool = ThreadPoolExecutor(max_workers=2)
    encode_futures: list[tuple[str, ...]] = []
    encode_lock = threading.Lock()

    total = len(picked)
    for index, (name, body) in enumerate(picked, start=1):
        dest = out_dir / f"{name}.mp4"
        tag = f"{index}/{total} {name}"
        if dest.exists() and dest.stat().st_size > 20_000:
            print(f"[{tag}] SKIP（已存在，断点续跑）", flush=True)
            skipped.append(name)
            continue
        seed = args.seed + index
        print(f"[{tag}] 开始生成 seed={seed}", flush=True)
        try:
            generator = torch.Generator(device="cpu").manual_seed(seed)
            result = pipe(
                prompt=build_prompt(body),
                negative_prompt=NEGATIVE_PROMPT,
                reference_images=[ref_pil],       # VACE 参考图：外观约束、不锁首帧
                conditioning_scale=1.0,
                width=args.width,
                height=args.height,
                num_frames=args.num_frames,
                num_inference_steps=args.steps,
                guidance_scale=args.guidance,
                generator=generator,
                callback_on_step_end=make_step_printer(tag, args.steps),
            )
            frames = result.frames[0]
            tmp_dest = dest.with_suffix(".tmp.mp4")

            def _encode(src_frames=frames, dst=tmp_dest, final=dest, video_name=name):
                from diffusers.utils import export_to_video
                export_to_video(src_frames, str(dst), fps=FPS)
                dst.replace(final)
                with encode_lock:
                    done.append(video_name)
                print(f"[{video_name}] 已保存 {final}（{len(src_frames)}帧 / "
                      f"{final.stat().st_size / 1e6:.1f}MB）", flush=True)

            encode_futures.append((name, encoder_pool.submit(_encode)))
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            failed.append(name)
            print(f"[{tag}] 失败：显存不足(OOM)。依次重试：\n"
                  f"    1) 降 --num-frames 81\n"
                  f"    2) 降 --width 832 --height 480\n"
                  f"    3) 去掉 --no-offload", flush=True)
        except Exception as exc:
            failed.append(name)
            print(f"[{tag}] 失败：{type(exc).__name__}: {exc}", flush=True)

    print("[收尾] 等待视频编码线程完成 ...", flush=True)
    for name, fut in encode_futures:
        try:
            fut.result()
        except Exception as exc:
            failed.append(name)
            print(f"[{name}] 视频编码失败：{type(exc).__name__}: {exc}", flush=True)
    encoder_pool.shutdown(wait=True)

    print("\n================ 汇总 ================")
    print(f"计划动作 : {total}")
    print(f"新生成   : {len(done)}  {done}")
    print(f"跳过     : {len(skipped)}  {skipped}")
    print(f"失败     : {len(failed)}  {failed}")
    if failed:
        print(f"缺失清单（重跑即可补齐）：{','.join(failed)}")
    return len(failed)


if __name__ == "__main__":
    raise SystemExit(main())
