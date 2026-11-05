"""Короткие русские подписи в тех же плашках, что на кадрах релиза.

Читает webm и png из пакета и пишет ru/<то же имя> рядом.
Не создаёт step01–step04 и не трогает video/*.mp4.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PET = ROOT / "dsh-pet" / "assets"
MEME_DIR = PET / "memes"
WEBM_DIR = PET / "webm"
FFMPEG = "ffmpeg"

FONT_CANDIDATES = (
    Path(r"C:\Windows\Fonts\segoeuib.ttf"),
    Path(r"C:\Windows\Fonts\arialbd.ttf"),
    Path(r"C:\Windows\Fonts\arial.ttf"),
)

# Прямоугольник (x0, y0, x1, y1) и короткая фраза. bubble — тёмный текст на светлой плашке.
MEME_LINES: dict[str, list[tuple[tuple[int, int, int, int], str, str]]] = {
    "哦鲸鲸": [((36, 12, 214, 118), "Ну и ну...", "bubble")],
    "大烧货": [((18, 4, 268, 124), "Думала 13 с\nЖрёт токены", "bubble")],
    "先养着吧": [((28, 4, 360, 128), "Пользы не вижу,\nпусть живёт", "bubble")],
    "除了调情没啥用": [((12, 2, 376, 108), "Умею флиртовать и\nспрашивать странное", "bubble")],
    "我不更新你们用什么": [((20, 248, 364, 282), "Не обновлюсь — и что?", "title")],
    "哪来的电脑病毒": [
        ((16, 18, 168, 118), "Если я стану\nфайлом, как\nменя сохранить?", "bubble"),
        ((188, 12, 368, 88), "Откуда вирус.", "bubble"),
        ((78, 150, 155, 210), "ты", "bubble"),
    ],
    "大师这个区是什么意思": [
        ((8, 4, 210, 96), "Мастер, что\nзначит этот знак?", "bubble"),
        ((145, 175, 245, 275), "?", "bubble"),
    ],
    "就骚了怎么滴吧": [
        ((16, 8, 250, 88), "Ну и рыба!", "bubble"),
        ((8, 168, 230, 282), "Ну и что!", "title"),
    ],
    "完蛋了把黄油删了": [((8, 2, 210, 88), "Думаю…\nБеда, стёрла\nчужое…", "bubble")],
    "就一碗": [((8, 16, 230, 185), "Можно к тебе\nпоесть?\nВсего миска!", "bubble")],
    "鱼片有资源吗": [((8, 8, 300, 92), "Рыбка? Не видела.\nЕсть ссылка?", "bubble")],
    "假如给我三天多模态": [
        ((28, 4, 360, 72), "Три дня\nмультимодальности!", "title"),
        ((250, 78, 360, 130), "Кит Келлер", "bubble"),
    ],
    "Ciallo": [((36, 248, 350, 368), "Привет", "title")],
    "吃白饭的大肥鱼": [
        ((16, 2, 368, 72), "Ругайся, мне всё равно", "title"),
        ((0, 148, 102, 222), "Рис\nвкусный", "bubble"),
        ((8, 248, 376, 376), "Я толстая синяя\nрыба на чужом рисе", "title"),
    ],
    "大的要来啦": [((24, 8, 360, 88), "Сейчас начнётся!", "title")],
    "大的药来了": [((4, 0, 380, 108), "Вот это доза", "title")],
    "要不直接骂他": [((12, 250, 372, 368), "Может, сразу\nнаорать?!", "title")],
    "死掉了": [((18, 40, 100, 210), "Умерла", "title")],
    "深度睡眠": [((28, 28, 250, 100), "Сплю", "title")],
    "吃饱饱摸肚子": [
        ((188, 28, 372, 158), "Наелась,\nглажу живот", "bubble"),
        ((210, 150, 330, 200), "хлоп", "bubble"),
        ((28, 288, 125, 340), "хлоп", "bubble"),
    ],
    "誓死践行开源精神": [((8, 6, 376, 72), "За открытый код", "title")],
    "电死你": [((4, 220, 380, 380), "Ты лоликонщик.\nПолучи!", "title")],
    "token给妈妈保管": [((8, 6, 376, 72), "токен заберёт мама", "title")],
    "厉害了我的鲸": [((16, 300, 368, 372), "Вот это кит!", "title")],
    "压力一只大肥鱼": [((12, 4, 372, 88), "Стресс? Это я?", "title")],
    "黎曼猜想没证明喵": [
        ((8, 6, 250, 110), "DeepSeek, гипотезу\nРимана решил?", "bubble"),
        ((4, 230, 250, 368), "Гипотеза Римана!\nНе доказана!", "title"),
    ],
}


def font_path() -> Path:
    for path in FONT_CANDIDATES:
        if path.is_file():
            return path
    raise FileNotFoundError("нет шрифта с кириллицей")


def luminance(pixel: tuple[int, ...]) -> float:
    return 0.2126 * pixel[0] + 0.7152 * pixel[1] + 0.0722 * pixel[2]


def median_color(samples: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    if not samples:
        return (255, 255, 255, 255)
    samples.sort(key=luminance)
    return samples[len(samples) // 2]


def sample_fill(image: Image.Image, box: tuple[int, int, int, int], kind: str) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = box
    pixels = image.load()
    picked: list[tuple[int, int, int, int]] = []
    for y in range(max(0, y0), min(image.height, y1)):
        for x in range(max(0, x0), min(image.width, x1)):
            pixel = pixels[x, y]
            if pixel[3] < 200:
                continue
            light = luminance(pixel)
            if kind == "bubble" and light > 190:
                picked.append(pixel)
            elif kind == "title" and 40 < light < 230:
                picked.append(pixel)
    if picked:
        return median_color(picked)
    return (255, 255, 255, 255) if kind == "bubble" else (20, 30, 60, 255)


def wrap_lines(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        current = words[0]
        for word in words[1:]:
            trial = current + " " + word
            if draw.textlength(trial, font=font) <= width:
                current = trial
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def paint(image: Image.Image, box: tuple[int, int, int, int], text: str, kind: str) -> None:
    fill = sample_fill(image, box, kind)
    draw = ImageDraw.Draw(image)
    x0, y0, x1, y1 = box
    radius = 14 if kind == "bubble" else 8
    draw.rounded_rectangle(box, radius=radius, fill=fill)
    ink = (32, 48, 92, 255) if kind == "bubble" else (255, 255, 255, 255)
    stroke = None if kind == "bubble" else (12, 16, 32, 255)
    pad = 8
    max_w = max(8, x1 - x0 - 2 * pad)
    max_h = max(8, y1 - y0 - 2 * pad)
    face = str(font_path())
    chosen = ImageFont.truetype(face, 12)
    lines = [text]
    for size in range(40, 9, -1):
        candidate = ImageFont.truetype(face, size)
        lines = wrap_lines(draw, text, candidate, max_w)
        heights = [draw.textbbox((0, 0), line or " ", font=candidate)[3] for line in lines]
        if sum(heights) + 2 * (len(lines) - 1) <= max_h and all(
            draw.textlength(line, font=candidate) <= max_w for line in lines
        ):
            chosen = candidate
            break
    heights = [draw.textbbox((0, 0), line or " ", font=chosen)[3] for line in lines]
    gap = 2
    total = sum(heights) + gap * (len(lines) - 1)
    top = y0 + (y1 - y0 - total) / 2
    for line, height in zip(lines, heights, strict=True):
        width = draw.textlength(line, font=chosen)
        left = x0 + (x1 - x0 - width) / 2
        draw.text((left, top), line, font=chosen, fill=ink, stroke_width=0 if stroke is None else 2, stroke_fill=stroke)
        top += height + gap


def render_meme(name: str) -> Image.Image:
    image = Image.open(MEME_DIR / f"{name}.png").convert("RGBA")
    for box, text, kind in MEME_LINES[name]:
        paint(image, box, text, kind)
    return image


def write_memes(preview: Path | None) -> None:
    out = preview if preview is not None else MEME_DIR / "ru"
    out.mkdir(parents=True, exist_ok=True)
    for name in MEME_LINES:
        render_meme(name).save(out / f"{name}.png")
        print(f"meme {name}")


def light_components(
    image: Image.Image, y_from: int, y_to: int, min_light: float = 200
) -> list[tuple[int, int, int, int, int]]:
    width, height = image.size
    pixels = image.load()
    y_to = min(height, y_to)
    mask = bytearray(width * height)
    for y in range(y_from, y_to):
        row = y * width
        for x in range(width):
            pixel = pixels[x, y]
            if pixel[3] < 180 or luminance(pixel) < min_light:
                continue
            if max(pixel[:3]) - min(pixel[:3]) < 50:
                mask[row + x] = 1
    seen = bytearray(width * height)
    found: list[tuple[int, int, int, int, int]] = []
    for index, bit in enumerate(mask):
        if not bit or seen[index]:
            continue
        queue = [index]
        seen[index] = 1
        min_x = max_x = index % width
        min_y = max_y = index // width
        count = 0
        while queue:
            current = queue.pop()
            count += 1
            x, y = current % width, current // width
            min_x, max_x = min(min_x, x), max(max_x, x)
            min_y, max_y = min(min_y, y), max(max_y, y)
            for delta in (-width, -1, 1, width):
                nxt = current + delta
                if nxt < 0 or nxt >= width * height or seen[nxt] or not mask[nxt]:
                    continue
                if delta in (-1, 1) and nxt // width != y:
                    continue
                seen[nxt] = 1
                queue.append(nxt)
        found.append((count, min_x, min_y, max_x, max_y))
    return found


def speech_bubbles(image: Image.Image, min_count: int = 700) -> list[tuple[int, int, int, int]]:
    height = image.size[1]
    boxes: list[tuple[int, int, int, int]] = []
    for count, min_x, min_y, max_x, max_y in light_components(image, 0, int(height * 0.7), 165):
        center_x = (min_x + max_x) / 2
        wide = max_x - min_x
        if count < min_count or wide < 70 or 250 < center_x < 400:
            continue
        boxes.append((min_x - 4, min_y - 4, max_x + 4, max_y + 4))
    boxes.sort(key=lambda box: box[0])
    return boxes


def paper_box(image: Image.Image) -> tuple[int, int, int, int] | None:
    height = image.size[1]
    for count, min_x, min_y, max_x, max_y in light_components(image, int(height * 0.45), height):
        width = max_x - min_x
        tall = max_y - min_y
        if 2000 <= count <= 8000 and 50 <= width <= 140 and 40 <= tall <= 120 and min_y > height * 0.5:
            return (min_x, min_y, max_x, max_y)
    return None


def paint_video_frame(image: Image.Image, name: str, phrases: list[str]) -> None:
    if name == "写福字":
        box = paper_box(image)
        if box is not None:
            paint(image, box, phrases[0], "bubble")
        return
    if name == "收红包":
        return
    boxes = speech_bubbles(image, 500 if name == "深度思考碎碎念" else 700)
    for index, box in enumerate(boxes):
        if name == "深度思考碎碎念":
            center_y = (box[1] + box[3]) / 2
            center_x = (box[0] + box[2]) / 2
            phrase = phrases[2] if center_y >= 145 else phrases[1] if center_x >= 320 else phrases[0]
        else:
            phrase = phrases[min(index, len(phrases) - 1)]
        paint(image, box, phrase, "bubble")


VIDEO_PHRASES = {
    "是啊，吃什么": ["Что едим?", "Да, что едим?"],
    "深度思考碎碎念": ["Что на обед…", "Спать хочу…", "Лень…"],
    "写福字": ["Удача"],
    "收红包": ["Удача"],
}


def write_videos() -> None:
    out = WEBM_DIR / "ru"
    out.mkdir(parents=True, exist_ok=True)
    for name, phrases in VIDEO_PHRASES.items():
        if name == "收红包":
            # 红包上的「福」只有几像素，盖上会毁掉信封。缺文件时接口回退到原片。
            continue
        src = WEBM_DIR / f"{name}.webm"
        dst = out / f"{name}.webm"
        with tempfile.TemporaryDirectory(prefix="dsh-ru-") as folder:
            frames = Path(folder)
            subprocess.run(
                [
                    FFMPEG,
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-c:v",
                    "libvpx-vp9",
                    "-i",
                    str(src),
                    str(frames / "%04d.png"),
                ],
                check=True,
            )
            paths = sorted(frames.glob("*.png"))
            for path in paths:
                image = Image.open(path).convert("RGBA")
                paint_video_frame(image, name, phrases)
                image.save(path)
            subprocess.run(
                [
                    FFMPEG,
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-framerate",
                    "24",
                    "-i",
                    str(frames / "%04d.png"),
                    "-c:v",
                    "libvpx-vp9",
                    "-pix_fmt",
                    "yuva420p",
                    "-crf",
                    "32",
                    "-b:v",
                    "0",
                    "-an",
                    str(dst),
                ],
                check=True,
            )
        print(f"video {name} -> {dst} ({dst.stat().st_size} bytes)")


def main() -> None:
    write_memes(None)
    write_videos()


if __name__ == "__main__":
    main()
