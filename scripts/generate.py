#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工作状态动画批量生成脚本（**参考图模式 = Reference-to-Video**，ModelScope 下载，纯离线不花云端额度）。

生成 config.jsonc 中 events.workStatus 六档事件动画的绿幕源片：
  0 工作状态-思考冒泡      thinking（turn/start）
  1 工作状态-忙碌点按      working（tool/call）
  2 工作状态-清点归档      result（tool/result）
  3 工作状态-原地踱步张望  waiting（approval/asked）
  4 工作状态-雀跃庆祝      success（turn/end completed）
  5 工作状态-垂头叹气冒汗  error（turn/end error）

⚠️ 参考图 ≠ 首帧！
   本脚本走 **Wan 2.1 VACE Reference-to-Video**（diffusers WanVACEPipeline 的
   reference_images 参数）——参考图只约束角色的**外观**（脸、发型、衣服、体型），
   视频第一帧**不被锁死**，起始姿势和全部动作完全由 prompt 自由控制。
   六条视频共享同一张参考图 → 角色细节零漂移，每条的起始姿势各随动作设计走。
   （对比：I2V image=首帧 是硬锁第一帧，参考图是什么姿势，视频就必须从什么姿势开始）

====================================================================
模型（只从 ModelScope 下载，不碰 HuggingFace）
--------------------------------------------------------------------
默认：Wan-AI/Wan2.1-VACE-1.3B-diffusers
  • 官方 Wan-AI 组织维护，Diffusers 原生格式（README = Wan2.1 官方仓库）
  • Reference-to-Video：reference_images 参数 = 只约束外观、不锁首帧
  • 参数量小（1.3B），官方口径基础 T2V 1.3B 仅需 ~8.19GB 显存，
    VACE 1.3B 配合 enable_model_cpu_offload() + VAE tiling，
    24GB 跑 720P / 161 帧（10 秒）绰绰有余
  • 支持 720P（1280×720）；官方提示 1.3B 在 720P 下稳定性略逊于 480P，
    若成片抖动/崩坏明显可降回 832×480 重试（--width 832 --height 480）
  • 首次 snapshot_download 十几 GB，建议 --cache-dir 落大盘

备选（显存更多、追求画质时）：Wan-AI/Wan2.1-VACE-14B-diffusers
  • 23.15B，720P 更稳，但 24GB 上 161 帧较紧，48GB+ 更合适

====================================================================
云端环境（CUDA / 8核 / 32GB内存 / 24GB显存）首次准备（Linux）：
  pip install torch --index-url https://download.pytorch.org/whl/cu124
  pip install "diffusers>=0.41" transformers accelerate imageio imageio-ffmpeg \
              modelscope pillow
  # 可选：模型缓存落大盘
  export MODELSCOPE_CACHE=/your/ssd/path

运行（默认参考图就是项目自带的 scripts/ref.png，可不传 --reference-image）：
  # 默认全量 6 条：720P × 10 秒 × 参考图 scripts/ref.png
  python scripts/generate.py

  # 单片试跑（先确认效果再全量）
  python scripts/generate.py --only 思考冒泡 --steps 30

  # 换别的参考图 / 落大盘缓存
  python scripts/generate.py --reference-image /data/ref/other.png --cache-dir /data/models

  # 只跑 5 秒更快
  python scripts/generate.py --num-frames 81

规格：默认 1280×720（720P）、161 帧 / 16fps ≈ 10.06 秒。
宽高必须是 16 的倍数；帧数必须满足 4k+1。

显存策略：
  默认 enable_model_cpu_offload()（顺序卸载）+ VAE tiling。
  1.3B 模型 24GB 显存下 720P × 10s：非常宽松 ✅
  OOM 时（不太可能）：①降 --num-frames；②降 --width/--height 到 480P。

====================================================================
后续素材链（在项目根目录）
--------------------------------------------------------------------
生成的 mp4（16fps / 1280×720 / 约 10s）统一先转成 24fps 入 step01：
  ffmpeg -y -hide_banner -loglevel error -i video/工作状态-思考冒泡.mp4 \
         -r 24 -c:v libx264 -crf 18 -pix_fmt yuv420p -an step01/工作状态-思考冒泡.mp4
  # 六个文件都转完后依次：
  python scripts/chroma_step02.py
  python scripts/normalize_step03.py
  python scripts/encode_thumbs.py
  # 最后把 step04 下同名 webm 拷到 dsh-pet/assets/webm/ 即生效。

