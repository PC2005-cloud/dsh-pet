#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布（step05）：step04 成品 → 插件 assets/webm，归档原片/成品，清理中间目录。

素材处理链第 5 步（收尾，前 4 步跑完后执行）：
  1. 同名发布：step04/*.webm → dsh-pet/assets/webm/（同名覆盖替换，没有同名则添加）
  2. 归档原片：video/<动作>.mp4 → video/source/（清空输入目录，下次链条只处理新片）
  3. 归档成品：step04/<动作>.webm → video/done/（step04 是临时目录，成品长期放 done/）
  4. 清理中间产物：删除 step01/ step02/ step03/ step04/
     —— 全部发布与归档成功才删；有失败则保留中间目录，修完直接重跑即可续上

用法：
  python scripts/publish_step05.py             # 正式执行
  python scripts/publish_step05.py --dry-run   # 只打印执行计划，不动任何文件
  python scripts/publish_step05.py --keep-mid  # 发布/归档照常，但保留 step01~04

归档幂等规则（重跑安全）：
  · 目标已有同名且大小一致 → 跳过（重复执行不产生变化）
  · 目标已有同名但大小不同 → 用新文件覆盖（重新生成的原片/成品优先）
  · video/ 里找不到原片 → 打印提示不阻断（老素材原片可能早已归档或改过名，
    如 原地小憩沉眠-棕发女孩.mp4 → 原地小憩沉眠.webm）
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STEP04 = ROOT / "step04"
MID_DIRS = [ROOT / f"step0{i}" for i in range(1, 5)]
VIDEO = ROOT / "video"
SOURCE_DIR = VIDEO / "source"   # 原片归档（绿幕 mp4）
DONE_DIR = VIDEO / "done"       # 成品归档（透明 webm）
ASSETS = ROOT / "dsh-pet" / "assets" / "webm"  # 插件播放素材（同名替换/新增）


def _archive(src: Path, dst: Path) -> str:
    """移动 src → dst（dst 已存在按大小判重）。返回 'skip' / 'move' / 'replace'。"""
    if dst.exists():
        if src.stat().st_size == dst.stat().st_size:
            src.unlink()
            return "skip"
        dst.unlink()
        shutil.move(str(src), str(dst))
        return "replace"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return "move"


def main() -> int:
    ap = argparse.ArgumentParser(description="素材链 step05：发布 assets/webm + 归档 source/done + 清理 step01-04")
    ap.add_argument("--dry-run", action="store_true", help="只打印执行计划，不改任何文件")
    ap.add_argument("--keep-mid", action="store_true", help="发布与归档照常，但保留 step01~04 中间目录")
    args = ap.parse_args()
    dry = args.dry_run

    videos = sorted(STEP04.glob("*.webm")) if STEP04.exists() else []
    mid_exists = [d for d in MID_DIRS if d.exists()]
    if not videos and not mid_exists:
        print("没有待处理内容（step01~04 均不存在）。先跑前 4 步。")
        return 0
    if not videos:
        print(f"错误：{STEP04} 里没有 webm，无法发布；先跑 encode_thumbs.py")
        return 1

    failures: list[str] = []
    n_pub_add = n_pub_rep = n_done = n_src = 0

    for index, video in enumerate(videos, start=1):
        tag = f"[{index}/{len(videos)}] {video.name}"

        # ---- 1) 发布：同名替换 / 无同名则添加 ----
        dst = ASSETS / video.name
        exists = dst.exists()
        if dry:
            print(f"{tag} 发布 → {'替换' if exists else '新增'} assets/webm/")
        else:
            try:
                ASSETS.mkdir(parents=True, exist_ok=True)
                shutil.copy2(video, dst)
                if dst.stat().st_size != video.stat().st_size:
                    raise OSError("复制后大小不一致")
                n_pub_rep += int(exists)
                n_pub_add += int(not exists)
                print(f"{tag} 发布 {'替换' if exists else '新增'} OK  {video.stat().st_size / 1e6:.2f}MB")
            except OSError as error:
                failures.append(f"{video.name}: 发布失败 {error}")
                print(f"{tag} 发布失败: {error}")
                continue  # 发布失败就不动归档，保住重跑所需文件

        # ---- 2) 归档成品：step04 → video/done/ ----
        try:
            if dry:
                print(f"{tag} 归档成品 → video/done/")
            else:
                state = _archive(video, DONE_DIR / video.name)
                if state == "move":
                    n_done += 1
                print(f"{tag} 成品归档 {'(新)' if state == 'move' else '(覆盖旧版)' if state == 'replace' else '(已存在,跳过)'}")
        except OSError as error:
            failures.append(f"{video.name}: 成品归档失败 {error}")
            print(f"{tag} 成品归档失败: {error}")

        # ---- 3) 归档原片：video/<stem>.mp4 → video/source/ ----
        orig = VIDEO / f"{video.stem}.mp4"
        dst_src = SOURCE_DIR / f"{video.stem}.mp4"
        if not orig.exists():
            note = "已归档" if dst_src.exists() else "未找到原片（可能早已归档或改过名，跳过）"
            if dry:
                print(f"{tag} 原片 {note}")
            else:
                print(f"{tag} 原片 {note}")
            continue
        try:
            if dry:
                print(f"{tag} 归档原片 → video/source/{orig.name}")
            else:
                state = _archive(orig, dst_src)
                n_src += 1
                print(f"{tag} 原片归档 {'(新)' if state == 'move' else '(覆盖旧版)' if state == 'replace' else '(已存在,跳过)'}")
        except OSError as error:
            failures.append(f"{video.name}: 原片归档失败 {error}")
            print(f"{tag} 原片归档失败: {error}")

    # ---- 4) 清理中间目录（全成功 + 未指定保留时才删）----
    if dry:
        if not args.keep_mid:
            print(f"[dry] 将删除中间目录: {', '.join(d.name for d in mid_exists) or '（无）'}")
    elif args.keep_mid:
        print("\n[清理] --keep-mid：保留 step01~04")
    elif failures:
        print(f"\n[清理] 有 {len(failures)} 项失败，保留 step01~04 供重跑续上")
    else:
        for d in mid_exists:
            shutil.rmtree(d, ignore_errors=True)
            print(f"[清理] 已删除 {d.name}/")

    # ---- 汇总 ----
    print("\n=== step05 汇总 ===")
    print(f"处理        : {len(videos)}")
    print(f"发布 assets : 新增 {n_pub_add} / 替换 {n_pub_rep}" if not dry else "发布 assets : (dry-run)")
    print(f"成品 → done : {n_done}    原片 → source : {n_src}" if not dry else "归档         : (dry-run)")
    print(f"失败        : {len(failures)}")
    for f in failures:
        print(f"  - {f}")
    return len(failures)


if __name__ == "__main__":
    raise SystemExit(main())
