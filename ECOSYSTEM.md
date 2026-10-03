# 社区生态：移植与二创

本项目是运行在 DSH 里的透明动画桌宠，定位是「一行命令装好即用」，并内置可复现的 AI 素材生成链。

发布以来，社区把它移植到了多个平台，也基于本项目做出了不少改版与增强。下面按平台列出已知项目，功能细节、安装方式与许可请见各自仓库。

---

## 桌面端（独立运行，不依赖 DSH）

| 平台 | 项目 | 说明 |
|---|---|---|
| Windows / macOS / Linux | [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop) | 最早也最完整的独立移植：提供安装包、便携 zip 与 onedir 三种分发，含托盘、热切换、屏幕漫游，可选 AI 对话与 Agent 状态联动 |
| Windows | [Refining-colors/pet-with-you](https://github.com/Refining-colors/pet-with-you) | 保留 106 段动画，加入四种窗口模式、OpenAI 兼容聊天、Codex 桌面客户端联动与额度面板 |
| Windows | [Githao3/dsh-pet-desktop](https://github.com/Githao3/dsh-pet-desktop) | 把桌面模式解绑 DSH；支持用户级素材覆盖与 pet pack 多宠物 |
| Windows | [C2006L/dafeiyu](https://github.com/C2006L/dafeiyu) | Electron 版，本机 Ollama 驱动对话，也可切到 OpenAI 兼容接口 |
| macOS（Apple Silicon） | [williamhadeslee/better-dsh-pet-macos](https://github.com/williamhadeslee/better-dsh-pet-macos) | better-dsh-pet 的 macOS 适配 |
| macOS（Intel） | [prophet-chen/dsh-pet-intel-mac](https://github.com/prophet-chen/dsh-pet-intel-mac) | 面向 x86_64 Mac 重新实现，含 106 段动画与全局热键 |

## 移动端

| 平台 | 项目 | 说明 |
|---|---|---|
| Android | [OTFiles/dsh-pet-inAndroid](https://github.com/OTFiles/dsh-pet-inAndroid) | Kotlin + Compose 原生移植，动画链与拖拽物理 1:1 还原，Releases 提供签名 APK |
| Android | [FLT18355/dsh-pet-inAndroid](https://github.com/FLT18355/dsh-pet-inAndroid) | 上述版本的分支镜像，追加边缘探头、音效自选等细节 |
| iOS | [eazy-gyz/dspet-ios](https://github.com/eazy-gyz/dspet-ios) | PWA 与未签名 IPA 两种装法，素材取本项目的 HEVC-alpha `.mov` |

## DSH 插件（改版与增强）

| 项目 | 说明 |
|---|---|
| [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) | 用原生透明窗渲染，按真实会话事件切换 8 种状态；按 MIT 精选导入本项目 16 段动画，并随包附上游许可证原文 |
| [ysppwn721/better-dsh-pet](https://github.com/ysppwn721/better-dsh-pet) | 91 段动画，加入余额、番茄钟、喂食与离线语音唤醒（唤醒词默认「大肥鱼」） |
| [nanonocturne-altago/DeepSeek-Pet](https://github.com/nanonocturne-altago/DeepSeek-Pet) | 整合增强版：97 套动画、余额与记账、音效、悬停菜单，并兼容 Safari 的 HEVC-alpha 素材 |
| [RadmacHu/dsh-pet-des](https://github.com/RadmacHu/dsh-pet-des) | 插件版与 Electron 桌面版共用同一套素材，附《模型替换教程》与多形象切换 |
| [xiaonian001/dsh-pet-dfeiyu-mo](https://github.com/xiaonian001/dsh-pet-dfeiyu-mo) | 语音增强：多音色、Edge TTS、声音克隆与系统通知播报 |
| [tangcaolizhi/DeepSeek](https://github.com/tangcaolizhi/DeepSeek) | 基于 dsh-dafeiyu 的帧动画版本，含会话状态机与余额气泡 |
| [C0p1er/dsh-whale-pet](https://github.com/C0p1er/dsh-whale-pet) | 把 dsh-dafeiyu 的桌宠移植到 DSH Web 右下角 |
| [hairyf/dsh-pet-component](https://github.com/hairyf/dsh-pet-component) | React 组件，在同一处消费 dsh-pet 与 Codex Pet 两套桌宠协议 |

## 其它平台与配套工具

| 形态 | 项目 | 说明 |
|---|---|---|
| pi 平台 | [SOMWHY/pi-dsh-pet](https://github.com/SOMWHY/pi-dsh-pet) | 为 pi 适配的版本，91 段动画与 `/pet` 系列命令，跟随 agent 状态切换 |
| Web | [梗鲸 GengJing](https://aigengtu.com/)（图源仓库 [meme-pack](https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack)） | 站点主体是 DeepSeek-chan 梗图库与档案馆；其「大肥鱼乐园」小游戏区里的[网页桌宠](https://aigengtu.com/games/pet)使用本项目动画素材，页脚已署名 |
| 素材转码 | [dsh-tauri/dsh-pet-mov](https://github.com/dsh-tauri/dsh-pet-mov) | 把透明 VP9 WebM 批量转码为 HEVC-alpha `.mov`，供 Safari / WKWebView 使用，并跟随上游更新 |
| 桌面客户端 | [dsh-tauri/deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) | Tauri 2 桌面客户端（约 5MB 安装包，零环境配置），内置 [dsh-pet-component](https://github.com/dsh-tauri/dsh-pet-component) 与上述转码素材 |

---

## 采用与影响力

**使用规模**

| 指标 | 数值 | 来源 |
|---|---|---|
| npm 安装量 | ≈ 2.9 万次 / 30 天 | npm registry |
| GitHub ⭐ / fork | 989 / 74 | GitHub |
| 社区移植与二创 | 20+ 个项目，覆盖桌面、移动、网页与其它 Agent 平台 | 见上文清单 |
| 第三方集成 | 被 ⭐2974 的 DSH 桌面客户端 [deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) 作为预置桌宠插件内置 | 该仓库 |
| 插件目录收录 | [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/PC2005-cloud/dsh-pet--dsh-pet/)（收录 4,412 个插件）、[dshbase](https://dshbase.com/zh/plugins/dsh-pet/)（标注「已验证 实测可装」）、dsh-market 等 | 各目录站 |

**社区项目数据**

| 项目 | ⭐ | fork |
|---|---|---|
| [dsh-tauri/deepseek-harness-desktop](https://github.com/dsh-tauri/deepseek-harness-desktop) | 2974 | 199 |
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（本项目） | 989 | 74 |
| [MerZlin/dsh-pet-indesktop](https://github.com/MerZlin/dsh-pet-indesktop) | 725 | 53 |
| [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu) | 387 | 29 |
| [deepseek-chan-meme-pack](https://github.com/the-beating-light-of-the-nail/deepseek-chan-meme-pack)（梗鲸图源仓库） | 53 | 2 |

> 仅列出 ⭐ 50 以上的项目；数据为 2026-10-03 快照。

**社区传播**

- B 站手机版演示视频：播放 12.4 万、点赞 9,908、收藏 9,415；
- B 站「桌面版大肥鱼」合集（UP：張墨林 / MerZlin）：单集播放 6.2 万；
- 本项目发布视频：约 5 万播放。

---

> 整理于 2026-10-03，收录社区已知的移植与二创项目。