参考图（默认 scripts/ref.png，1536×1536 正方形）：
  参考图**不限于绿幕**！VACE 先从参考图提取角色外观特征再注入去噪，与背景色无关；
  管线内部对参考图做**等比缩放 + 居中白底填充**到画幅，方图不会被压扁。
  • ref.png 就是目标角色立绘：棕发齐刘海、条纹露肩毛衣、猫贴布短裤、帆布鞋、
    全身清晰、白净背景——直接可用
  • 换参考图：给 --reference-image，越清晰露脸露全身、背景越干净越好
  • 正面或 3/4 侧面效果最稳
  参考图**不是**视频首帧——视频的第一帧由 prompt 自由决定（比如
  "思考冒泡"第一帧就是标准正面站立若有所思），参考图只管"角色长什么样"。

断点续跑：video/ 下同名 mp4 已存在且大于 20KB 自动跳过；单条失败不影响其余，
全部结束打印完成/跳过/失败三份清单，直接再次运行即补齐。
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import torch
from diffusers import WanVACEPipeline
from diffusers.utils import export_to_video

# ---------------------------------------------------------------- 路径与模型

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "video"
# ModelScope 仓库 ID（纯国内 CDN，不经 HF；Diffusers 格式完整；VACE = reference-to-video）
DEFAULT_MODEL = "Wan-AI/Wan2.1-VACE-1.3B-diffusers"   # 1.3B 小模型, 24GB 跑 720P×10s 宽松
# 默认参考图：项目自带的角色立绘（棕发条纹毛衣女孩，1536×1536）
DEFAULT_REF = ROOT / "scripts" / "ref.png"
FPS = 16  # Wan 原生帧率；81 帧 ≈ 5.06 秒 / 161 帧 ≈ 10.06 秒

# ---------------------------------------------------------------- 提示词公共段（VACE 参考图约束外观，这里仍然写角色描述以防 CLIP 特征不完整）

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

# 官方推荐负面词（英文）+ 本项目专属禁忌（中文）
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

# ---------------------------------------------------------------- 六档动作分镜

