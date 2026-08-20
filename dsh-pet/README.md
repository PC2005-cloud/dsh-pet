# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=%E6%9C%88%E4%B8%8B%E8%BD%BD&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=%E6%80%BB%E4%B8%8B%E8%BD%BD&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-dynamic%20animations-ff69b4">
</p>

> A floating desktop pet for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI.
> 一只住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面里的桌面宠物：待机呼吸、随机动作（含打瞌睡）、偶尔转向、屏幕漫游、点击反应、可拖拽。

---

## 🚀 快速开始（安装插件）

```sh
dsh plugin --profile web add dsh-pet
```

重启 `dsh web`，宠物出现在界面右下角——全部透明动画开箱即用，无需任何生成流程。

> 💡 想自己造一只专属宠物？克隆 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 仓库，用内置素材链（AI 提示词 → 绿幕视频 → 透明动画，素材由豆包生成）从零生成，全流程可复现。

## ✨ 功能特性

- **纯粹的桌宠**：不掺业务功能——没有天气查询、系统监控、Agent 状态感知，就一件事：陪你。零核心改动、零模型成本（运行时零 LLM/API 调用）
- **手绘风透明动画**：待机呼吸、打瞌睡、玩魔方、哼歌、炸毛、吐泡泡、玩水枪、小提琴演奏、蓝鲸现世、吃白饭、照镜子、三支舞、写代码、四季动作（放风筝、堆雪人、吃冰淇淋、放烟花……）全部无缝衔接
- **永不停止的动画链**：每段动画播完立即按概率选下一个（30% 待机 / 10% 转向 / 40% 动作 / 20% 移动）
- **屏幕漫游**：朝 facing 方向行走，自动检查空间、不走出屏幕
- **点击 / 拖拽**：点击有随机回应动画（开心 / 害羞 / 傲娇），可拖到任意位置
- **左右朝向**：所有动画 CSS 镜像，人物可朝左 / 朝右
- **落地对齐**：动画统一脚底线，宠物始终站在"地面"上
- **流畅切换**：双缓冲 video 交叉淡入，切换零空白帧
- **无障碍友好**：支持 `prefers-reduced-motion`

## ⚙️ 配置

| 配置项 | 说明 | 当前状态 |
|---|---|---|
| `size` | 舞台宽度（px），宠物高度 = 宽度×9/16×74% | 默认 462（≈高度 260px），**暂未下发到浏览器**（DSH 客户端配置管线限制，走代码默认值） |
| `position` | 默认角落位置 | 默认右下角，同上暂未下发 |
| `fullRoot` | 原始 2160×1215 母版资源目录 | 默认 `$DSH_HOME/pet-assets`，需手动下载母版后生效 |

> 说明：插件安装即用，上述配置均为可选；`size`/`position` 的浏览器侧配置化正在规划中。

## 🗑️ 卸载

```sh
dsh plugin --profile web remove dsh-pet
```

## 🖥️ 运行效果

宠物实际运行在 DSH Web 界面中的样子：

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet running in DSH Web UI 1" title="dsh-pet running in DSH Web UI 1">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet running in DSH Web UI 2" title="dsh-pet running in DSH Web UI 2">
</p>

## 🎬 效果预览

> 动画为透明背景；GIF 预览中透明部分显示为页面底色，实际播放为透明。

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="待机呼吸休闲" title="待机呼吸休闲">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="东张西望" title="东张西望">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="原地漂浮踏步" title="原地漂浮踏步">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="原地小憩沉眠" title="原地小憩沉眠">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="点击回应 - 开心跃动" title="点击回应 - 开心跃动">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="被鼠标拖拽悬空反馈" title="被鼠标拖拽悬空反馈">
</p>

全部动画见仓库：`dsh-pet/assets/thumb/`。

## 📚 完整项目（不止是插件）

这是**完整的三件套项目**，任何人 clone 仓库都可以从零生成自己的桌面宠物：

```
① 提示词（配方）    →  ② 素材生成链（引擎）  →  ③ 插件（成品）
AI 生成动画的配方     源视频 → 透明动画的管线    运行在 DSH 里的宠物
```

- 仓库：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
- 设计与实现文档：[DESIGN.md](https://github.com/PC2005-cloud/dsh-pet/blob/master/DESIGN.md)

## 🔎 发现更多 DSH 插件

- 社区插件目录：[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)
- DSH 官方仓库：[deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)

## 📄 许可

- 代码：MIT
- 素材（动画/提示词）：见仓库说明
