#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-pet 指标抓取脚本
====================

把仓库的公开指标抓下来，写成同目录的 data.js，供同目录的 index.html 直接读取。

数据来源
--------
* GitHub 侧：全部走已登录的 gh CLI（gh api），脚本自己不碰 token。
* npm 侧：registry.npmjs.org 与 api.npmjs.org 的公开接口，只用标准库 urllib。

为什么用 gh 而不是自己发 HTTP
-----------------------------
gh 已经带着你的登录态，省掉 token 管理与二次授权；更重要的是，脚本真正执行的命令
和页面底部"数据源与已知偏差"里展示的命令能保持一致，不会出现文档与实际两张皮。

为什么输出 .js 而不是 .json
---------------------------
浏览器禁止 file:// 下的页面用 fetch 读本地文件，而 <script src> 属于子资源加载，
双击 index.html 也能正常读到。所以数据文件是一句 window.__DSH_PET_DATA__ = {...}。

口径约定
--------
* 所有日期一律按 UTC 归组，不转本地时区。
* 逐日序列按"完整日历区间"输出：区间内接口没返回的日期补 0，不插值、不估算。
* 页面只消费 [日期, 数值] 二元组，累计曲线、今日/本周/本月、环比全部由页面自己算，
  脚本和页面不各算一套。

用法
----
    python fetch_metrics.py                  # 抓取并写入同目录的 data.js
    python fetch_metrics.py --dry-run        # 只抓取并打印体检结果，不写文件
    python fetch_metrics.py --skip-traffic   # 跳过只有 push 权限才能读的 traffic 接口
    python fetch_metrics.py --out D:/x/y.js  # 换输出路径
