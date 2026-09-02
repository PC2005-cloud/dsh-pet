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

> A floating desktop pet for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI: idle breathing, random actions (the 97 hand-drawn transparent animations — dozing off, playing with a Rubik's cube, writing code, hotpot…), turns, screen wandering, squash-and-stretch click reactions, throw-and-bounce drag physics, a right-click menu to play any action on demand, balance animations with a thinking bubble — spawn as many pets as you want, live on your **desktop** (transparent always-on-top window), or add **brand-new pet species** (pet pack).
> 一只住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的桌面宠物：待机呼吸、随机动作（打瞌睡、玩魔方、写代码、吃火锅……97 个手绘风透明动画随时无缝衔接）、左右转向、屏幕漫游、点击 Q 弹、拖拽甩抛反弹、右键菜单点播动作、余额动画 + 头顶联想气泡——可多开同屏，能脱离浏览器住上**桌面**（透明置顶小窗），也能自己添加**全新宠物种类**（pet pack）。

---

## 🚀 快速开始（安装插件）

```sh
dsh plugin --profile web add dsh-pet
```

重启 `dsh web`，宠物出现在界面右上角（默认配置角落，可在设置页修改）——全部透明动画开箱即用，无需任何生成流程。

> 💡 单一格式（无运行时浏览器判断，源码写死 `.webm`）：只内置 `.webm`（VP9-alpha），浏览器 Chrome/Edge/Firefox 与桌面模式（Electron=Chromium）共用。Safari 不认 webm alpha（黑底）；需要 Safari/HEVC 兼容请 fork 仓库启用保留的流水线（`scripts/encode_hevc_alpha.sh` + `hevc-alpha.yml`）并自行在宿主路由加回 `.mov` 分支（`src/host/index.ts` 的 thumb 路由），插件本体不发布、不支持 `.mov`。

> 💡 想自己造一只专属宠物？克隆 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 仓库，用内置素材链（AI 提示词 → 绿幕视频 → 透明动画，素材由豆包生成）从零生成，全流程可复现。

## ✨ 功能特性

- **纯粹的桌宠**：不掺业务功能——没有天气查询、系统监控、Agent 状态感知，就一件事：陪你（外加可选的余额展示与系统通知，见配置节）。零核心改动、零模型成本（运行时零 LLM/API 调用）
- **手绘风透明动画**：待机呼吸、打瞌睡、玩魔方、哼歌、炸毛、吐泡泡、玩水枪、小提琴演奏、蓝鲸现世、吃白饭、照镜子、三支舞、写代码、四季动作（放风筝、堆雪人、吃冰淇淋、放烟花……）全部无缝衔接
- **永不停止的动画链**：每段动画播完立即按权重选下一个（默认 idle 10 / turn 5 / move 5，剩余 80% 归随机动作分类）
- **屏幕漫游**：朝 facing 方向行走，自动检查空间、不走出屏幕
- **点击 / 拖拽（弹簧跟手 + 甩抛反弹 + Q 弹）**：点击有随机回应动画（开心 / 害羞 / 傲娇）并「**Q 弹**」挤压回弹（垂直压扁 55% → easeOutBack 回弹过冲，贴地锚定）；拖拽为**过阻尼弹簧跟手**（不抖不飘、无 overshoot）；松手按最后轨迹估速（停顿/慢速 = 温柔放下原地停住）——**用力甩出即沿抛物线飞行：撞屏幕边缘按恢复系数反弹、落地摩擦减速至停，每次落地按冲击速度 Q 弹（轻落 0.8 ~ 重砸 0.55）**；物理与挤压曲线纯函数在 `src/shared/physics.ts`，浏览器与桌面严格同一手感（`prefers-reduced-motion` 时跳过挤压）
- **物理参数化（0.2.5）**：拖拽抛掷手感全部由配置 `physics` 段驱动——重力（`gravity`，**0 = 无重力漂浮**）/ 碰壁恢复系数（`restitution`）/ 地面摩擦（`groundFriction`，0 = 冰面）/ 顶部反弹开关（`ceilingBounce`）/ 总力度（`throwPower`）/ 多宠物碰撞开关（`petCollision`），所有宠物全局共用（见配置节）
- **点击积分（0.2.5）**：飞行中的宠物被**按下**（速度 ≥ 400px/s）→ 点击处爆开粒子 + 弹出积分卡片；分数 = 速度/100 × 462/大小（线性，越快/越小分越高——小宠物目标小、更难命中，奖励更高）；静止/慢速点击维持普通点击回应动画（`prefers-reduced-motion` 时跳过粒子）
- **多宠物碰撞（0.2.5）**：`petCollision: true` 开启后，飞行中的宠物撞到其它宠物按**动量守恒 + 恢复系数 0.995** 弹开（质量 ∝ size²，被撞方从落点以新初速抛出去），浏览器与桌面跨窗口同语义（默认关闭）
- **右键级联菜单**：右键宠物弹出（桌面与浏览器共用同一份组件，`src/shared/menu.ts`）——桌面端根项「**打开网站** / **查看余额** / **回到初始位置** + **动作**」、浏览器端「**回到初始位置** + **动作**」；「打开网站」用**系统默认浏览器**打开 DSH 网站（等效网页里 Ctrl+点击链接）；「查看余额」立即拉余额弹气泡播档位动画（与周期触发同一展示路径）；「回到初始位置」停漫游回配置角落；**动作 → 分类 → 具体动画**（分类 = 待机/转向/拖拽/点击回应/移动/随机动作分类/余额档位；**点播「移动」分类动画会真实行走一段**——边界检查/随机距离/起停时段与随机移动完全一致；noMirror 文字类朝右时自动强制朝左）——浏览器端只在宠物命中区拦截右键（`preventDefault`），完全不进入/改动 DSH 页面自己的菜单
- **左右朝向**：所有动画 CSS 镜像，人物可朝左 / 朝右
- **落地对齐**：动画统一脚底线，宠物始终站在"地面"上
- **流畅切换**：双缓冲 video 交叉淡入，切换零空白帧
- **无障碍友好**：支持 `prefers-reduced-motion`
- **多开**：可配置多个宠物同屏，每只独立的 id/大小/位置/余额开关/显示位置（设置页「桌宠配置」添加/删除）
- **桌面模式（可选）**：可脱离浏览器住上桌面——透明置顶局部小窗，与浏览器严格同行为（见下节）
- **余额展示**：实时显示余额/额度，按档位播动画 + 头顶联想气泡，每只宠物可独立开关
- **额外宠物种类（pet pack）**：在 `pet/` 自建「种类」（独立动画池 + 自己的素材），多实例共享，与主宠物严格隔离（见配置节）
- **自定义动画**：`main-animation/webm/` 放 VP9-Alpha `.webm` 即作为新动画，优先于包内素材

## 🪟 桌面模式（脱离浏览器，可选）

默认情况下宠物住在 DSH 网页里（浏览器 overlay）。安装后还会**自动拉起一个脱离浏览器的桌面形态**：

- **独立透明置顶窗口**：为**每只桌面宠物**各开一个**局部小窗口**（尺寸 = 宠物包围盒 + 四周外扩余量，为气泡/弹窗预留空间；透明、置顶、跳过任务栏），窗口跟随宠物移动；窗口**永不铺满屏幕**（全屏透明分层窗会触发 Windows DWM 视频合成黑屏，实测小窗不黑）。与浏览器一致，只有宠物**身体命中区**可交互，窗口内其余透明像素与窗口外一律**点击穿透**到下层应用（`setIgnoreMouseEvents` + 悬停命中翻转）
- **与浏览器严格同行为**（同一份源码两个外壳）：宠物功能/文案完全对齐——多开宠物同屏显示、角落+边距定位、同一动画链/点击/拖拽/余额档位动画与富余额气泡；**页面配置的显示位置由 `display` 字段决定，两端宠物内容只可能一致，不会出现"一个有另一个没有"**。系统通知是独立于宠物的能力（见配置节 `notificationsEnabled`），不在此列
- **共享纯逻辑**：待机选择 / 移动几何 / 余额折算 / 配置校验 / 通知映射都在 `src/shared/`，浏览器 bundle 与桌面 `shared-core.js`（构建产物，`window.PetShared`）共用同一份源码，只有最外层的渲染壳不同（React vs 纯 DOM）

### 桌面模式怎么装 / 关

- **依赖 Electron**：首次拉起时自动探测（`DSH_PET_ELECTRON_PATH` 环境变量 → 本机 electron 包 → `~/.dsh/electron/` 落地路径），找不到会通过官方 @electron/get 自动下载到 `~/.dsh/electron/`（`npm run ensure:electron` 可手动触发）；Electron 不可用时仅日志告警，**不影响浏览器形态**
- **开关 = 每只宠物的 `display` 字段（pets 必填，四个值）**：
  - `web` = 仅浏览器 overlay / `desktop` = 仅桌面模式 / `both` = 两者都显示 / `none` = 都不显示
  - 桌面模式渲染 `display` 含 `desktop` 的**全部**宠物（多开同屏，与浏览器一致）；大小/位置各自读自己的配置
  - 在 DSH 设置页「桌宠配置」编辑，保存即时生效；`display` 缺失/非法即配置错误，**代码不做兜底**
- 桌面与浏览器是**同一套动画素材**（`/dsh-pet-7340/thumb/<前缀>/<name>.webm`：main 用用户 `main-animation/` 目录优先 + 包内素材；额外宠物只查自己的 `pet/<前缀>-animation/`，同种类多实例共享）；配置加载失败会**大声报错**（红色错误条 + 每 5 秒自动重试），绝不静默兜底

## ⚙️ 配置

| 配置项                 | 说明                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置页「桌宠配置」     | DSH 设置 → 桌宠配置：图形化编辑**大小 / 位置 / 边距**，支持**多开**（添加/删除宠物，每只独立配置）；保存**即时生效**，恢复默认回落 config.jsonc                                                                                                                                                                            |
| `pets`（config.jsonc） | 默认宠物列表：`[{ "id", "size", "balanceEnabled", "display", "position": { "corner", "marginX", "marginY" } }]`；`display` 为 web/desktop/both/none（必填，缺失即配置错误）；多只即多开，`display` 含 desktop 的宠物出现在桌面窗口（与浏览器同屏渲染），首只为「添加宠物」的默认模板                                       |
| `notificationsEnabled` | 系统通知总开关（布尔，默认开）：对话完成 / 生成失败 / 输出截断 / 权限申请 / 用户选择，在窗口失焦时弹系统级通知（桌面右下角）                                                                                                                                                                                               |
| `physics`（0.2.5）     | 拖拽抛掷物理参数（全局，所有宠物共用）：`gravity` 重力 / `restitution` 碰壁恢复系数（0~1）/ `groundFriction` 地面摩擦 / `ceilingBounce` 顶部反弹 / `throwPower` 总力度 / `petCollision` 多宠物碰撞开关；缺省取内置默认（1400 / 0.78 / 2.5 / true / 1.0 / false）；`gravity=0` 为无重力，`petCollision=true` 开启多宠物碰撞 |

> 说明：插件安装即用，配置均为可选；设置页保存的用户覆盖写入 `$DSH_HOME/dsh-pet/main-config.json`（用户层，优先于包内默认）。

### 📄 高级自定义（直接编辑配置文件）

用户数据统一收敛在 `$DSH_HOME/dsh-pet/`：

| 层               | 路径                                 | 作用                                                                                              |
| ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 默认配置（只读） | 包内 `assets/config.jsonc`           | 完整结构参考：宠物列表 / 动画池（idle/turn/drag/clicks/moves/categories）/ 播放权重               |
| 用户配置         | `$DSH_HOME/dsh-pet/main-config.json` | 覆盖片段：可整体覆盖 `pets` / `animations` / `animationWeights`，缺省字段回落默认                 |
| 用户动画（可选） | `$DSH_HOME/dsh-pet/main-animation/`  | 放入 `.webm`（VP9-Alpha）即可作为动画播放，**优先于包内素材**（放 `main-animation/webm/` 子目录） |

- 设置页底部会显示这些路径
- 自定义动画：把 `xxx.webm` 放进 `main-animation/webm/`，在动画池/分类里写 `"xxx"`，**刷新页面**即可（无需重启 DSH）
- 格式：`.webm` 需 **VP9 Alpha** 编码（Chrome/Edge/Firefox），与包内素材同规范，普通编码会有黑底
- 修改用户配置后同样**刷新页面**生效
- 动画名请对照默认配置填写，避免引用不存在的动画

### 🐾 额外宠物（pet pack）——添加新「种类」

默认只能调整主宠物（`config.jsonc` / `main-config.json` 的 `pets`）。要添加**全新种类的宠物**（独立动画池 + 自己的素材），在用户数据根下建 `pet/` 目录：

```
$DSH_HOME/dsh-pet/pet/
├─ pig-config.json        ← 额外宠物 pig 的配置（命名词干 = 种类名，实例 id 任意）
└─ pig-animation/         ← pig 自己的动画素材（直接平铺 .webm，仿 main-animation）
   ├─ 待机.webm
   └─ 打滚.webm
```

每只额外宠物 = 一个 `-config.json`（配置）+ 一个 `-animation/` 目录（素材），同前缀配对，扫描 `pet/` 自动发现（浏览器与桌面同时生效，无需重启）。

配置文件**与 `main-config.json` / `config.jsonc` 完全同构**——直接复制一份 main 配置、换成自己的动画池，就是一只新宠物。一个 `-config.json` 定义**一个「种类」**（动画池 + 素材目录），`pets` 数组可放该种类的**任意多只实例**（每只独立 size/位置，共享动画池与素材）：

```jsonc
// pet/pig-config.json —— 与 main-config.json 同构的完整配置；animations / animationWeights 必填（不回落全局）
{
  "notificationsEnabled": true,
  "pets": [
    {
      "id": "pig1", // 实例 id（可多只；不必等于文件名前缀）
      "size": 420,
      "balanceEnabled": true,
      "display": "both", // web / desktop / both / none
      "position": { "corner": "top-right", "marginX": 24, "marginY": 100 },
    },
    {
      "id": "pig2",
      "size": 360,
      "balanceEnabled": false,
      "display": "web",
      "position": { "corner": "top-left", "marginX": 24, "marginY": 100 },
    },
  ],
  "animations": {
    "idle": ["待机"],
    "turn": [],
    "drag": [],
    "clicks": ["打滚"],
    "moves": { "default": { "minDist": 80, "maxDist": 360, "margin": 20, "leadSec": 2, "tailSec": 2 }, "actions": [] },
    "categories": [],
    "events": {
      "balance": ["余额-钱袋满溢", "余额-金袋叮当", "余额-钱袋如常", "余额-数金皱眉", "余额-袋空如洗", "余额-分文不剩"],
    },
  },
  "animationWeights": { "idle": 80, "turn": 0, "move": 0 },
  "eventsRefreshSec": { "balance": 1800 },
}
```

规则（与主宠物严格隔离，绝不混用）：

- **素材只查自己的**：素材目录名 = 文件名前缀（`pet/pig-config.json` → `pet/pig-animation/`），该种类所有实例共用；动画 URL 为 `/thumb/<前缀>/<名>.webm`，查不到即 404 报错——**绝不落到 `main-animation` 或包内素材**
- **动画池不回落全局**：`animations` / `animationWeights` 是该种类的（结构校验与主配置同一套规则）
- `pets` 数组非空、每只字段（id/size/balanceEnabled/display/position）完整合法、数组内 id 唯一——**id 随意写、数量随意**，与主配置完全一致
- `notificationsEnabled` / `eventsRefreshSec` 是**全局属性**，不归宠物文件管：写了忽略、不写不报错
- 配置非法 / 缺少 `-animation/` 目录 / 实例 id 与主宠物冲突 → 加载时显式报错并跳过该宠物（不影响其他宠物）
- 设置页**不列出**文件宠物（改文件即生效，刷新可见）；设置页保存/恢复默认不会把它们写进 `main-config.json`
- 添加/修改/删除 → 刷新页面（浏览器）或重启 Helper（桌面）生效

## 🗑️ 卸载

```sh
dsh plugin --profile web remove dsh-pet
```

## 🖥️ 运行效果

宠物实际运行在 DSH Web 界面中的样子：

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet running in DSH Web UI 1" title="dsh-pet running in DSH Web UI 1">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet running in DSH Web UI 2" title="dsh-pet running in DSH Web UI 2">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-7.png" width="380" alt="dsh-pet running in DSH Web UI 7" title="dsh-pet running in DSH Web UI 7">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/assets/screenshots/dsh-pet-running-8.png" width="380" alt="dsh-pet running in DSH Web UI 8" title="dsh-pet running in DSH Web UI 8">
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

全部动画见仓库：`dsh-pet/assets/webm/`（VP9-alpha，唯一发布格式）。

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
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