ACTIONS: list[tuple[str, str]] = [
    ("工作状态-思考冒泡",
     "动作「思考冒泡」（10秒）：\n"
     "0~2秒：保持标准正面站立，自然眨眼，若有所思。\n"
     "2~6秒：抬起右手，用食指轻轻点在下巴处做思考状，眉头微微皱起、视线看向斜上方认真思索，"
     "头部小幅度左右摆动；头顶右上方凭空浮现两个一大一小的半透明白色漫画思考气泡圆圈，"
     "大气泡里有一个小小的问号，气泡轻轻上下浮动。\n"
     "6~8秒：保持思考姿势，视线在两个方向间移动，思考气泡继续浮动。\n"
     "8~10秒：眼睛一亮、眉头舒展，像突然想通了，右手握拳轻轻敲一下左手掌心，嘴角露出自信微笑，"
     "思考气泡向上飘起并淡出化为光点消散，右手随即垂落身侧。\n"
     + END_FRONT),
    ("工作状态-忙碌点按",
     "动作「忙碌点按」（10秒）：\n"
     "0~2秒：保持标准正面站立，视线转向前方，上身微微前倾约5°，表情变得专注认真。\n"
     "2~7秒：双臂抬到胸前，双手张开五指在空气中快速、有节奏地交替做敲击虚拟键盘的动作"
     "（十根手指轻快起落、手腕小幅移动），头部随节奏轻轻点动，眼神专注、偶尔快速眨眼；"
     "指尖周围有几颗极小的半透明淡蓝色光点随敲击轻轻跳动。\n"
     "7~9秒：敲击节奏加快又放缓，像在赶一段紧张的输入。\n"
     "9~10秒：双手停止敲击，淡蓝色光点消散，双臂自然垂落身侧，上身回正、表情恢复平和。\n"
     + END_FRONT),
    ("工作状态-清点归档",
     "动作「清点归档」（10秒）：\n"
     "0~2秒：双手在胸前轻轻一合，以柔和光点凭空凝聚出三四张半透明发光的圆角小卡片（便签文件样式），"
     "双手接住，低头认真翻看。\n"
     "2~6秒：把卡片逐张理顺、用手指轻点检查（像在核对清单），表情专注。\n"
     "6~9秒：手臂向身侧一伸，把卡片一张张整齐叠放到身体侧方半空中的一叠发光卡片堆上"
     "（卡片堆悬空固定、不掉落），每放好一张就轻轻点一下头。\n"
     "9~10秒：最后一张卡片放好，整叠卡片瞬间化为柔和光点消散，双手收回身侧、身体回正，露出安心的微笑。\n"
     + END_FRONT),
    ("工作状态-原地踱步张望",
     "动作「原地踱步张望」（10秒）：\n"
     "0~3秒：双臂自然抱起（右手托住左臂、左手食指轻点下巴），眉头微蹙，伸长脖子向左侧张望，"
     "双脚在原地交替轻轻踏步（脚尖小幅度抬起落下，但落点始终完全不变）。\n"
     "3~6秒：换到右侧伸脖子张望两下，再低头看一眼自己的手腕（假装看手表），轻轻叹一口气、肩膀一塌。\n"
     "6~8秒：继续原地踏步，左右张望的节奏变慢，表情越来越无奈。\n"
     "8~10秒：停止踏步站正，双手背到身后，抬头看向斜上方继续等待，表情从焦急转为无奈的平静；"
     "最后双手自然垂落身侧。\n"
     + END_FRONT),
    ("工作状态-雀跃庆祝",
     "动作「雀跃庆祝」（10秒）：\n"
     "0~2秒：保持标准正面站立，看到前方结果后眼睛瞬间睁大发亮、嘴角上扬。\n"
     "2~6秒：在原地连续做多次轻快的垂直小跳（双脚并拢同时起跳同时落地、落点不变，"
     "跳跃最高点头顶距画面顶边仍保持15%以上），双手高举过头顶张开左右轻快挥动做欢呼状，"
     "咧嘴开心大笑；头顶周围迸出多颗半透明的彩色四角星星和金色小光点，向上轻轻飘散。\n"
     "6~8秒：最后一跳落地站稳，双手在胸前开心地合十一下，再张开双臂转半圈摆一个胜利姿势"
     "（身体保持原地不位移）。\n"
     "8~10秒：星星与光点淡出消散，双手垂落身侧，笑容收敛为平和的微笑。\n"
     + END_FRONT),
    ("工作状态-垂头叹气冒汗",
     "动作「垂头叹气冒汗」（10秒）：\n"
     "0~2秒：保持标准正面站立，表情一愣，视线慢慢垂下。\n"
     "2~6秒：肩膀向前塌陷、双臂无力地垂着，头部低垂，眼神变成两个下垂的委屈线条眼，"
     "额头右侧凭空浮出一颗大大的Q版蓝色汗珠轻轻颤动；她撅起嘴长长叹一口气，"
     "一小团白色哈气从嘴边飘出后消散，头顶还短暂垂下一道灰色竖线（漫画式沮丧符号）。\n"
     "6~8秒：保持低头沮丧姿势，肩膀微微起伏，汗珠继续颤动。\n"
     "8~10秒：抬起头用右手手背擦了一下额头的汗，汗珠与灰色竖线消失，无奈地苦笑一下，"
     "右手垂落身侧，恢复标准正面站立。\n"
     + END_FRONT),
]


