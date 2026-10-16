"""Generate animated GIF previews from the playing assets (dsh-pet/assets/webm -> dsh-pet/assets/preview).

素材处理链的附属步骤：把插件实际播放的透明 WebM（dsh-pet/assets/webm/）转成 GIF 预览
（dsh-pet/assets/preview/），供 GitHub README 等 Markdown 页面展示。

为什么需要这一步：
- GitHub 的 Markdown 渲染器只为「网页端上传的附件」生成内联视频播放器；
  仓库内通过 <video> 引用的 webm 不会播放（raw 返回 audio/webm MIME）。
- 仓库内图片（含 GIF）用 Markdown 图片语法可以正常内联显示。
- 故 README 预览区用 GIF 演示，完整透明视频仍以 webm 形式保留在 assets/webm/。

透明处理：GIF 支持 1bit 透明。源 webm 是透明背景，直接转 GIF 会把透明区域
转成黑色；本脚本用 palettegen/paletteuse 保留 alpha，透明部分在页面上显示为底色。

输出命名：按仓库约定输出拼音文件名（README 效果预览的
<img src="dsh-pet/assets/preview/<拼音>.gif"> 与 PINYIN 表一一对应）；
表中没有的动画名回退用中文名。

用法：
  python scripts/encode_preview_gifs.py          # 全部（按名称排序）
  python scripts/encode_preview_gifs.py 工作状态-雀跃庆祝  # 指定一个/多个
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "dsh-pet" / "assets" / "webm"
OUT = ROOT / "dsh-pet" / "assets" / "preview"
# 统一使用工作区自带的 ffmpeg（素材处理链零第三方依赖）
FFMPEG = str(ROOT / ".tools" / "ffmpeg-9.0.1-essentials_build" / "bin" / "ffmpeg.exe")

# GIF 参数（GIF 体积大，预览用低帧率 + 中等尺寸即可）
WIDTH = 220    # 预览宽度（保持宽高比）
FPS = 12       # 预览帧率（webm 24fps → 12fps，体积减半且足够流畅）

# 动画名 → 拼音输出文件名（与 README 效果预览的 img src 一致）
PINYIN = {
    "待机呼吸休闲": "daiji-huxi-xiuxian",
    "东张西望": "dongzhangxiwang",
    "螃蟹走路": "pangxie-zoulu",
    "原地漂浮踏步": "yuandi-piaofu-tabu",
    "原地左转奔跑": "yuandi-zuozhuan-benpao",
    "悠闲哼歌": "youxian-hengga",
    "超大伸懒腰": "chaoda-shenlanyao",
    "原地敲击桌面互动": "yuandi-qiaoji-zhuomian-hudong",
    "原地重力下蹲压缩": "yuandi-zhongli-xiadun-yasuo",
    "哈欠连天": "haqian-liantian",
    "原地小憩沉眠": "yuandi-xiaoqi-chenmian",
    "女仆屈膝礼仪": "nvpu-quxi-liyi",
    "被吓一跳": "beixiayitiao-zhamao",
    "小幅度原地360度旋转展示": "xiaofudu-yuandi-360du-xuanzhuan-zhanshi",
    "偷吃零食被抓住": "touchi-lingshi-bei-zhuazhu",
    "用鲸鱼尾巴拍打地面": "yong-jingyu-weiba-paidadi",
    "打瞌睡被惊醒": "da-keshui-bei-jingxing",
    "照镜子": "zhao-jingzi",
    "整体换装试色": "zhengti-huanzhuang-shise",
    "轻快记录": "qingkuai-jilu",
    "写代码": "xie-daima",
    "摇扇纳凉": "yaoshan-naliang",
    "晨间刷牙": "chenjian-shuaya",
    "原地专心玩魔方": "yuandi-zhuanxin-wan-mofang",
    "原地蹲下玩玩具汽车": "yuandi-dunxia-wan-wanju-qiche",
    "鲸鱼吐泡泡特效": "jingyu-tu-paopao-texiao",
    "原地跳跃抓碎头顶物品": "yuandi-tiaoyue-zhuasui-touding-wupin",
    "玩游戏气急败坏": "wan-youxi-qijibaituai",
    "玩水枪": "wan-shuiqiang",
    "小提琴演奏": "xiaotiqin-yanzou",
    "蓝鲸现世": "lanjing-xianshi",
    "优雅女仆舞": "youya-nvpuwu",
    "轻快摇摆舞": "qingkuai-yaobaiwu",
    "可爱宅舞": "keai-zhaiwu",
    "吹气球": "chui-qiqiu",
    "动物环绕": "dongwu-huanrao",
    "放风筝": "fang-fengzheng",
    "拆礼物": "chai-liwu",
    "变鸽子": "bian-gezi",
    "扑克魔术": "puke-moshu",
    "抽陀螺": "chou-tuoluo",
    "吹笛子": "chui-dizi",
    "蝴蝶蜜蜂环绕头顶开花": "hudie-mifeng-huanrao-touding-kaihua",
    "撸猫": "lu-mao",
    "凭空生花": "pingkong-shenghua",
    "骑木马": "qi-muma",
    "三球抛接": "sanqiu-paojie",
    "踢毽子": "ti-jianzi",
    "下五子棋": "xiawuziqi",
    "荡秋千": "dangqiuqian",
    "吃白饭": "chi-baifan",
    "大口吃零食": "dakou-chi-lingshi",
    "吃Token": "chi-token",
    "吃早餐": "chi-zaocan",
    "吃午餐": "chi-wucan",
    "吃晚餐": "chi-wancan",
    "吃冰淇淋融化": "chi-bingqilin-ronghua",
    "吃大闸蟹": "chi-dazhaxie",
    "吃糖葫芦": "chi-tanghulu",
    "吃长寿面": "chi-changshoumian",
    "吃西瓜": "chi-xigua",
    "涮火锅": "shuan-huoguo",
    "被落叶淹没": "beiluoye-yanmo",
    "中秋赏月吃月饼": "zhongqiu-shangyue-chi-yuebing",
    "堆雪人": "duixueren",
    "放烟花": "fang-yanhua",
    "吃粽子": "chi-zongzi",
    "吃年糕": "chi-niangao",
    "吃青团": "chi-qingtuan",
    "吃腊八粥": "chi-labazhou",
    "吃重阳糕": "chi-chongyanggao",
    "收红包": "shou-hongbao",
    "写福字": "xie-fuzi",
    "穿针乞巧": "chuanzhenqiqiao",
    "舞狮头": "wu-shitou",
    "讨糖南瓜灯": "taotang-nanguadeng",
    "插茱萸赏菊": "cha-zhuyu-shangju",
    "放河灯": "fanghedeng",
    "萌化小幽灵": "menghua-xiaoyouling",
    "装点圣诞树": "zhuangdian-shengdanshu",
    "放孔明灯": "fang-kongmingdeng",
    "吃汤圆": "chitangyuan",
    "吃饺子": "chijiaozi",
    "是啊，吃什么": "shia-chishenme",
    "深度思考碎碎念": "shendu-sikao-suisuinian",
    "点击回应-开心跃动": "dianji-huiying-kaixin-yuedong",
    "点击回应-害羞惊讶": "dianji-huiying-haixiu-jingya",
    "点击回应-傲娇生气": "dianji-huiying-aojiao-shengqi-ceshen-zhanshi",
    "点击回应-挠痒咯咯笑": "dianji-huiying-naoyang-gegexiao",
    "点击回应-元气挥手": "dianji-huiying-yuanqi-huishou",
    "被鼠标拖拽悬空反馈": "beishubiao-tuozhuai-xuankong-fankui",
    "余额-钱袋满溢": "qian-dai-man-yi",
    "余额-金袋叮当": "jin-dai-ding-dang",
    "余额-钱袋如常": "qian-dai-ru-chang",
    "余额-数金皱眉": "shu-jin-zhou-mei",
    "余额-袋空如洗": "dai-kong-ru-xi",
    "余额-分文不剩": "fen-wen-bu-sheng",
    "碎碎念-擦桌碎碎念": "suisuinian-cazhuo-suisuinian",
    "碎碎念-发呆碎碎念": "suisuinian-fadai-suisuinian",
    "碎碎念-对屏碎碎念": "suisuinian-duiping-suisuinian",
    "工作状态-思考冒泡": "gongzuozhuangtai-sikao-maopao",
    "工作状态-忙碌点按": "gongzuozhuangtai-manglu-dianan",
    "工作状态-清点归档": "gongzuozhuangtai-qingdian-guidang",
    "工作状态-原地踱步张望": "gongzuozhuangtai-yuandi-duobu-zhangwang",
    "工作状态-雀跃庆祝": "gongzuozhuangtai-queyue-qingzhu",
    "工作状态-垂头叹气冒汗": "gongzuozhuangtai-chuitou-tanqi-maohan",
}


def convert_gif(name: str) -> Path:
    src = SRC / f"{name}.webm"
    if not src.exists():
        raise FileNotFoundError(f"{src} 不存在")
    out_name = PINYIN.get(name, name)
    dst = OUT / f"{out_name}.gif"
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
            print(f"[{i}/{len(names)}] {PINYIN.get(name, name)}.gif  {size / 1e6:.1f}MB", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[{i}/{len(names)}] {name}  FAIL: {exc}", flush=True)
            return 1
    print(f"\n=== summary ===")
    print(f"gifs: {len(names)}")
    print(f"preview total: {total / 1e6:.1f}MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
