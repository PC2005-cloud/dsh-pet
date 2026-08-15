# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=monthly&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=total&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-41%20animations-ff69b4">
</p>

> A floating desktop pet for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI: idle breathing, random actions (including dozing off), occasional turns, screen wandering, click reactions, and draggable.

---

## 🚀 Quick Start (Install the Plugin)

```sh
dsh plugin --profile web add dsh-pet
```

Restart `dsh web` and the pet appears in the bottom-right corner — 41 transparent animations, ready to use out of the box, no generation pipeline required.

> 💡 Want to craft your own one-of-a-kind pet? Clone [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) and use the bundled asset pipeline (AI prompts → green-screen video → transparent animation, generated with Doubao) to generate one from scratch — fully reproducible.

## ✨ Features

- **A pure pet, nothing else**: no business features — no weather, no monitoring, no agent-state sensing; just a companion. Zero core changes, zero model cost (no LLM/API calls at runtime)
- **41 hand-drawn style transparent animations**: idle breathing, dozing off, playing with a Rubik's cube, humming, hair-raising, blowing bubbles, playing with a water gun, playing violin, the whale emerging, eating rice, looking in the mirror, three dances, writing code… all seamlessly chained
- **Never-ending animation chain**: when each animation finishes, the next one is picked instantly by probability (30% idle / 10% turn / 40% action / 20% move)
- **Screen wandering**: walks toward its facing direction, checks the space ahead and never walks off screen
- **Click / drag**: click triggers a random reaction animation (happy / shy / tsundere); drag it anywhere
- **Left/right facing**: all animations are CSS-mirrored, the pet can face left or right
- **Ground alignment**: animations share a unified foot line, the pet always stands on the "ground"
- **Smooth transitions**: double-buffered video cross-fade, zero blank frames between switches
- **Accessibility-friendly**: supports `prefers-reduced-motion`

## ⚙️ Configuration

| Key | Description | Current status |
|---|---|---|
| `size` | Pet display height (px) | Default 260, **not yet delivered to the browser** (DSH client config pipeline limitation; falls back to code default) |
| `position` | Default corner position | Defaults to bottom-right, same as above (not yet delivered) |
| `fullRoot` | Original 1200×1200 master asset directory | Defaults to `$DSH_HOME/pet-assets`; takes effect after manually downloading the master assets |

> Note: the plugin works out of the box; all config above is optional. Browser-side configuration of `size`/`position` is planned.

## 🗑️ Uninstall

```sh
dsh plugin --profile web remove dsh-pet
```

## 🖥️ Running Screenshots

What the pet looks like running inside the DSH Web UI:

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet running in DSH Web UI 1" title="dsh-pet running in DSH Web UI 1">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet running in DSH Web UI 2" title="dsh-pet running in DSH Web UI 2">
</p>

## 🎬 Animation Previews

> The animations have transparent backgrounds; in these GIF previews the transparent areas show the page background color, while the actual playback (webm) is transparent.

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E5%BE%85%E6%9C%BA%E5%91%BC%E5%90%B8%E4%BC%91%E9%97%B2.gif" width="160" alt="Idle breathing & chill" title="Idle breathing & chill">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E4%B8%9C%E5%BC%A0%E8%A5%BF%E6%9C%9B.gif" width="160" alt="Looking around" title="Looking around">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E5%8E%9F%E5%9C%B0%E6%BC%82%E6%B5%AE%E8%B8%8F%E6%AD%A5.gif" width="160" alt="Floating in place" title="Floating in place">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E5%8E%9F%E5%9C%B0%E5%B0%8F%E6%86%A9%E6%B2%89%E7%9C%A0.gif" width="160" alt="Napping" title="Napping">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E7%82%B9%E5%87%BB%E5%9B%9E%E5%BA%94%20-%20%E5%BC%80%E5%BF%83%E8%B7%83%E5%8A%A8.gif" width="160" alt="Click response - happy bounce" title="Click response - happy bounce">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/%E8%A2%AB%E9%BC%A0%E6%A0%87%E6%8B%96%E6%8B%BD%E6%82%AC%E7%A9%BA%E5%8F%8D%E9%A6%88.gif" width="160" alt="Dragged by the mouse" title="Dragged by the mouse">
</p>

All 41 animations live in the repo under `dsh-pet/assets/thumb/`.

## 📚 A Complete Project (More Than a Plugin)

This is a **complete three-piece project** — anyone can clone the repo and generate their own desktop pet from scratch:

```
① Prompts (recipe)      →  ② Asset pipeline (engine)  →  ③ Plugin (product)
AI animation prompts        source video → transparent       the pet running in DSH
```

- Repository: [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
- Design & implementation docs: [DESIGN.md](https://github.com/PC2005-cloud/dsh-pet/blob/master/DESIGN.md)

## 🔎 Discover More DSH Plugins

- Community plugin catalog: [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)
- DSH official repository: [deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)

## 📄 License

- Code: MIT
- Assets (animations/prompts): see the repository notes