# ---------------------------------------------------------------- 参数与工具函数

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="批量生成工作状态六档绿幕动画（VACE Reference-to-Video / ModelScope / CUDA）",
    )
    p.add_argument("--reference-image", default=str(DEFAULT_REF),
                   help=f"参考图本地路径（默认 {DEFAULT_REF}；角色外观图，不是视频首帧）")
    p.add_argument("--only", default="",
                   help="只生成名字包含这些关键词的动作（逗号分隔），如：思考冒泡,雀跃庆祝")
    p.add_argument("--out", default=str(OUT_DIR), help="输出目录（默认项目 video/）")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help=f"ModelScope 仓库 ID 或本地模型目录（默认 {DEFAULT_MODEL}）")
    p.add_argument("--cache-dir", default="",
                   help="ModelScope 缓存目录（默认 ~/.cache/modelscope/hub/），大盘路径建议")
    p.add_argument("--width", type=int, default=1280,
                   help="画面宽度（默认 1280 = 720P；必须为 16 的倍数）")
    p.add_argument("--height", type=int, default=720,
                   help="画面高度（默认 720 = 720P；必须为 16 的倍数）")
    p.add_argument("--num-frames", type=int, default=161,
                   help="帧数，必须满足 4k+1（默认 161≈10秒 / 81≈5秒 @16fps）")
    p.add_argument("--steps", type=int, default=50, help="去噪步数（默认 50，快速档可 30）")
    p.add_argument("--guidance", type=float, default=5.0, help="CFG 引导强度（默认 5.0）")
    p.add_argument("--seed", type=int, default=20261016, help="基础随机种子（每动作 +序号）")
    p.add_argument("--dtype", choices=("bf16", "fp16"), default="bf16",
                   help="推理精度（默认 bf16 更稳；老卡可换 fp16）")
    p.add_argument("--no-offload", action="store_true",
                   help="关闭 enable_model_cpu_offload()，权重全程常驻显存（更快、更吃显存；"
                        "1.3B 模型 24GB 下开与不开都行，追求速度可开）")
    p.add_argument("--cpu-threads", type=int, default=min(8, os.cpu_count() or 8),
                   help="PyTorch CPU 算子线程数（默认最多 8）")
    return p.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.width % 16 != 0 or args.height % 16 != 0:
        sys.exit(f"[错误] --width/--height 必须是 16 的倍数，当前 {args.width}x{args.height}")
    if (args.num_frames - 1) % 4 != 0:
        sys.exit(f"[错误] --num-frames 必须满足 4k+1（如 81/121/161），当前 {args.num_frames}")
    if args.steps <= 0 or args.guidance <= 0:
        sys.exit("[错误] --steps/--guidance 必须为正数")
    ri = Path(args.reference_image).expanduser()
    if not ri.is_file():
        sys.exit(f"[错误] --reference-image 指定的参考图不存在：{ri}")
    args.reference_image = str(ri)


def select_actions(args: argparse.Namespace) -> list[tuple[str, str]]:
    if not args.only.strip():
        return ACTIONS
    keys = [k.strip() for k in args.only.split(",") if k.strip()]
    picked = [(n, p) for n, p in ACTIONS if any(k in n for k in keys)]
    missing = [k for k in keys if not any(k in n for n, _ in ACTIONS)]
    if missing:
        print(f"[警告] 这些关键词没有匹配到任何动作：{missing}", flush=True)
        print(f"可选动作：{[n for n, _ in ACTIONS]}", flush=True)
    if not picked:
        sys.exit("[错误] --only 没有匹配到任何动作")
    return picked


def resolve_model_path(args: argparse.Namespace) -> Path:
    """把 --model 解析成本地目录：本地路径直接用；ModelScope 仓库 ID 则 snapshot_download。"""
    model_ref = args.model
    if model_ref.startswith("/") or model_ref.startswith(".") or model_ref.startswith("~") or (
        os.name == "nt" and (model_ref[0].isalpha() and model_ref[1:3] == ":\\")):
        local_path = Path(model_ref).expanduser().resolve()
        if not local_path.exists():
            sys.exit(f"[错误] 指定的本地模型路径不存在：{local_path}")
        print(f"[模型] 使用本地目录：{local_path}", flush=True)
        return local_path
    try:
        from modelscope import snapshot_download  # type: ignore
    except ImportError:
        sys.exit(
            "[错误] 从 ModelScope 下载模型需要 modelscope，请先装：\n"
            "      pip install modelscope\n"
            "    或用 --model /your/local/model 指向已经下载好的本地目录。"
        )
    print(f"[模型] 从 ModelScope 下载：{model_ref}", flush=True)
    print("       模型十几 GB，建议 --cache-dir 落大盘。", flush=True)
    return Path(snapshot_download(model_id=model_ref, cache_dir=args.cache_dir or None))


