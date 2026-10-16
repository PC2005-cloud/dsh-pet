# -*- coding: utf-8 -*-
"""
使用阿里云 DashScope wan3.0-video-prime（参考图模式）批量生成桌宠绿幕源视频。

特点：
- 仅依赖 Python 标准库（urllib），无需 pip install
- 参考图以 data:image/png;base64 内联传入，无需 OSS
- API Key 只从环境变量 DASHSCOPE_API_KEY 读取，不写入任何文件

用法（PowerShell）：
  $env:DASHSCOPE_API_KEY="sk-xxxx"
  python scripts/gen_wan_videos.py
"""

import base64
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF_IMAGE = ROOT / "prompts" / "要不直接骂他.png"
OUT_DIR = ROOT / "video"

ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis"
TASK_URL = "https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}"
MODEL = "wan3.0-video-prime"

# ---- 角色与通用强制规范（每条 prompt 都会拼接）----
CHARACTER = (
    "以<图片1>中的Q版手绘卡通女孩为唯一角色，人物外形必须与<图片1>完全一致并在全片保持稳定："
    "棕色长直发、齐刘海、棕褐色大眼睛；穿白色露肩宽松毛衣（衣身布满黑色细横条纹）、"
    "黑色毛边短裤（裤身有白色小猫布贴与白色手写涂鸦）、白袜、黑白低帮帆布鞋。"
    "她没有呆毛、没有兽耳、没有任何尾巴，不穿女仆装、不穿裙撑。"
)

GLOBAL_RULES = (
    "画面强制要求：16:9横屏；背景必须是纯净、均匀、无阴影/杂物/渐变/边框的标准绿幕色"
    "（Chroma Key Green，#00FF00），全片绿幕色值完全一致、无色差；"
    "女孩全程位于画面正中心偏下，头顶始终约在画面20%高度、脚底约85%高度，"
    "身体最左与最右边缘约在水平25%与75%位置；双脚落点恒定为屏幕正中央，"
    "全程不允许任何X轴或Y轴平移，只允许原地呼吸起伏、脚尖点地、原地轴心小转动；"
    "任何一帧头发、手脚、衣角以及气泡等特效对象的最高点/最外点都必须与画幅对应边缘"
    "保持至少10%画幅宽/高的安全距离，绝不接触、超出或被裁切；"
    "第一帧必须是干净的标准正面站立（双脚并拢、双臂自然垂放、目光平视、表情平和，"
    "无任何道具与特效），第10秒结束时必须彻底恢复为与第一帧完全一致的标准正面站立，无残留；"
    "手绘Q版动画风格，线条干净，色彩平涂柔和，动作自然流畅。"
)

# ---- 4 个待机动作（已按参考角色改写：去除呆毛、鲸尾、女仆装、水中漂浮等）----
ACTIONS = [
    (
        "待机呼吸休闲-棕发女孩",
        "动作「待机呼吸休闲」：原地站立，身体呈现自然、有节奏的轻微上下起伏（呼吸感），"
        "双眼平视前方，每隔3-5秒完成一次轻快眨眼。无位移、无切边，动作自然，全身结构完整保留在画面中央。\n"
        "- 0~3秒：身体以极轻微幅度上下起伏模拟呼吸，每隔约2秒眨眼一次，双臂自然垂放。\n"
        "- 3~7秒：头部以极小幅度向左、向右缓慢转动，仿佛在环顾四周，身体重心始终在原位。\n"
        "- 7~10秒：头部缓缓回正，呼吸恢复平稳。第10秒结束时，与第一帧标准正面站立完全一致。",
    ),
    (
        "原地小憩沉眠-棕发女孩",
        "动作「原地小憩沉眠」：女孩开始犯困，双眼缓缓闭合，头部自然向下微微低垂，"
        "身体重心轻微下沉至打瞌睡姿态；头顶向上冒出两三个半透明的“Zzz”气泡，气泡缓缓上升变淡消失；"
        "身体伴随呼吸做极其舒缓的上下微浮。全程居中，不漂移，不切边。\n"
        "- 0~3秒：双眼缓慢闭合，头部微微下点，重心略微下沉，表现出困意。\n"
        "- 3~7秒：像深呼吸般极缓慢上下微微起伏，头顶每隔约2秒飘出一个透明“Zzz”气泡缓缓上升。\n"
        "- 7~10秒：身体缓缓回升到正常站立高度，头部抬起，眼睛缓缓睁开，双臂自然垂落，"
        "第10秒结束时与标准正面站立完全一致。",
    ),
    (
        "原地漂浮踏步-棕发女孩",
        "动作「原地漂浮踏步」：女孩在原地进行轻快、有节奏的小碎步踏步，双手在身体两侧自然交替前后摆动，"
        "宽松毛衣下摆与棕色长发随原地踏步自然轻摆。双脚绝不向前或向后移动，如同在跑步机上原地踏步，"
        "动作全程在画幅中央完成，不超出底边缘，不切脚。\n"
        "- 0~3秒：双脚开始轻快交替踏步，手臂在身体两侧微微抬起并前后摆动。\n"
        "- 3~7秒：踏步节奏加快，长发与毛衣下摆伴随踏步自然摇摆，表情轻松。\n"
        "- 7~10秒：踏步逐渐减速直至停止，双脚并拢，双手自然落下，第10秒结束时恢复为标准正面站立。",
    ),
    (
        "哈欠连天-棕发女孩",
        "动作「哈欠连天」：女孩张大嘴打一个大大的哈欠，同时双手向上自然伸展"
        "（手臂不举至最高点，只抬到肩部高度展开），眼睛湿润泛泪光，随后揉眼睛、轻轻摇头努力保持清醒。"
        "打哈欠时头部和双手始终不越出画幅安全区。\n"
        "- 0~2秒：从标准正面站立开始，眼睛慢慢眯起，嘴微微张开，双臂在身体两侧向斜上方慢慢抬起至约与肩平。\n"
        "- 2~4秒：嘴张大打出哈欠，头微后仰，双眼闭成弯弧，眼角渗出泪花。\n"
        "- 4~6秒：哈欠结束，双手收回揉眼睛，眼皮仍显沉重。\n"
        "- 6~8秒：轻轻甩了甩头驱散困意，眼睛努力睁大。\n"
        "- 8~10秒：恢复标准正面站立，表情平静，第10秒结束时与第一帧完全一致。",
    ),
]


