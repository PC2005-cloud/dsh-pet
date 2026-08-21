# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=monthly&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=total&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-dynamic%20animations-ff69b4">
</p>

A desktop pet living inside the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI: idle breathing, random actions (including dozing off), occasional turns, screen wandering, click reactions, and draggable.

This is not just a plugin — it's a **complete three-piece project**:

```
① Prompts (recipe)      →  ② Asset pipeline (engine)  →  ③ Plugin (product)
AI animation prompts        source video → transparent       the pet running in DSH
```

Anyone who clones this repository can **generate their own desktop pet from scratch** — swap characters, actions, and styles; the whole pipeline is reproducible.

---

## Quick Start (Install the Plugin)

> All commands below run in your **terminal** (PowerShell, CMD, etc.). First make sure the DSH environment is ready:

```sh
# ① Prerequisites: confirm Node.js is installed
node -v

# ② Install the DSH launcher and pnpm (skip if already installed; reopen your terminal afterwards)
npm install -g @deepseek-ai/dsh pnpm
dsh --version   # verify the dsh command works

# ③ Install this plugin
dsh plugin --profile web add dsh-pet
```

Restart `dsh web` and the pet appears in the bottom-right corner.

> **Compatibility**: this plugin is developed and tested with dsh **`0.1.1-rc.1`** (check yours with `dsh --version`). Using the same version is recommended; please report any issues on other versions.

## Generate Your Own Pet from Scratch (Full Pipeline)

### ① Prompts → Source Videos