def load_pipeline(args: argparse.Namespace, local_path: Path) -> WanVACEPipeline:
    dtype = torch.bfloat16 if args.dtype == "bf16" else torch.float16
    print(f"[加载模型] WanVACEPipeline ← {local_path}（{args.dtype}） ...", flush=True)
    pipe = WanVACEPipeline.from_pretrained(str(local_path), torch_dtype=dtype)

    if args.no_offload:
        pipe.to("cuda")
        print("[显存策略] 全部权重常驻 CUDA（--no-offload）", flush=True)
    else:
        # 显存管理三件套（24GB 跑 1.3B 720P 的标配，缺一不可）：
        # 1) enable_sequential_cpu_offload —— 按 Transformer layer 粒度逐层卸载，
        #    GPU 上每次只留当前那一层 + 小激活，峰值显存比 model_cpu_offload 低得多
        # 2) enable_attention_slicing("auto") —— 注意力按 head 切片算，进一步砍峰值
        # 3) enable_vae_slicing —— VAE 解码也切片（tiling 是 spatial 方向，slicing 是 temporal）
        pipe.enable_sequential_cpu_offload()
        pipe.enable_attention_slicing("auto")
        if hasattr(pipe, "enable_vae_slicing"):
            pipe.enable_vae_slicing()
        print("[显存策略] sequential offload + attention slicing + VAE slicing（24GB 标配）",
              flush=True)

    if hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
        print("[显存策略] VAE tiling 已开启", flush=True)

    # A10 / 消费级 GPU 上 TF32 加速开一下
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True

    pipe.set_progress_bar_config(disable=True)
    return pipe


def make_step_printer(tag: str, total: int):
    def callback(_pipe, step: int, _timestep, _kwargs):
        if step % 10 == 0 or step == total - 1:
            print(f"  [{tag}] 去噪 {step + 1}/{total}", flush=True)
        # diffusers 要求回调必须返回 kwargs 字典（否则内部 callback_kwargs.pop(...) 报 NoneType）
        return _kwargs

    return callback


# ---------------------------------------------------------------- 主流程

def main() -> int:
    args = parse_args()
    validate_args(args)
    actions = select_actions(args)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. 解析/下载模型（纯 CPU 与 IO，不走 CUDA）。
    local_model_path = resolve_model_path(args)

    # 2. 推理前环境闸门。
    if not torch.cuda.is_available():
        sys.exit(
            "[环境错误] 未检测到可用 CUDA。本脚本面向云端 GPU 运行：\n"
            "  1) 确认 NVIDIA 驱动正常（nvidia-smi）；\n"
            "  2) 安装 CUDA 版 PyTorch：\n"
            "     pip install torch --index-url https://download.pytorch.org/whl/cu124\n"
            "  3) 再运行本脚本。"
        )
    torch.set_num_threads(args.cpu_threads)
    print(f"[环境] GPU：{torch.cuda.get_device_name(0)}", flush=True)
    print(f"[模式] VACE Reference-to-Video（参考图=外观约束，首帧自由）", flush=True)
    print(f"[参考图] {args.reference_image}（仅约束外观，视频首帧由 prompt 自由决定）", flush=True)
    print(f"[参数] {args.width}x{args.height} / {args.num_frames}帧 / {FPS}fps / "
          f"{args.steps}步 / guidance={args.guidance} / CPU线程={args.cpu_threads}", flush=True)

    # 3. 加载 CUDA pipeline。
    pipe = load_pipeline(args, local_model_path)

    # 4. 加载参考图（PIL.Image）。
    #    不做手动 resize——VACE 管线内部会**等比缩放 + 居中填充**到画幅，
    #    方形图（如 ref.png 1536×1536）不会被压扁，直接原样传入即可。
    from PIL import Image
    ref_pil = Image.open(args.reference_image).convert("RGB")
    print(f"[参考图] 尺寸 {ref_pil.size[0]}x{ref_pil.size[1]}（管线内部等比缩放居中，无需手动处理）",
          flush=True)

    done: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []

    encoder_pool = ThreadPoolExecutor(max_workers=2)
    encode_futures: list[tuple[str, ...]] = []
    encode_lock = threading.Lock()

    total = len(actions)
    for index, (name, action_prompt) in enumerate(actions, start=1):
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
                prompt=f"{CHARACTER}\n{CAMERA_RULES}\n{action_prompt}",
                negative_prompt=NEGATIVE_PROMPT,
                reference_images=[ref_pil],       # ← VACE 参考图：外观约束、不锁首帧
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
            print(f"[{tag}] 失败：显存不足(OOM)。1.3B 不该出现，可依次重试：\n"
                  f"    1) 降 --num-frames（如 81）\n"
                  f"    2) 降 --width --height 到 832x480\n"
                  f"    3) 去掉 --no-offload（默认已启用顺序卸载）", flush=True)
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
    else:
        print("全部成功。下一步：用 ffmpeg -r 24 把 video/*.mp4 转 step01/，再依次运行 "
              "chroma_step02.py → normalize_step03.py → encode_thumbs.py。")
    return len(failed)


if __name__ == "__main__":
    raise SystemExit(main())