def post_json(url: str, payload: dict, headers: dict | None = None, timeout: int = 60):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_json(url: str, headers: dict | None = None, timeout: int = 60):
    req = urllib.request.Request(url, method="GET")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download(url: str, dest: Path):
    with urllib.request.urlopen(url, timeout=300) as resp, open(dest, "wb") as f:
        f.write(resp.read())


def extract_video_url(output: dict) -> str | None:
    """兼容不同返回形态：video_url / video:[{url}] / results:[{url}] / videos:[{url}]"""
    if isinstance(output.get("video_url"), str):
        return output["video_url"]
    for key in ("video", "videos", "results"):
        items = output.get(key)
        if isinstance(items, list) and items:
            first = items[0]
            if isinstance(first, str):
                return first
            if isinstance(first, dict):
                return first.get("url") or first.get("video_url")
    return None


def main() -> int:
    api_key = os.environ.get("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        print("ERROR: 未设置环境变量 DASHSCOPE_API_KEY", flush=True)
        return 2
    if not REF_IMAGE.exists():
        print(f"ERROR: 参考图不存在: {REF_IMAGE}", flush=True)
        return 2
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    b64 = base64.b64encode(REF_IMAGE.read_bytes()).decode("ascii")
    img_data_uri = f"data:image/png;base64,{b64}"
    auth = {"Authorization": f"Bearer {api_key}"}

    # 1) 一次性提交全部任务（服务端并行生成）
    tasks: list[tuple[str, str, Path]] = []
    for name, action in ACTIONS:
        prompt = f"{CHARACTER}\n{GLOBAL_RULES}\n{action}"
        payload = {
            "model": MODEL,
            "input": {
                "prompt": prompt,
                "media": [{"type": "reference_image", "url": img_data_uri}],
            },
            "parameters": {
                "resolution": "720P",
                "ratio": "16:9",
                "duration": 10,
                "audio": False,
                "watermark": False,
                "prompt_extend": False,
            },
        }
        try:
            resp = post_json(
                ENDPOINT,
                payload,
                headers={**auth, "X-DashScope-Async": "enable"},
            )
            task_id = resp["output"]["task_id"]
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            print(f"[提交失败] {name}: HTTP {e.code} {body}", flush=True)
            continue
        tasks.append((name, task_id, OUT_DIR / f"{name}.mp4"))
        print(f"[已提交] {name}  task_id={task_id}", flush=True)

    if not tasks:
        return 1

    # 2) 轮询直到全部结束
    pending = {tid: (name, dest) for name, tid, dest in tasks}
    start = time.time()
    MAX_WAIT = 900  # 15 分钟整体上限
    while pending and time.time() - start < MAX_WAIT:
        time.sleep(6)
        for tid in list(pending.keys()):
            name, dest = pending[tid]
            try:
                resp = get_json(TASK_URL.format(task_id=tid), headers=auth)
            except urllib.error.HTTPError as e:
                print(f"[查询异常] {name}: HTTP {e.code}", flush=True)
                continue
            output = resp.get("output", {})
            status = output.get("task_status", "")
            if status == "SUCCEEDED":
                video_url = extract_video_url(output)
                if not video_url:
                    print(f"[失败] {name}: 成功但未找到视频地址 output={json.dumps(output, ensure_ascii=False)[:500]}", flush=True)
                else:
                    download(video_url, dest)
                    print(f"[完成] {name} -> {dest}", flush=True)
                pending.pop(tid)
            elif status in ("FAILED", "CANCELED", "UNKNOWN"):
                print(f"[失败] {name}: status={status} output={json.dumps(output, ensure_ascii=False)[:500]}", flush=True)
                pending.pop(tid)
            else:
                print(f"[进行中] {name}: {status}  已等待 {int(time.time() - start)}s", flush=True)

    if pending:
        print("TIMEOUT: 以下任务在限定时间内未完成: " + ", ".join(n for n, _ in pending.values()), flush=True)
        return 1
    print("全部任务结束。", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