"""

from __future__ import annotations

import argparse
import atexit
import itertools
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SCHEMA_VERSION = 1
DEFAULT_REPO = "PC2005-cloud/dsh-pet"
DEFAULT_NPM_PACKAGE = "dsh-pet"
GENERATOR = "fetch_metrics.py"
GH_TIMEOUT = 240
HTTP_TIMEOUT = 45
HTTP_UA = "dsh-pet-metrics/1.0 (+https://github.com/PC2005-cloud/dsh-pet)"

DATA_HEADER = (
    "// 本文件由 fetch_metrics.py 生成，请勿手改。\n"
    "// 作用：把抓取结果挂到 window.__DSH_PET_DATA__，供 index.html 直接读取。\n"
    "// 用 .js 而不是 .json 的原因：浏览器禁止 file:// 下的页面用 fetch 读本地文件，\n"
    "// 而 <script src> 属于子资源加载，双击打开 index.html 也能正常加载本文件。\n\n"
)

_COUNTER = itertools.count(1)


class FetchError(RuntimeError):
    """取数失败。带上到底哪一步失败，方便直接看日志定位。"""


# --------------------------------------------------------------------------
# 临时目录：gh 的 stdout 一律重定向到文件，不用管道
# --------------------------------------------------------------------------
def _make_tmpdir() -> Path:
    """gh 输出的中转目录：就放在脚本自己旁边。

    不用系统临时目录：这个项目本来就所有文件同处一个目录，中间产物没必要丢到别处，
    而且受限环境下 TEMP 可能指向不可写的沙箱目录。

    也刻意不用管道捕获 gh 的输出：
      1. stargazers 这类接口响应可能很大，管道缓冲区容易把进程卡住；
      2. 受限环境下进程间管道可能被禁止，重定向到普通文件更稳。
    """
    d = Path(__file__).resolve().parent / ".tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


_TMPDIR = _make_tmpdir()
atexit.register(lambda: shutil.rmtree(_TMPDIR, ignore_errors=True))


def log(msg: str, quiet: bool = False) -> None:
    if not quiet:
        print(msg, file=sys.stderr, flush=True)


def warn(msg: str, quiet: bool = False) -> None:
    if not quiet:
        print("  ! " + msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# gh 调用
# --------------------------------------------------------------------------
def run_gh(args, retries: int = 3, quiet: bool = False) -> str:
    """跑一次 gh，返回 stdout 文本。失败按退避重试。"""
    last = ""
    for attempt in range(1, retries + 1):
        out_path = _TMPDIR / ("gh-%d.out" % next(_COUNTER))
        err_path = _TMPDIR / ("gh-%d.err" % next(_COUNTER))
        try:
            with open(out_path, "w", encoding="utf-8", errors="replace") as fo, \
                 open(err_path, "w", encoding="utf-8", errors="replace") as fe:
                proc = subprocess.run(["gh"] + list(args), stdout=fo, stderr=fe, timeout=GH_TIMEOUT)
        except FileNotFoundError as exc:
            raise FetchError(
                "找不到 gh 命令。请先安装 GitHub CLI，并执行 gh auth login 完成登录。"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise FetchError("gh 调用超时（%d 秒）：gh %s" % (GH_TIMEOUT, " ".join(args))) from exc

        text = out_path.read_text(encoding="utf-8", errors="replace")
        err = err_path.read_text(encoding="utf-8", errors="replace").strip()
        if proc.returncode == 0 and text.strip():
            return text

        last = err or (
            "gh 退出码 %d 且没有输出（stats 接口在后台计算时会返回空响应）" % proc.returncode
        )
        if attempt < retries:
            delay = 2 * attempt
            warn("%s 第 %d/%d 次失败：%s；%d 秒后重试" % (args[-1], attempt, retries, last, delay), quiet)
            time.sleep(delay)

    raise FetchError("gh 调用失败：gh %s\n%s" % (" ".join(args), last))


def gh_api(endpoint: str, paginate: bool = False, accept: str = None,
           retries: int = 3, quiet: bool = False):
    """调 gh api 并解析 JSON。paginate=True 时用 --slurp 把分页结果拍平成一个数组。"""
    args = ["api"]
    if paginate:
        # --slurp 把每一页包成一个数组元素；不加它，多页输出会是 [...][...] 这种非法 JSON
        args += ["--paginate", "--slurp"]
    if accept:
        args += ["-H", "Accept: " + accept]
    args.append(endpoint)

    raw = run_gh(args, retries=retries, quiet=quiet)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise FetchError("gh api %s 返回的不是合法 JSON：%s" % (endpoint, exc)) from exc

    if not paginate:
        return data

    flat = []
    for page in data if isinstance(data, list) else [data]:
        if isinstance(page, list):
            flat.extend(page)
        elif page is not None:
            flat.append(page)
    return flat


# --------------------------------------------------------------------------
# npm 调用（标准库，不引第三方依赖）
# --------------------------------------------------------------------------
def http_json(url: str, retries: int = 3, quiet: bool = False):
    last = ""
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": HTTP_UA, "Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = "HTTP %d %s" % (exc.code, exc.reason)
            if exc.code == 404:
                raise FetchError("npm 接口 404：%s（包名或日期区间可能不对）" % url) from exc
        except Exception as exc:  # noqa: BLE001 - 网络层什么都可能抛，统一重试
            last = "%s: %s" % (type(exc).__name__, exc)
        if attempt < retries:
            delay = 2 * attempt
            warn("%s 第 %d/%d 次失败：%s；%d 秒后重试" % (url, attempt, retries, last, delay), quiet)
            time.sleep(delay)
    raise FetchError("npm 接口请求失败：%s\n%s" % (url, last))


# --------------------------------------------------------------------------
# 日期工具
# --------------------------------------------------------------------------
def today_utc() -> date:
    return datetime.now(timezone.utc).date()


def iso_date(ts: str) -> str:
    """从 ISO 时间戳取 UTC 日期部分，如 2026-08-14T00:38:45Z -> 2026-08-14。"""
    return str(ts)[:10]


def month_of(ts: str) -> str:
    return str(ts)[:7]


def parse_date(s: str) -> date:
    return date.fromisoformat(str(s)[:10])


def fill_daily(counts: Counter, start: date, end: date) -> list:
    """把计数摊成完整日历区间：区间内没有记录的日期补 0，不插值。"""
    out = []
    if end < start:
        return out
    cur = start
    while cur <= end:
        key = cur.isoformat()
        out.append([key, int(counts.get(key, 0))])
        cur += timedelta(days=1)
    return out


# --------------------------------------------------------------------------
# 各数据源的抓取
# --------------------------------------------------------------------------
def fetch_repo(repo: str, quiet: bool):
    log("· 仓库基本盘", quiet)
    return gh_api("repos/" + repo, quiet=quiet)


def fetch_star_days(repo: str, quiet: bool):
    log("· Star 时间线（分页，条数多时较慢）", quiet)
    rows = gh_api(
        "repos/%s/stargazers" % repo,
        paginate=True,
        accept="application/vnd.github.star+json",
        quiet=quiet,
    )
    days = Counter()
    for r in rows:
        ts = r.get("starred_at") if isinstance(r, dict) else None
        if ts:
            days[iso_date(ts)] += 1
    return len(rows), days


def fetch_fork_days(repo: str, quiet: bool):
    log("· Fork 时间线", quiet)
    rows = gh_api("repos/%s/forks" % repo, paginate=True, quiet=quiet)
    days = Counter()
    for r in rows:
        ts = r.get("created_at") if isinstance(r, dict) else None
        if ts:
            days[iso_date(ts)] += 1
    return len(rows), days


def fetch_contributors(repo: str, quiet: bool):
    log("· 贡献者", quiet)
    rows = gh_api("repos/%s/contributors?per_page=100" % repo, paginate=True, quiet=quiet)
    out = []
    for r in rows:
        if not isinstance(r, dict) or not r.get("login"):
            continue
        out.append({
            "login": r.get("login"),
            "avatar_url": r.get("avatar_url") or "",
            "contributions": int(r.get("contributions") or 0),
            "html_url": r.get("html_url") or "",
            "type": r.get("type") or "User",
        })
    out.sort(key=lambda c: c["contributions"], reverse=True)
    return out


def fetch_contributor_stats(repo: str, quiet: bool, attempts: int = 5, delay: int = 5):
    """每位贡献者的总提交数与新增/删除行数。

    与 stats/commit_activity 一样，这个接口是异步计算的：缓存没热时返回空数组或
    空响应，不能把空结果当成"没有贡献"，要隔几秒再问一次。
    """
    log("· 贡献者增删行数（stats/contributors）", quiet)
    for i in range(1, attempts + 1):
        data = gh_api("repos/%s/stats/contributors" % repo, quiet=quiet)
        if isinstance(data, list) and data:
            return data
        if i < attempts:
            warn("stats/contributors 还没算好（第 %d/%d 次返回%s），%d 秒后重试" % (
                i, attempts, "空数组" if data == [] else " " + type(data).__name__, delay), quiet)
            time.sleep(delay)
    warn("stats/contributors 重试 %d 次仍无数据，贡献者只显示提交数。" % attempts, quiet)
    return []


def fetch_releases(repo: str, quiet: bool):
    log("· Release 与资产下载量", quiet)
    rows = gh_api("repos/%s/releases" % repo, paginate=True, quiet=quiet)
    out = []
    for r in rows:
        if not isinstance(r, dict) or r.get("draft"):
            continue  # 草稿只有有写权限的人看得到，不纳入统计
        assets = r.get("assets") or []
        out.append({
            "tag": r.get("tag_name") or "",
            "name": r.get("name") or r.get("tag_name") or "",
            "published_at": r.get("published_at"),
            "assets": len(assets),
            "downloads": sum(int(a.get("download_count") or 0) for a in assets),
            "prerelease": bool(r.get("prerelease")),
        })
    out.sort(key=lambda x: x["published_at"] or "", reverse=True)
    return out


def fetch_issues(repo: str, quiet: bool):
    log("· Issue（接口会把 PR 混进来，稍后按 pull_request 字段剔除）", quiet)
    return gh_api("repos/%s/issues?state=all&per_page=100" % repo, paginate=True, quiet=quiet)


def fetch_pulls(repo: str, quiet: bool):
    log("· PR", quiet)
    return gh_api("repos/%s/pulls?state=all&per_page=100" % repo, paginate=True, quiet=quiet)


def fetch_commit_activity(repo: str, quiet: bool, attempts: int = 5, delay: int = 5):
    """52 周的每周提交量。

    GitHub 的 stats/* 接口是异步计算的：缓存没热时它不报错，而是返回 202 + 空响应，
    或者干脆回一个空数组。所以这里不能把"拿到空数组"当成"这个仓库没有提交"，
    必须隔几秒再问一次。
    """
    log("· 每周提交量（52 周）", quiet)
    for i in range(1, attempts + 1):
        data = gh_api("repos/%s/stats/commit_activity" % repo, quiet=quiet)
        if isinstance(data, list) and data:
            return data
        if i < attempts:
            warn("stats/commit_activity 还没算好（第 %d/%d 次返回%s），%d 秒后重试" % (
                i, attempts, "空数组" if data == [] else " " + type(data).__name__, delay), quiet)
            time.sleep(delay)
    warn("stats/commit_activity 重试 %d 次仍无数据，每周提交量将为空。" % attempts, quiet)
    return []


def fetch_traffic(repo: str, quiet: bool):
    """traffic 接口只有仓库 push 权限才读得到，且只保留最近 14 天。"""
    log("· Clone / View 流量（仅近 14 天）", quiet)
    clones = gh_api("repos/%s/traffic/clones" % repo, quiet=quiet)
    views = gh_api("repos/%s/traffic/views" % repo, quiet=quiet)
    return clones, views


def fetch_npm(pkg: str, fallback_start: str, quiet: bool):
    log("· npm registry（版本、首发时间）", quiet)
    reg = http_json("https://registry.npmjs.org/" + urllib.parse.quote(pkg), quiet=quiet)

    first_publish = (reg.get("time") or {}).get("created")
    start = iso_date(first_publish) if first_publish else fallback_start
    end = today_utc().isoformat()
    if not start:
        raise FetchError("拿不到 npm 包 %s 的首发时间，无法确定逐日下载的起始日期。" % pkg)

    log("· npm 逐日下载 %s → %s" % (start, end), quiet)
    rng = http_json(
        "https://api.npmjs.org/downloads/range/%s:%s/%s" % (start, end, urllib.parse.quote(pkg)),
        quiet=quiet,
    )
    daily = Counter()
    for row in (rng.get("downloads") or []):
        day = row.get("day")
        if day:
            daily[iso_date(day)] += int(row.get("downloads") or 0)

    log("· npm 自报区间", quiet)
    point = {}
    for key, path in (("last_day", "last-day"), ("last_week", "last-week"),
                      ("last_month", "last-month"), ("last_year", "last-year")):
        try:
            p = http_json(
                "https://api.npmjs.org/downloads/point/%s/%s" % (path, urllib.parse.quote(pkg)),
                quiet=quiet,
            )
            point[key] = {
                "from": iso_date(p.get("start") or ""),
                "to": iso_date(p.get("end") or ""),
                "value": int(p.get("downloads") or 0),
            }
        except FetchError as exc:
            warn("npm %s 区间取不到：%s" % (path, exc), quiet)

    return reg, start, end, daily, point


# --------------------------------------------------------------------------
# 组装 payload
# --------------------------------------------------------------------------
def build_sources(repo: str, pkg: str) -> list:
    return [
        {"metric": "仓库基本盘", "command": "gh api repos/%s" % repo,
         "note": "取数时刻快照；forks_count 与 forks 接口条数可能不一致，open_issues_count 含 PR"},
        {"metric": "Star 时间线",
         "command": "gh api -H \"Accept: application/vnd.github.star+json\" --paginate repos/%s/stargazers" % repo,
         "note": "按 starred_at 归到 UTC 日；超过 4 万条时接口会截断"},
        {"metric": "Fork 时间线", "command": "gh api --paginate repos/%s/forks" % repo,
         "note": "按 created_at 归到 UTC 日，条数可能少于 forks_count"},
        {"metric": "贡献者", "command": "gh api repos/%s/contributors?per_page=100" % repo,
         "note": "按提交数排序，只取前 100 名"},
        {"metric": "贡献者增删行数", "command": "gh api repos/%s/stats/contributors" % repo,
         "note": "异步接口，缓存未热时返回空需重试；只统计默认分支，合计各周的新增与删除行"},
        {"metric": "npm 逐日下载", "command": "api.npmjs.org/downloads/range/{first}:{today}/%s" % pkg,
         "note": "含 CI、镜像源与爬虫，不等于真实用户数；未发布日接口返回 0"},
        {"metric": "npm 区间合计",
         "command": "api.npmjs.org/downloads/point/{last-day,last-week,last-month,last-year}/%s" % pkg,
         "note": "npm 自报窗口，与逐日序列逐项核对"},
        {"metric": "Clone / View", "command": "gh api repos/%s/traffic/clones 与 /traffic/views" % repo,
         "note": "只有最近 14 天，需要仓库 push 权限，14 天前数据不可追回"},
        {"metric": "每周提交量", "command": "gh api repos/%s/stats/commit_activity" % repo,
         "note": "周起点为周日 00:00 UTC，共 52 周，最后一周未走完"},
        {"metric": "Issue / PR",
         "command": "gh api --paginate \"repos/%s/issues?state=all&per_page=100\" 与 /pulls" % repo,
         "note": "issues 接口混入 PR，需按 pull_request 字段剔除"},
        {"metric": "Release", "command": "gh api --paginate repos/%s/releases" % repo,
         "note": "按 published_at 排序，资产下载量为各资产 download_count 之和"},
    ]


def build_payload(repo: str, pkg: str, quiet: bool, skip_traffic: bool):
    now = datetime.now(timezone.utc)
    generated_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    today = now.date()

    repo_raw = fetch_repo(repo, quiet)
    if not isinstance(repo_raw, dict) or not repo_raw.get("full_name"):
        raise FetchError("读不到仓库 %s，请确认仓库名，以及 gh auth status 是否已登录。" % repo)

    created = parse_date(repo_raw.get("created_at") or today.isoformat())

    star_records, star_days = fetch_star_days(repo, quiet)
    fork_records, fork_days = fetch_fork_days(repo, quiet)
    contributors = fetch_contributors(repo, quiet)
    contributor_stats = fetch_contributor_stats(repo, quiet)
    releases = fetch_releases(repo, quiet)
    issues_raw = fetch_issues(repo, quiet)
    pulls_raw = fetch_pulls(repo, quiet)
    commit_raw = fetch_commit_activity(repo, quiet)
    reg, npm_start, npm_end, npm_days, npm_point = fetch_npm(pkg, created.isoformat(), quiet)

    # ---- 逐日序列：一律铺满完整日历区间 ----
    stars_daily = fill_daily(star_days, created, today)
    forks_daily = fill_daily(fork_days, created, today)
    npm_daily = fill_daily(npm_days, parse_date(npm_start), parse_date(npm_end))

    # ---- traffic ----
    if skip_traffic:
        warn("按 --skip-traffic 跳过 traffic 接口", quiet)
        traffic = {"available": False, "note": "本次运行跳过了 traffic 接口。",
                   "window": {"from": None, "to": None, "days": 0}, "clones": [], "views": []}
    else:
        try:
            clones_raw, views_raw = fetch_traffic(repo, quiet)
            c_rows = clones_raw.get("clones") or []
            v_rows = views_raw.get("views") or []
            clones = [[iso_date(r["timestamp"]), int(r.get("count") or 0)] for r in c_rows if r.get("timestamp")]
            views = [[iso_date(r["timestamp"]), int(r.get("count") or 0)] for r in v_rows if r.get("timestamp")]
            traffic = {
                "available": bool(clones),
                "note": "GitHub 的 traffic 接口只保留最近 14 天，更早的数据无法取回；本页展示的就是这 14 天内的数据。",
                "window": {
                    "from": clones[0][0] if clones else None,
                    "to": clones[-1][0] if clones else None,
                    "days": len(clones),
                },
                "clones": clones,
                "views": views,
            }
        except FetchError as exc:
            warn("traffic 接口读不到（通常是没有 push 权限）：%s" % exc, quiet)
            traffic = {"available": False, "note": "traffic 接口读取失败，通常是当前 gh 账号对该仓库没有 push 权限。",
                       "window": {"from": None, "to": None, "days": 0}, "clones": [], "views": []}

    # ---- 每周提交 ----
    weekly = []
    for w in (commit_raw if isinstance(commit_raw, list) else []):
        ts = w.get("week")
        if ts is None:
            continue
        d = datetime.fromtimestamp(int(ts), tz=timezone.utc).date().isoformat()
        weekly.append([d, int(w.get("total") or 0)])

    # ---- Issue / PR 月度 ----
    i_open, i_close = Counter(), Counter()
    open_issues_excluding_prs = 0
    for it in (issues_raw if isinstance(issues_raw, list) else []):
        if not isinstance(it, dict) or "pull_request" in it:
            continue
        i_open[month_of(it.get("created_at") or "")] += 1
        if it.get("closed_at"):
            i_close[month_of(it["closed_at"])] += 1
        if it.get("state") == "open":
            open_issues_excluding_prs += 1

    p_open, p_close, p_merge = Counter(), Counter(), Counter()
    for pr in (pulls_raw if isinstance(pulls_raw, list) else []):
        if not isinstance(pr, dict):
            continue
        p_open[month_of(pr.get("created_at") or "")] += 1
        if pr.get("closed_at"):
            p_close[month_of(pr["closed_at"])] += 1
        if pr.get("merged_at"):
            p_merge[month_of(pr["merged_at"])] += 1

    months = sorted({m for m in list(i_open) + list(i_close) + list(p_open) + list(p_close) + list(p_merge) if m})

    # ---- 贡献者增删行数：按 login 合并进 contributors ----
    # 只保留总数，不把每人几十周的明细塞进 data.js
    stats_by_login = {}
    for row in (contributor_stats if isinstance(contributor_stats, list) else []):
        if not isinstance(row, dict):
            continue
        author = row.get("author") or {}
        login = author.get("login")
        if not login:
            continue
        adds = dels = 0
        for w in (row.get("weeks") or []):
            adds += int(w.get("a") or 0)
            dels += int(w.get("d") or 0)
        stats_by_login[login] = (adds, dels)

    for c in contributors:
        pair = stats_by_login.get(c.get("login"))
        if pair:
            c["additions"] = pair[0]
            c["deletions"] = pair[1]

    license_obj = repo_raw.get("license") or {}
    topics = repo_raw.get("topics") or []

    payload = {
        "_note": "本文件由 %s 抓取生成，请勿手改；数据源与口径见页面底部「数据源与已知偏差」。" % GENERATOR,
        "_schema": {
            "generated_at": "取数时刻，ISO 8601 UTC。页面用它显示数据截止时间，用于定位页面数据的新旧。",
            "series.stars_daily": "[日期(UTC, YYYY-MM-DD), 当日新增 Star] 二元组数组，累计曲线由页面自行累加得出",
            "series.forks_daily": "[日期, 当日新增 Fork] 二元组数组",
            "series.npm_daily": "[日期, 当日下载量] 二元组数组，含 CI / 镜像 / 爬虫流量",
            "repo": "gh api repos/%s 的快照字段" % repo,
            "contributors": "gh api repos/%s/contributors?per_page=100" % repo,
            "releases": "gh api repos/%s/releases --paginate" % repo,
            "sources": "每条指标对应的取数命令与已知偏差，页面底部原样展示",
        },
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "generated_by": GENERATOR,
        "timezone": "UTC",
        "repo": {
            "full_name": repo_raw.get("full_name"),
            "name": repo_raw.get("name"),
            "description": repo_raw.get("description") or "",
            "html_url": repo_raw.get("html_url"),
            "homepage": repo_raw.get("homepage") or "",
            "license": license_obj.get("spdx_id") if license_obj.get("spdx_id") not in (None, "NOASSERTION") else (license_obj.get("name") or ""),
            "default_branch": repo_raw.get("default_branch"),
            "language": repo_raw.get("language") or "",
            "created_at": repo_raw.get("created_at"),
            "pushed_at": repo_raw.get("pushed_at"),
            "size_kb": int(repo_raw.get("size") or 0),
            "stars": int(repo_raw.get("stargazers_count") or 0),
            "forks": int(repo_raw.get("forks_count") or 0),
            "forks_with_timestamp": fork_records,
            "watchers": int(repo_raw.get("subscribers_count") or 0),
            "open_issues": int(repo_raw.get("open_issues_count") or 0),
            "open_issues_excluding_prs": open_issues_excluding_prs,
            "topics": topics,
            "archived": bool(repo_raw.get("archived")),
        },
        "npm": {
            "package": pkg,
            "latest_version": (reg.get("dist-tags") or {}).get("latest") or "",
            "version_count": len(reg.get("versions") or {}),
            "registry_url": "https://www.npmjs.com/package/" + pkg,
            "first_publish": iso_date((reg.get("time") or {}).get("created") or ""),
            "self_reported": npm_point,
        },
        "series": {
            "stars_daily": stars_daily,
            "forks_daily": forks_daily,
            "npm_daily": npm_daily,
        },
        "traffic": traffic,
        "commits": {
            "note": "取自 stats/commit_activity 的 52 周；周起点为周日 00:00 UTC，最后一周未走完。",
            "weekly": weekly,
        },
        "contributors": contributors,
        "releases": releases,
        "issues": {
            "monthly": [
                {"month": m, "opened": i_open[m], "closed": i_close[m], "net": i_open[m] - i_close[m]}
                for m in months
            ]
        },
        "pulls": {
            "monthly": [
                {"month": m, "opened": p_open[m], "closed": p_close[m], "merged": p_merge[m]}
                for m in months
            ]
        },
        "sources": build_sources(repo, pkg),
    }

    stats = {
        "star_records": star_records,
        "fork_records": fork_records,
        "commit_weeks": len(weekly),
        "traffic_available": traffic["available"],
    }
    return payload, stats


# --------------------------------------------------------------------------
# 自检：把几个能对上的口径对一遍，只打印，不写进数据文件
# --------------------------------------------------------------------------
def self_check(payload: dict, stats: dict, quiet: bool) -> None:
    repo = payload["repo"]
    stars_sum = sum(v for _, v in payload["series"]["stars_daily"])
    forks_sum = sum(v for _, v in payload["series"]["forks_daily"])
    npm_sum = sum(v for _, v in payload["series"]["npm_daily"])
    npm_all = (payload["npm"]["self_reported"] or {}).get("last_year", {}).get("value")

    rows = [
        ("Star 累计终值 vs stargazers_count", stars_sum, repo["stars"]),
        ("Star 逐日合计 vs stargazers 接口条数", stars_sum, stats["star_records"]),
        ("Fork 逐日合计 vs forks_count", forks_sum, repo["forks"]),
        ("Fork 逐日合计 vs forks 接口条数", forks_sum, stats["fork_records"]),
    ]
    if npm_all:
        rows.append(("npm 逐日合计 vs 自报 last-year（窗口不同，允许不等）", npm_sum, npm_all))

    if quiet:
        return
    print("", file=sys.stderr)
    print("体检（左右两列一致即为 OK）：", file=sys.stderr)
    for name, a, b in rows:
        flag = "OK  " if a == b else "差异"
        print("  [%s] %-46s %9d  vs  %9d" % (flag, name, a, b), file=sys.stderr)
    print("  逐日序列天数：star=%d  fork=%d  npm=%d  |  提交周数=%d  traffic=%s" % (
        len(payload["series"]["stars_daily"]),
        len(payload["series"]["forks_daily"]),
        len(payload["series"]["npm_daily"]),
        stats["commit_weeks"],
        "有" if stats["traffic_available"] else "无",
    ), file=sys.stderr)


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------
def write_data_js(payload: dict, out_path: Path) -> int:
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    # 行分隔符在字符串字面量里对老解析器不友好，顺手转义掉
    body = body.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    text = DATA_HEADER + "window.__DSH_PET_DATA__ = " + body + ";\n"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # 先写临时文件再原子替换，避免抓取中途失败留下半个 data.js
    tmp_path = out_path.with_name(out_path.name + ".tmp")
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp_path, out_path)
    return len(text.encode("utf-8"))


def main(argv=None) -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(
        description="抓取 dsh-pet 的公开指标并写出 data.js（供同目录的 index.html 读取）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--repo", default=DEFAULT_REPO, help="owner/name，默认 %s" % DEFAULT_REPO)
    ap.add_argument("--npm", dest="npm_pkg", default=DEFAULT_NPM_PACKAGE,
                    help="npm 包名，默认 %s" % DEFAULT_NPM_PACKAGE)
    ap.add_argument("--out", default=str(here / "data.js"),
                    help="输出路径，默认脚本同目录的 data.js")
    ap.add_argument("--dry-run", action="store_true", help="只抓取并打印体检结果，不写文件")
    ap.add_argument("--skip-traffic", action="store_true", help="跳过只有 push 权限才能读的 traffic 接口")
    ap.add_argument("--quiet", action="store_true", help="不打印进度")
    args = ap.parse_args(argv)

    started = time.time()
    try:
        payload, stats = build_payload(args.repo, args.npm_pkg, args.quiet, args.skip_traffic)
    except FetchError as exc:
        print("抓取失败：%s" % exc, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("已中断，未写文件。", file=sys.stderr)
        return 130

    self_check(payload, stats, args.quiet)

    if args.dry_run:
        print("--dry-run：未写文件。", file=sys.stderr)
        return 0

    out_path = Path(args.out)
    size = write_data_js(payload, out_path)
    print("已写入 %s（%s 字节，耗时 %.1f 秒）" % (out_path, format(size, ","), time.time() - started),
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