Use an AI video generation tool (e.g., Kling, Runway, Doubao — this project's assets were generated with Doubao) with the recipes in `prompts/桌面宠物 10 秒动作提示词.md` to generate one ten-second green-screen video per action:

- Video ratio 16:9 with a pure green background (#00FF00)
- Fixed character position/size (head top at ~20% height, feet bottom at ~85% height)
- The action stays fully inside the frame; the first and last frames are standard front-facing standing
- Each animation is broken down by second (per-stage actions for 0–10s)

Put the results into `video/` (one mp4 per action).

> **Getting the source videos**: to keep the repo small, `video/` sources are not committed. Releases provide **zipped bundles** you can download directly in the browser:
>
> - `assets-videos.zip` — all source videos (Chinese-named mp4s; extract and put them into `video/`)
> - `pr-project.zip` — the PR hand-keying project (`.prproj` + mask cache, optional; reference for Track B keying)
>
> Extract with `Expand-Archive assets-videos.zip` (Windows) or `unzip assets-videos.zip`, then put the mp4s back into `video/` — the pipeline is ready to run.

### ② Source Videos → Transparent Animations (Asset Pipeline)

step02 (transparent video) has **two tracks, pick one per action** (automatic by default and reproducible by anyone; PR hand-keying as a quality override):

```sh
cd scripts
# Track A (default): automatic green-screen keying (HSV hue, no manual work)
python watermark_step01.py   # fill watermark masks → step01/
python chroma_step02.py      # chroma-key the green screen to transparency → step02/

# Track B (optional): PR hand-keying override (for actions with 3rd-party props
#                     or where auto keying looks bad)
#   1. Hand-key in Premiere Pro, export a transparent .mov with alpha
#      (e.g. ProRes 4444 with Alpha)
#   2. Put it in pr/ with the action's name (e.g. 吃白饭.mov)
python pr_import_step02.py   # pr/*.mov → step02/ (transparent webm, overrides the auto result)

# The rest of the pipeline is shared by both tracks:
python normalize_step03.py   # normalize to 2160×1215 unified standing, centered → step03/
python encode_thumbs.py      # transcode 640×360 playback variants → step04/
```

**Dependencies**: Python 3 + ffmpeg + numpy + scipy (the pipeline scripts automatically use the ffmpeg under the workspace `.tools/`).

> **This project uses Track B for all 91 actions** (every action is PR hand-keyed): for actions with 3rd-party props or complex transparent edges, automatic HSV keying tends to leave fringes or mis-key pixels, while manual masks in PR are far cleaner. Both tracks produce the same `step02/` level, so everything downstream is identical; `chroma_step02.py` is kept as the automatic fallback so any action can still be generated with one command.

### ③ Animations → Plugin

```sh
# Sync the step04 playback variants into the plugin package
cp step04/*.webm dsh-pet/assets/thumb/

# Install the plugin locally
dsh plugin --profile web add file:D:/path/to/dsh-pet
```

> Intermediate products (step01-04) are generated by scripts and not committed to the repo; `video/` source videos and scripts are deliverables and maintained in the repo.

---

## Project Structure

```
├── prompts/                 # ① Generation prompts for the actions (green-screen spec + per-second breakdown)
├── scripts/                 # ② Asset pipeline (Python: watermark/keying/normalize/transcode, incl. PR import)
├── video/                   # ② Source videos (green-screen mp4s, one per action + watermark mask; not committed, zipped on Releases)
├── pr/                      # ② Track B input: PR-exported transparent .mov (local working data, not committed)
├── prproj/                  # ② PR project directory (.prproj + mask cache + auto-saves, local, not committed)
├── tools/                   # Dev tools: preview.html (pipeline stage previews)
├── dsh-pet/                 # ③ The plugin (can be published to npm independently)
│   ├── src/                 #   TS sources (host half: /pet routes; client half: animation chain)
│   ├── lib/                 #   tsdown build output (auto-built on install; lib/*.js not committed)
│   ├── assets/thumb/        #   640×360 transparent playback animations
│   ├── assets/preview/      #   GIF previews (for README display, pinyin filenames)
│   └── scripts/prepack-check.js  # pre-publish health check
├── DESIGN.md                # Design & implementation docs
└── LICENSE                  # MIT
```

## Plugin Features

- **A pure pet, nothing else**: no business features bolted on — no weather lookups, no system monitoring, no agent-state sensing; it just keeps you company. Zero core changes (never touches the DSH kernel) and zero model cost (no LLM/API calls at runtime)
- **Animation chain**: each animation (idle included) is immediately followed by a weight-based pick (weights live in `config.jsonc`; default idle 10 / turn 5 / move 5 + per-category weights), endless and seamless
- **Multi-pet**: configure multiple pets at once, each with its own size and position (add/remove in the "Pet Config" settings page)
- **Screen wandering**: walks toward its facing direction, checks the space ahead, never walks off screen
- **Click/drag**: click for a reaction animation; drag anywhere
- **Left/right facing**: all animations can be mirrored; the character can face left or right
- **Ground alignment**: animations share a unified foot line, the pet always stands on the ground
- **Smooth switching**: double-buffered cross-fade, no blank frames between transitions

## ⚙️ Configuration (Size / Position / Multi-pet)

The pet's size, position and multi-pet setup can be configured in two ways:

### Via the settings page (recommended)
DSH Settings → **Pet Config**:

- **Size**: width in px (height is automatic = width × 9/16)
- **Position**: one of four corners (corner) plus horizontal/vertical margins (marginX / marginY)
- **Multi-pet**: add/remove pets; each pet has its own id, size and position
- **Save** applies **instantly** (no page refresh needed); **Reset to default** restores the `config.jsonc` defaults

### Via config.jsonc (single source of truth)
The `pets` array in `dsh-pet/assets/config.jsonc` defines the **default pets**:

```jsonc
"pets": [
  { "id": "main", "size": 462, "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } }
]
```

- Each pet: `id` (identifier) / `size` (width px) / `position` (corner + marginX/marginY)
- Changes made in the settings page are saved to the user layer `$DSH_HOME/pet-config.json` (a **full pet list** that overrides the package defaults); "Reset to default" removes it and falls back to `config.jsonc`

## Running Screenshots

What the pet looks like running inside the DSH Web UI:

<p>
  <img src="assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet running in DSH Web UI 1" title="dsh-pet running in DSH Web UI 1">
  <img src="assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet running in DSH Web UI 2" title="dsh-pet running in DSH Web UI 2">
</p>

## Animation Previews

All animations (640×360, the actual assets the plugin plays) — GIF previews live in the repo at `dsh-pet/assets/preview/` (rendered via raw links, pinyin filenames for cross-platform safety); the full transparent videos live in `dsh-pet/assets/thumb/`:

**Idle / Turning**

<p>
  <img src="dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="Idle breathing & chill" title="Idle breathing & chill">
  <img src="dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="Looking around" title="Looking around">
</p>

**Movement**

<p>
  <img src="dsh-pet/assets/preview/pangxie-zoulu.gif" width="160" alt="Crab walk" title="Crab walk">
  <img src="dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="Floating in place" title="Floating in place">
  <img src="dsh-pet/assets/preview/yuandi-zuozhuan-benpao.gif" width="160" alt="Sprinting in place" title="Sprinting in place">
</p>

**Actions**

<p>
  <img src="dsh-pet/assets/preview/youxian-hengga.gif" width="160" alt="Humming a tune" title="Humming a tune">
  <img src="dsh-pet/assets/preview/chaoda-shenlanyao.gif" width="160" alt="Big stretch" title="Big stretch">
  <img src="dsh-pet/assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="160" alt="Playing with a Rubik's cube" title="Playing with a Rubik's cube">
  <img src="dsh-pet/assets/preview/yuandi-qiaoji-zhuomian-hudong.gif" width="160" alt="Tapping the desk" title="Tapping the desk">
  <img src="dsh-pet/assets/preview/yuandi-zhongli-xiadun-yasuo.gif" width="160" alt="Gravity squat" title="Gravity squat">
  <img src="dsh-pet/assets/preview/haqian-liantian.gif" width="160" alt="Yawning" title="Yawning">
  <img src="dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="Napping" title="Napping">
  <img src="dsh-pet/assets/preview/yuandi-dunxia-wan-wanju-qiche.gif" width="160" alt="Playing with a toy car" title="Playing with a toy car">
  <img src="dsh-pet/assets/preview/jingyu-tu-paopao-texiao.gif" width="160" alt="Whale blowing bubbles" title="Whale blowing bubbles">
  <img src="dsh-pet/assets/preview/nvpu-quxi-liyi.gif" width="160" alt="Maid curtsy" title="Maid curtsy">
  <img src="dsh-pet/assets/preview/beixiayitiao-zhamao.gif" width="160" alt="Startled (fur standing up)" title="Startled (fur standing up)">
  <img src="dsh-pet/assets/preview/yuandi-tiaoyue-zhuasui-touding-wupin.gif" width="160" alt="Jumping to smash something overhead" title="Jumping to smash something overhead">
  <img src="dsh-pet/assets/preview/xiaofudu-yuandi-360du-xuanzhuan-zhanshi.gif" width="160" alt="Slow 360° spin" title="Slow 360° spin">
  <img src="dsh-pet/assets/preview/touchi-lingshi-bei-zhuazhu.gif" width="160" alt="Caught sneaking snacks" title="Caught sneaking snacks">
  <img src="dsh-pet/assets/preview/wan-youxi-qijibaituai.gif" width="160" alt="Frustrated at a game" title="Frustrated at a game">
  <img src="dsh-pet/assets/preview/yong-jingyu-weiba-paidadi.gif" width="160" alt="Slapping the floor with the whale tail" title="Slapping the floor with the whale tail">
  <img src="dsh-pet/assets/preview/da-keshui-bei-jingxing.gif" width="160" alt="Woken from a doze" title="Woken from a doze">
  <img src="dsh-pet/assets/preview/wan-shuiqiang.gif" width="160" alt="Playing with a water gun" title="Playing with a water gun">
  <img src="dsh-pet/assets/preview/xiaotiqin-yanzou.gif" width="160" alt="Playing the violin" title="Playing the violin">
  <img src="dsh-pet/assets/preview/lanjing-xianshi.gif" width="160" alt="Whale emerging" title="Whale emerging">
  <img src="dsh-pet/assets/preview/chi-baifan.gif" width="160" alt="Eating rice" title="Eating rice">
  <img src="dsh-pet/assets/preview/zhao-jingzi.gif" width="160" alt="Looking in the mirror" title="Looking in the mirror">
  <img src="dsh-pet/assets/preview/youya-nvpuwu.gif" width="160" alt="Elegant maid dance" title="Elegant maid dance">
  <img src="dsh-pet/assets/preview/qingkuai-yaobaiwu.gif" width="160" alt="Lighthearted sway dance" title="Lighthearted sway dance">
  <img src="dsh-pet/assets/preview/keai-zhaiwu.gif" width="160" alt="Cute anime dance" title="Cute anime dance">
  <img src="dsh-pet/assets/preview/zhengti-huanzhuang-shise.gif" width="160" alt="Trying on outfits" title="Trying on outfits">
  <img src="dsh-pet/assets/preview/dakou-chi-lingshi.gif" width="160" alt="Munching snacks" title="Munching snacks">
  <img src="dsh-pet/assets/preview/chui-qiqiu.gif" width="160" alt="Blowing a balloon" title="Blowing a balloon">
  <img src="dsh-pet/assets/preview/dongwu-huanrao.gif" width="160" alt="Animals circling around" title="Animals circling around">
  <img src="dsh-pet/assets/preview/shendu-sikao-suisuinian.gif" width="160" alt="Deep thinking & muttering" title="Deep thinking & muttering">
  <img src="dsh-pet/assets/preview/qingkuai-jilu.gif" width="160" alt="Taking light notes" title="Taking light notes">
  <img src="dsh-pet/assets/preview/xie-daima.gif" width="160" alt="Writing code" title="Writing code">
</p>

**Click Responses**

<p>
  <img src="dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="Click response - happy bounce" title="Click response - happy bounce">
  <img src="dsh-pet/assets/preview/dianji-huiying-haixiu-jingya.gif" width="160" alt="Click response - shy surprise" title="Click response - shy surprise">
  <img src="dsh-pet/assets/preview/dianji-huiying-aojiao-shengqi-ceshen-zhanshi.gif" width="160" alt="Click response - tsundere pout" title="Click response - tsundere pout">
</p>

**Dragging**

<p>
  <img src="dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="Dragged by the mouse" title="Dragged by the mouse">
</p>

> Note: the animations have transparent backgrounds; in these GIF previews the transparent areas show the page background color, while the actual webm playback is transparent.

## Documentation

- [Design & Implementation](DESIGN.md) — architecture, animation-chain model, asset pipeline

## License

- Code: MIT
- Assets (animations/prompts/source videos): open-source use permitted, **no commercial use**
