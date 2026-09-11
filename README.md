# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=%E6%9C%88%E4%B8%8B%E8%BD%BD&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=%E6%80%BB%E4%B8%8B%E8%BD%BD&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="repo size" src="https://img.shields.io/github/repo-size/PC2005-cloud/dsh-pet"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/issues"><img alt="issues" src="https://img.shields.io/github/issues/PC2005-cloud/dsh-pet"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-dynamic%20animations-ff69b4">
</p>

一只住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的桌面宠物：待机呼吸、随机动作（打瞌睡、玩魔方、吃火锅……）、左右转向、屏幕漫游、点击 Q 弹、拖拽甩抛反弹、右键菜单点播——一百余个手绘风透明动画随时无缝衔接；还能跟随 DSH 会话事件切换工作状态动画、按档位播放余额动画 + 头顶气泡、碎碎念与对话聊天、窗口失焦时弹系统通知。可多开同屏，能脱离浏览器住上**桌面**（透明置顶小窗），也能自己添加**全新宠物种类**（pet pack）。

这不是一个普通插件，而是**完整的三件套项目**：

```
① 提示词（配方）    →  ② 素材生成链（引擎）  →  ③ 插件（成品）
AI 生成动画的配方     源视频 → 透明动画的管线    运行在 DSH 里的宠物
```

任何人 clone 本仓库，都可以**从零生成自己的桌面宠物**——换角色、换动作、换风格，全流程可复现。

---

## 快速开始（安装插件）

> 以下命令都在你的**命令行终端**（PowerShell / CMD 等）中运行。前提是 DSH 环境已就绪：

```sh
# ① 前置要求：确认 Node.js 已安装
node -v

# ② 安装 DSH 启动器与 pnpm（已装可跳过；装完请重新打开终端）
npm install -g @deepseek-ai/dsh pnpm
dsh --version   # 验证 dsh 命令可用

# ③ 安装本插件
dsh plugin --profile web add dsh-pet
```

重启 `dsh web`，宠物出现在界面右上角（默认配置角落，可在设置页修改）。

> **兼容性**：本插件当前在 dsh **`0.1.5-rc.1`** 下开发并测试（`dsh --version` 可查看你的版本）。建议使用相同版本；其他版本如遇问题欢迎反馈。

### 从源码安装（clone 本仓库后）

`lib/` 构建产物不入库，clone 后需要先构建再安装：

```sh
# ① clone 本仓库，进入插件目录
git clone https://github.com/PC2005-cloud/dsh-pet.git
cd dsh-pet/dsh-pet

# ② 安装依赖
npm install

# ③ 构建（tsdown → lib）
npm run prepare     # 构建完整 lib（npm install / npm publish 时会自动执行）

# ④ 安装到 DSH（file: 指向本目录，用构建好的 lib）
dsh plugin --profile web add file:D:/path/to/dsh-pet
```

> 注：`prepare`（npm install / npm publish 时自动执行，也可手动 `npm run prepare`）才产出**完整可安装**的 lib——除 tsdown 构建外还构建桌面共享核心（`shared-core.js`）、生成类型声明并收敛发布 `files` 清单；裸 `tsdown` 构建会缺桌面运行时与类型。

## 插件功能

- **纯粹的桌宠**：不做天气、监控等无关功能，不碰 DSH 内核；可选能力只有下面这些（余额 / 碎碎念 / 对话 / 工作状态 / 系统通知）
- **动画链**：每个动画（含待机）播完即按权重选下一个（默认 idle 10 / turn 5 / move 5 + 分类权重，`config.jsonc` 可调），首尾相接
- **事件动画**：余额 / 碎碎念 / 工作状态按档位触发专属动画；档位支持候选数组——触发时档内随机、循环播放自动轮换，避免连播同一段
- **多开**：同时显示多个宠物，各自独立大小与位置（设置页「桌宠配置」添加/删除）
- **屏幕漫游**：朝朝向方向行走，先探测空间、不走出屏幕（多屏按各屏边界判定）
- **点击 / 拖拽 / 甩抛**：点击有回应动画并 Q 弹挤压；拖拽过阻尼弹簧跟手，甩出即抛物线飞行、屏幕边缘反弹、落地摩擦停稳并 Q 弹一下；温柔放下原地停住；两端同一套纯函数物理与挤压曲线（`dsh-pet/src/shared/physics.ts`）
- **右键菜单**：「动作 → 分类 → 具体动画」任意点播（移动类动画点播会真实行走一段）；工具项——浏览器端：碎碎念 / 对话 / 回到初始位置；桌面端：+ 打开网站、查看余额（余额启用时显示）
- **朝向与落地**：全部动画可镜像（可朝左 / 朝右）；脚底线统一，宠物始终站在地面上
- **流畅切换**：双缓冲交叉淡入，切换无空白帧
- **余额展示**：按已用百分比分档播余额动画 + 头顶联想气泡（10 秒自动消失）；DeepSeek 显示账户余额，OpenCode Zen Go 显示最紧迫的一个额度窗口；按宠物独立开关
- **碎碎念与对话**：碎碎念按周期自动生成一句（说话动画 + 气泡，也可手动触发）；对话在右键弹输入框与宠物聊天，记忆持久化（浏览器 / 桌面共享同一份）
- **工作状态联动**：监听 DSH 会话事件，切「思考 / 工作 / 整理 / 等待 / 成功 / 出错」档位动画 + 常驻气泡；目标多轮任务只在真正收尾轮庆祝
- **系统通知**：窗口失焦时弹系统 toast（对话完成 / 生成失败 / 输出截断 / 权限申请 / 用户选择）
- **桌面模式（可选）**：每只宠物开一个独立透明置顶局部小窗，与浏览器严格同行为、共用同一份素材与纯逻辑（见下节）
- **pet pack（额外宠物种类）**：`pet/` 下建 `种类名-config.json` + `种类名-animation/` 即新增独立动画池与素材的全新种类，多实例共享素材（见「配置 → 方式四」）
- **自定义动画**：往 `main-animation/webm/` 放 VP9-Alpha 的 `.webm` 即为新动画，优先于包内素材
- **无障碍**：支持 `prefers-reduced-motion`（减少动效时跳过 Q 弹挤压与淡入切换）

## 兼容性

- **操作系统**：Windows / Linux / macOS 三端均可运行——浏览器 overlay 与桌面模式（Electron 透明置顶窗）行为完全一致；Electron 按平台自动探测/下载（`electron.exe` / `Electron.app` / linux 单文件），无需手动安装
- **无头 / 无桌面环境**：支持 Linux headless 等无图形会话——桌面模式自动检测显示环境（Linux 无 `DISPLAY` / `WAYLAND_DISPLAY` 时判定无显示、跳过桌面窗口，仅日志告警），浏览器 overlay 不受影响
- **浏览器**：浏览器 overlay 兼容 **Chromium 内核（Chrome / Edge 等）与 Firefox**——透明动画依赖 VP9-Alpha webm，三者均已实测透明确认；**不支持 Safari**（macOS 不认 webm alpha，透明渲染为黑底）——macOS 用 `.mov` 素材（GitHub Release `assets-mov`），下载放入 + 改 `ANIMATION_EXT` 变量即可（见「②.5 Safari/HEVC 兼容素材」）
- **多显示器**：支持多屏环境——跨屏漫游/抛掷以各屏工作区为界，异构缩放（各屏 DPI 不同）、任务栏条带、屏幕之间空洞均正确判定（横屏 / 竖屏 / 上下叠放皆可）

## 🪟 桌面模式（可选，脱离浏览器）

插件内建**双模式**：安装后默认会拉起**独立透明置顶小窗**——为每只桌面宠物各开一个局部窗口（跟随宠物移动，**不铺满屏幕**），与浏览器 overlay 严格同行为、功能完全对齐：

- **依赖**：首次启动自动探测/下载 Electron（`~/.dsh/electron/`，也可 `cd dsh-pet && npm run ensure:electron` 手动触发）；缺失时仅日志告警，不影响浏览器形态
- **开关 = 每只宠物的必填字段 `display`**：`web` = 仅浏览器 / `desktop` = 仅桌面 / `both` = 两者 / `none` = 都不显示；桌面模式渲染 display 含 desktop 的**全部**宠物（多开同屏，与浏览器一致），设置页「桌宠配置」编辑即时生效
- 桌面端数据走独立进程管道，不依赖 DSH 的 HTTP 路由，不受 web 访问闸门影响
- 本地调试：`cd dsh-pet && npm run start:desktop -- http://127.0.0.1:3080/dsh-pet-7340/config`（无宿主时自动回落 HTTP 路径）

## ⚙️ 余额展示（Balance）

按 `eventsRefreshSec.balance`（秒）周期拉取当前服务商的余额/用量数据，每次刷新按档位触发一次余额动画，并在宠物头顶弹出**联想气泡**（随宠物大小等比缩放，10 秒自动消失）：

- **DeepSeek 官方（`deepseek-official`）**：气泡显示账户余额（如 `余额 ¥8.79`）；余额按 ¥20 满额折算成已用百分比，分 6 档播放动画（钱袋满溢 → 金袋叮当 → 钱袋如常 → 数金皱眉 → 袋空如洗 → 分文不剩）
- **OpenCode Zen Go（`opencode-go`）**：气泡显示 5h/周/月 三个额度窗口中最先告急的一个（如 `周额度已用 88%` / `2.5 天重置`），同样按已用百分比分档
- **按宠物开关**：`pets[i].balanceEnabled`（必填布尔）控制该宠物是否触发余额动画/显示气泡
- **所需凭据**：对应 provider 的 API key（`deepseek-official` → `DEEPSEEK_API_KEY`；`opencode-go` → `OPENCODE_GO_API_KEY`），在 DSH 凭据中配置后启用；未匹配的服务商不触发动画、不显示气泡

## ⚙️ 碎碎念与对话

- **碎碎念**：`pets[i].whisperEnabled` 开启后，按 `eventsRefreshSec.whisper`（秒，默认 300）周期自动生成一句——每只宠物独立周期、独立文案；触发时随机抽 `events.whisper` 动画 + 头顶说话气泡（10 秒消失）。默认关闭
- **手动触发**：右键菜单「碎碎念」随时来一句——不受 `whisperEnabled` 门控（该字段只关自动周期轮询）
- **对话**：右键菜单「对话」或 `/chat` 命令打开输入框，与宠物聊天——回复走碎碎念同款展示（说话动画 + 气泡）；记忆持久化在 `$DSH_HOME/dsh-pet/memory.json`，浏览器与桌面共享同一份；多宠物时先用 `/pet` 选择对话目标

## ⚙️ 工作状态联动（Work Status）

`pets[i].workStatusEnabled` 开启后，宠物跟随 DSH 会话活动切「思考 / 工作 / 整理 / 等待 / 成功 / 出错」六档动画 + 头顶气泡：非终态动画循环播、气泡常驻；成功 / 出错播一遍、气泡 10 秒自动收起。

- **档位动画**：`animations.events.workStatus` 数组，索引即档位（勿在中间插入新档，只可追加末尾）
- **气泡文案**：`workStatusTexts` 每档可配多句随机，任务详情（todo）优先
- **档位候选数组**：任意档位槽位可写 `string | string[]`——数组 = 档内随机抽 1，循环播放自动轮换、避免连播同一段（余额 / 碎碎念档位同样适用）

## ⚙️ 配置（大小 / 位置 / 多开）

桌宠的大小、位置、多开均可配置，两条途径：

> 💡 **两条途径只是编辑入口不同，最终都是同一份用户配置**——配置能力远不止设置页那几个选项：设置页可改大小/位置/边距/显示位置/余额开关/多开，但**手动编写配置文件可以任意自由配置**（动画池、播放权重、事件动画、刷新周期……），只要**格式与包内默认配置 `config.jsonc` 一致**即可，用户配置会**整体覆盖**对应字段的默认值。

### 方式一：设置页（推荐）

DSH 设置 → 「桌宠配置」：

- **大小**：宽度 px（高度自动 = 宽度 × 9/16）
- **位置**：四角（corner）＋ 水平/垂直边距（marginX / marginY）
- **显示位置**（display）：web=仅浏览器 / desktop=仅桌面 / both=两者都显示 / none=都不显示
- **余额功能**：勾选后该宠物才会触发余额动画并显示余额气泡
- **多开**：添加/删除宠物，每只宠物独立 id、大小、位置
- 点「保存」**即时生效**（无需刷新）；「恢复默认」回到 config.jsonc 默认

### 方式二：config.jsonc（单一来源）

插件包内 `dsh-pet/assets/config.jsonc` 的 `pets` 数组定义**默认宠物**：

```jsonc
"pets": [
  { "id": "main", "size": 462, "balanceEnabled": true, "display": "both", "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } }
]
```

- 每只宠物：`id`（标识）／ `size`（宽度 px）／ `balanceEnabled`（是否启用余额功能，必填布尔）／ `display`（web/desktop/both/none，必填，见上）／ `position`（corner 四角之一 + marginX/marginY 边距）
- 余额刷新周期：`eventsRefreshSec.balance`（秒）——余额数据刷新与余额动画触发的间隔，启动时立即触发一次，之后按此周期循环（默认 1800）
- 设置页的修改保存到用户层 `$DSH_HOME/dsh-pet/main-config.json`（**完整宠物列表**，覆盖包内默认）；「恢复默认」即清除用户层、回落 config.jsonc

### 方式三：手动编辑配置文件（高级，任意自由配置）

用户层配置文件位于 `$DSH_HOME/dsh-pet/main-config.json`。**它和包内默认配置是同一套格式**——想改什么直接照着 `assets/config.jsonc` 的结构写即可，写错的字段/缺失的字段回落默认，无需（也无法）写完整份：

| 字段                   | 作用                                                                                    | 格式与默认一致即可         |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| `pets`                 | 宠物列表（大小/位置/多开/余额开关）                                                     | 数组，每项同 `pets[]` 结构 |
| `animations`           | **动画池**：idle / turn / drag / clicks / moves / categories / events（余额等事件动画） | 同 `animations` 结构       |
| `animationWeights`     | 动画链播放权重（idle / turn / move）                                                    | 同 `animationWeights` 结构 |
| `eventsRefreshSec`     | 事件刷新周期（秒）                                                                      | 同 `eventsRefreshSec` 结构 |
| `notificationsEnabled` | 系统通知总开关（布尔）                                                                  | 同 `notificationsEnabled`  |

> 覆盖语义：用户层给出即**整体替换**该字段（如写了 `animations` 就用你的整份动画池，替代默认），没写的字段回落包内默认。校验在插件加载时执行——格式错误会在 DSH 控制台显式报错，不会静默运行残缺配置。

### 方式四：额外宠物（pet pack）——添加新「种类」

方式一~三都只调整**默认宠物的实例**（数量/大小/位置），动画池始终是全局一份。要添加**全新种类的宠物**（独立动画池 + 自己的素材），在用户数据根下建 `pet/` 目录：

```
$DSH_HOME/dsh-pet/
├─ main-config.json            ← 主宠物配置（现有，不动）
├─ main-animation/webm/*.webm  ← 主宠物素材（现有，只属于 main）
└─ pet/
   ├─ pig-config.json          ← 额外宠物 pig 的配置（命名词干 = 种类名，实例 id 任意）
   └─ pig-animation/*.webm     ← pig 自己的动画素材（直接平铺，仿 main-animation）
```

每只额外宠物 = 一个 `-config.json` + 一个 `-animation/` 目录，同前缀配对；扫描 `pet/` 自动发现，浏览器与桌面同时生效。一个 `-config.json` 定义**一个「种类」**（动画池 + 素材目录），`pets` 数组可放该种类的**任意多只实例**（共享动画池与素材）：

```jsonc
// pet/pig-config.json —— 与 main-config.json 同构的完整配置
{
  "notificationsEnabled": true,
  "pets": [
    {
      "id": "pig1",              // 实例 id（可多只；不必等于文件名前缀）
      "size": 420,
      "balanceEnabled": true,
      "display": "both",        // web / desktop / both / none
      "position": { "corner": "top-right", "marginX": 24, "marginY": 100 }
    },
    { "id": "pig2", "size": 360, "balanceEnabled": false, "display": "web", "position": { "corner": "top-left", "marginX": 24, "marginY": 100 } }
  ],
  "animations": {
    "idle": ["待机"], "turn": [], "drag": [], "clicks": ["打滚"],
    "moves": { "default": { "minDist": 80, "maxDist": 360, "margin": 20, "leadSec": 2, "tailSec": 2 }, "actions": [] },
    "categories": [],
    "events": { "balance": ["余额-钱袋满溢", "余额-金袋叮当", "余额-钱袋如常", "余额-数金皱眉", "余额-袋空如洗", "余额-分文不剩"] }
  },
  "animationWeights": { "idle": 80, "turn": 0, "move": 0 },
  "eventsRefreshSec": { "balance": 1800 }
}
```

规则（与主宠物**严格隔离**，绝不混用）：
- **素材只查自己的**：素材目录名 = 文件名前缀（`pet/pig-config.json` → `pet/pig-animation/`），该种类所有实例共用；动画 URL `/thumb/<前缀>/<名>.webm`，查不到即 404——绝不落到 `main-animation` 或包内素材
- **动画池不回落全局**：`animations` / `animationWeights` 必须写全（缺失即配置错误）
- 与主配置同构的约束：`pets` 每只字段完整合法、数组内 id 唯一、`animations` / `animationWeights` 结构校验同一套规则；`notificationsEnabled` / `eventsRefreshSec` 是全局属性，不归宠物文件管（写了忽略、不写不报错）
- 配置非法 / 缺少 `-animation/` 目录 / 实例 id 与主宠物冲突 → 加载时显式报错并跳过（不影响其他宠物）
- 设置页不列出文件宠物（改文件即生效，刷新可见；保存/恢复默认不会把它们写进 `main-config.json`）
- 余额档位动画按各宠物自己的 `events.balance`

## 运行效果

宠物实际运行在 DSH Web 界面中的样子：

<p>
  <img src="assets/screenshots/dsh-pet-running-1.png" width="380" alt="dsh-pet 运行效果 1" title="dsh-pet 运行效果 1">
  <img src="assets/screenshots/dsh-pet-running-2.png" width="380" alt="dsh-pet 运行效果 2" title="dsh-pet 运行效果 2">
  <img src="assets/screenshots/dsh-pet-running-3.png" width="380" alt="dsh-pet 运行效果 3" title="dsh-pet 运行效果 3">
  <img src="assets/screenshots/dsh-pet-running-4.png" width="380" alt="dsh-pet 运行效果 4" title="dsh-pet 运行效果 4">
  <img src="assets/screenshots/dsh-pet-running-5.png" width="380" alt="dsh-pet 运行效果 5" title="dsh-pet 运行效果 5">
  <img src="assets/screenshots/dsh-pet-running-6.png" width="380" alt="dsh-pet 运行效果 6" title="dsh-pet 运行效果 6">
  <img src="assets/screenshots/dsh-pet-running-7.png" width="380" alt="dsh-pet 运行效果 7" title="dsh-pet 运行效果 7">
  <img src="assets/screenshots/dsh-pet-running-8.png" width="380" alt="dsh-pet 运行效果 8" title="dsh-pet 运行效果 8">
</p>

## 效果预览

全部动画（640×360，插件实际播放用的资源）——GIF 预览存放于仓库 `dsh-pet/assets/preview/`（raw 直链渲染，文件名采用拼音便于跨平台）；完整透明视频见插件包 `dsh-pet/assets/webm/`（VP9-alpha，唯一发布格式）：

**待机 / 转向**

<p>
  <img src="dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="待机呼吸休闲" title="待机呼吸休闲">
  <img src="dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="东张西望" title="东张西望">
</p>

**移动**

<p>
  <img src="dsh-pet/assets/preview/pangxie-zoulu.gif" width="160" alt="螃蟹走路" title="螃蟹走路">
  <img src="dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="原地漂浮踏步" title="原地漂浮踏步">
  <img src="dsh-pet/assets/preview/yuandi-zuozhuan-benpao.gif" width="160" alt="原地左转奔跑" title="原地左转奔跑">
</p>

**小动作**

<p>
  <img src="dsh-pet/assets/preview/youxian-hengga.gif" width="160" alt="悠闲哼歌" title="悠闲哼歌">
  <img src="dsh-pet/assets/preview/chaoda-shenlanyao.gif" width="160" alt="超大伸懒腰" title="超大伸懒腰">
  <img src="dsh-pet/assets/preview/yuandi-qiaoji-zhuomian-hudong.gif" width="160" alt="原地敲击桌面互动" title="原地敲击桌面互动">
  <img src="dsh-pet/assets/preview/yuandi-zhongli-xiadun-yasuo.gif" width="160" alt="原地重力下蹲压缩" title="原地重力下蹲压缩">
  <img src="dsh-pet/assets/preview/haqian-liantian.gif" width="160" alt="哈欠连天" title="哈欠连天">
  <img src="dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="原地小憩沉眠" title="原地小憩沉眠">
  <img src="dsh-pet/assets/preview/nvpu-quxi-liyi.gif" width="160" alt="女仆屈膝礼仪" title="女仆屈膝礼仪">
  <img src="dsh-pet/assets/preview/beixiayitiao-zhamao.gif" width="160" alt="被吓一跳" title="被吓一跳">
  <img src="dsh-pet/assets/preview/xiaofudu-yuandi-360du-xuanzhuan-zhanshi.gif" width="160" alt="小幅度原地360度旋转展示" title="小幅度原地360度旋转展示">
  <img src="dsh-pet/assets/preview/touchi-lingshi-bei-zhuazhu.gif" width="160" alt="偷吃零食被抓住" title="偷吃零食被抓住">
  <img src="dsh-pet/assets/preview/yong-jingyu-weiba-paidadi.gif" width="160" alt="用鲸鱼尾巴拍打地面" title="用鲸鱼尾巴拍打地面">
  <img src="dsh-pet/assets/preview/da-keshui-bei-jingxing.gif" width="160" alt="打瞌睡被惊醒" title="打瞌睡被惊醒">
  <img src="dsh-pet/assets/preview/zhao-jingzi.gif" width="160" alt="照镜子" title="照镜子">
  <img src="dsh-pet/assets/preview/zhengti-huanzhuang-shise.gif" width="160" alt="整体换装试色" title="整体换装试色">
  <img src="dsh-pet/assets/preview/qingkuai-jilu.gif" width="160" alt="轻快记录" title="轻快记录">
  <img src="dsh-pet/assets/preview/xie-daima.gif" width="160" alt="写代码" title="写代码">
  <img src="dsh-pet/assets/preview/yaoshan-naliang.gif" width="160" alt="摇扇纳凉" title="摇扇纳凉">
  <img src="dsh-pet/assets/preview/chenjian-shuaya.gif" width="160" alt="晨间刷牙" title="晨间刷牙">
</p>

**玩耍**

<p>
  <img src="dsh-pet/assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="160" alt="原地专心玩魔方" title="原地专心玩魔方">
  <img src="dsh-pet/assets/preview/yuandi-dunxia-wan-wanju-qiche.gif" width="160" alt="原地蹲下玩玩具汽车" title="原地蹲下玩玩具汽车">
  <img src="dsh-pet/assets/preview/jingyu-tu-paopao-texiao.gif" width="160" alt="鲸鱼吐泡泡特效" title="鲸鱼吐泡泡特效">
  <img src="dsh-pet/assets/preview/yuandi-tiaoyue-zhuasui-touding-wupin.gif" width="160" alt="原地跳跃抓碎头顶物品" title="原地跳跃抓碎头顶物品">
  <img src="dsh-pet/assets/preview/wan-youxi-qijibaituai.gif" width="160" alt="玩游戏气急败坏" title="玩游戏气急败坏">
  <img src="dsh-pet/assets/preview/wan-shuiqiang.gif" width="160" alt="玩水枪" title="玩水枪">
  <img src="dsh-pet/assets/preview/xiaotiqin-yanzou.gif" width="160" alt="小提琴演奏" title="小提琴演奏">
  <img src="dsh-pet/assets/preview/lanjing-xianshi.gif" width="160" alt="蓝鲸现世" title="蓝鲸现世">
  <img src="dsh-pet/assets/preview/youya-nvpuwu.gif" width="160" alt="优雅女仆舞" title="优雅女仆舞">
  <img src="dsh-pet/assets/preview/qingkuai-yaobaiwu.gif" width="160" alt="轻快摇摆舞" title="轻快摇摆舞">
  <img src="dsh-pet/assets/preview/keai-zhaiwu.gif" width="160" alt="可爱宅舞" title="可爱宅舞">
  <img src="dsh-pet/assets/preview/chui-qiqiu.gif" width="160" alt="吹气球" title="吹气球">
  <img src="dsh-pet/assets/preview/dongwu-huanrao.gif" width="160" alt="动物环绕" title="动物环绕">
  <img src="dsh-pet/assets/preview/fang-fengzheng.gif" width="160" alt="放风筝" title="放风筝">
  <img src="dsh-pet/assets/preview/chai-liwu.gif" width="160" alt="拆礼物" title="拆礼物">
  <img src="dsh-pet/assets/preview/bian-gezi.gif" width="160" alt="变鸽子" title="变鸽子">
  <img src="dsh-pet/assets/preview/puke-moshu.gif" width="160" alt="扑克魔术" title="扑克魔术">
  <img src="dsh-pet/assets/preview/chou-tuoluo.gif" width="160" alt="抽陀螺" title="抽陀螺">
  <img src="dsh-pet/assets/preview/chui-dizi.gif" width="160" alt="吹笛子" title="吹笛子">
  <img src="dsh-pet/assets/preview/hudie-mifeng-huanrao-touding-kaihua.gif" width="160" alt="蝴蝶蜜蜂环绕头顶开花" title="蝴蝶蜜蜂环绕头顶开花">
  <img src="dsh-pet/assets/preview/lu-mao.gif" width="160" alt="撸猫" title="撸猫">
  <img src="dsh-pet/assets/preview/pingkong-shenghua.gif" width="160" alt="凭空生花" title="凭空生花">
  <img src="dsh-pet/assets/preview/qi-muma.gif" width="160" alt="骑木马" title="骑木马">
  <img src="dsh-pet/assets/preview/sanqiu-paojie.gif" width="160" alt="三球抛接" title="三球抛接">
  <img src="dsh-pet/assets/preview/ti-jianzi.gif" width="160" alt="踢毽子" title="踢毽子">
  <img src="dsh-pet/assets/preview/xiawuziqi.gif" width="160" alt="下五子棋" title="下五子棋">
  <img src="dsh-pet/assets/preview/dangqiuqian.gif" width="160" alt="荡秋千" title="荡秋千">
</p>

**吃什么**

<p>
  <img src="dsh-pet/assets/preview/chi-baifan.gif" width="160" alt="吃白饭" title="吃白饭">
  <img src="dsh-pet/assets/preview/dakou-chi-lingshi.gif" width="160" alt="大口吃零食" title="大口吃零食">
  <img src="dsh-pet/assets/preview/chi-token.gif" width="160" alt="吃Token" title="吃Token">
  <img src="dsh-pet/assets/preview/chi-zaocan.gif" width="160" alt="吃早餐" title="吃早餐">
  <img src="dsh-pet/assets/preview/chi-wucan.gif" width="160" alt="吃午餐" title="吃午餐">
  <img src="dsh-pet/assets/preview/chi-wancan.gif" width="160" alt="吃晚餐" title="吃晚餐">
  <img src="dsh-pet/assets/preview/chi-bingqilin-ronghua.gif" width="160" alt="吃冰淇淋融化" title="吃冰淇淋融化">
  <img src="dsh-pet/assets/preview/chi-dazhaxie.gif" width="160" alt="吃大闸蟹" title="吃大闸蟹">
  <img src="dsh-pet/assets/preview/chi-tanghulu.gif" width="160" alt="吃糖葫芦" title="吃糖葫芦">
  <img src="dsh-pet/assets/preview/chi-changshoumian.gif" width="160" alt="吃长寿面" title="吃长寿面">
  <img src="dsh-pet/assets/preview/chi-xigua.gif" width="160" alt="吃西瓜" title="吃西瓜">
  <img src="dsh-pet/assets/preview/shuan-huoguo.gif" width="160" alt="涮火锅" title="涮火锅">
</p>

**时节**

<p>
  <img src="dsh-pet/assets/preview/beiluoye-yanmo.gif" width="160" alt="被落叶淹没" title="被落叶淹没">
  <img src="dsh-pet/assets/preview/zhongqiu-shangyue-chi-yuebing.gif" width="160" alt="中秋赏月吃月饼" title="中秋赏月吃月饼">
  <img src="dsh-pet/assets/preview/duixueren.gif" width="160" alt="堆雪人" title="堆雪人">
  <img src="dsh-pet/assets/preview/fang-yanhua.gif" width="160" alt="放烟花" title="放烟花">
  <img src="dsh-pet/assets/preview/chi-zongzi.gif" width="160" alt="吃粽子" title="吃粽子">
  <img src="dsh-pet/assets/preview/chi-niangao.gif" width="160" alt="吃年糕" title="吃年糕">
  <img src="dsh-pet/assets/preview/chi-qingtuan.gif" width="160" alt="吃青团" title="吃青团">
  <img src="dsh-pet/assets/preview/chi-labazhou.gif" width="160" alt="吃腊八粥" title="吃腊八粥">
  <img src="dsh-pet/assets/preview/chi-chongyanggao.gif" width="160" alt="吃重阳糕" title="吃重阳糕">
  <img src="dsh-pet/assets/preview/shou-hongbao.gif" width="160" alt="收红包" title="收红包">
  <img src="dsh-pet/assets/preview/xie-fuzi.gif" width="160" alt="写福字" title="写福字">
  <img src="dsh-pet/assets/preview/chuanzhenqiqiao.gif" width="160" alt="穿针乞巧" title="穿针乞巧">
  <img src="dsh-pet/assets/preview/wu-shitou.gif" width="160" alt="舞狮头" title="舞狮头">
  <img src="dsh-pet/assets/preview/taotang-nanguadeng.gif" width="160" alt="讨糖南瓜灯" title="讨糖南瓜灯">
  <img src="dsh-pet/assets/preview/cha-zhuyu-shangju.gif" width="160" alt="插茱萸赏菊" title="插茱萸赏菊">
  <img src="dsh-pet/assets/preview/fanghedeng.gif" width="160" alt="放河灯" title="放河灯">
  <img src="dsh-pet/assets/preview/menghua-xiaoyouling.gif" width="160" alt="萌化小幽灵" title="萌化小幽灵">
  <img src="dsh-pet/assets/preview/zhuangdian-shengdanshu.gif" width="160" alt="装点圣诞树" title="装点圣诞树">
  <img src="dsh-pet/assets/preview/fang-kongmingdeng.gif" width="160" alt="放孔明灯" title="放孔明灯">
  <img src="dsh-pet/assets/preview/chitangyuan.gif" width="160" alt="吃汤圆" title="吃汤圆">
  <img src="dsh-pet/assets/preview/chijiaozi.gif" width="160" alt="吃饺子" title="吃饺子">
</p>

**文字**

<p>
  <img src="dsh-pet/assets/preview/shia-chishenme.gif" width="160" alt="是啊，吃什么" title="是啊，吃什么">
  <img src="dsh-pet/assets/preview/shendu-sikao-suisuinian.gif" width="160" alt="深度思考碎碎念" title="深度思考碎碎念">
</p>

**点击回应**

<p>
  <img src="dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="点击回应-开心跃动" title="点击回应-开心跃动">
  <img src="dsh-pet/assets/preview/dianji-huiying-haixiu-jingya.gif" width="160" alt="点击回应-害羞惊讶" title="点击回应-害羞惊讶">
  <img src="dsh-pet/assets/preview/dianji-huiying-aojiao-shengqi-ceshen-zhanshi.gif" width="160" alt="点击回应-傲娇生气" title="点击回应-傲娇生气">
  <img src="dsh-pet/assets/preview/dianji-huiying-naoyang-gegexiao.gif" width="160" alt="点击回应-挠痒咯咯笑" title="点击回应-挠痒咯咯笑">
  <img src="dsh-pet/assets/preview/dianji-huiying-yuanqi-huishou.gif" width="160" alt="点击回应-元气挥手" title="点击回应-元气挥手">
</p>

**拖拽**

<p>
  <img src="dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="被鼠标拖拽悬空反馈" title="被鼠标拖拽悬空反馈">
</p>

**余额事件**（按余额已用百分比分档，满格 → 告急 → 耗尽）

<p>
  <img src="dsh-pet/assets/preview/qian-dai-man-yi.gif" width="160" alt="余额-钱袋满溢" title="余额-钱袋满溢">
  <img src="dsh-pet/assets/preview/jin-dai-ding-dang.gif" width="160" alt="余额-金袋叮当" title="余额-金袋叮当">
  <img src="dsh-pet/assets/preview/qian-dai-ru-chang.gif" width="160" alt="余额-钱袋如常" title="余额-钱袋如常">
  <img src="dsh-pet/assets/preview/shu-jin-zhou-mei.gif" width="160" alt="余额-数金皱眉" title="余额-数金皱眉">
  <img src="dsh-pet/assets/preview/dai-kong-ru-xi.gif" width="160" alt="余额-袋空如洗" title="余额-袋空如洗">
  <img src="dsh-pet/assets/preview/fen-wen-bu-sheng.gif" width="160" alt="余额-分文不剩" title="余额-分文不剩">
</p>

**碎碎念说话动画**（碎碎念 / 对话回复触发，随机抽 1 段）

<p>
  <img src="dsh-pet/assets/preview/suisuinian-cazhuo-suisuinian.gif" width="160" alt="碎碎念-擦桌碎碎念" title="碎碎念-擦桌碎碎念">
  <img src="dsh-pet/assets/preview/suisuinian-fadai-suisuinian.gif" width="160" alt="碎碎念-发呆碎碎念" title="碎碎念-发呆碎碎念">
  <img src="dsh-pet/assets/preview/suisuinian-duiping-suisuinian.gif" width="160" alt="碎碎念-对屏碎碎念" title="碎碎念-对屏碎碎念">
</p>

**工作状态动画**（跟随 DSH 会话事件，六档：思考 / 工作 / 整理 / 等待 / 成功 / 出错）

<p>
  <img src="dsh-pet/assets/preview/gongzuozhuangtai-sikao-maopao.gif" width="160" alt="工作状态-思考冒泡" title="工作状态-思考冒泡">
  <img src="dsh-pet/assets/preview/gongzuozhuangtai-manglu-dianan.gif" width="160" alt="工作状态-忙碌点按" title="工作状态-忙碌点按">
  <img src="dsh-pet/assets/preview/gongzuozhuangtai-qingdian-guidang.gif" width="160" alt="工作状态-清点归档" title="工作状态-清点归档">
  <img src="dsh-pet/assets/preview/gongzuozhuangtai-yuandi-duobu-zhangwang.gif" width="160" alt="工作状态-原地踱步张望" title="工作状态-原地踱步张望">
  <img src="dsh-pet/assets/preview/gongzuozhuangtai-queyue-qingzhu.gif" width="160" alt="工作状态-雀跃庆祝" title="工作状态-雀跃庆祝">
  <img src="dsh-pet/assets/preview/gongzuozhuangtai-chuitou-tanqi-maohan.gif" width="160" alt="工作状态-垂头叹气冒汗" title="工作状态-垂头叹气冒汗">
</p>

> 注：动画为透明背景；GIF 预览中透明部分显示为页面底色，实际 webm 播放为透明。

## 从零生成你自己的宠物（完整流程）

### ① 提示词 → 源视频

用 AI 视频生成工具（如可灵、Runway、豆包等，本项目素材即由豆包生成），按 `prompts/桌面宠物 10 秒动作提示词.md` 的配方，一个动作生成一段 10 秒绿幕视频：

- 视频比例 16:9，背景纯绿幕（#00FF00）
- 人物位置/大小固定（头顶 ~20% 高度、脚底 ~85% 高度）
- 动作全程在画幅内，首尾帧为标准正面站立
- 每段动画按秒分解（0-10s 各阶段动作）

生成结果按动作各存一个 mp4，放入 `video/`。

> **源视频获取**：为控制仓库体积，`video/` 源视频不入 git。Releases 提供**打包压缩包**，浏览器直接下载即可：
>
> - `assets-videos.zip` —— 全部源视频压缩包（中文名 mp4，解压后放入 `video/`）
>
> 解压：`Expand-Archive assets-videos.zip`（Windows）或 `unzip assets-videos.zip`，把 mp4 放回 `video/` 即可运行素材链。

### ② 源视频 → 透明动画（素材链）

step02（透明视频）有**两条路线，按需二选一**（默认自动、人人可复现；效果不佳可用 PR 手工抠像覆盖）：

```sh
cd scripts
# 路线 A（默认）：自动绿幕抠像（HSV 色相，无需人工）
python watermark_step01.py   # 水印遮罩填充 → step01/
python chroma_step02.py      # 绿幕抠像转透明 → step02/

# 路线 B（可选）：PR 手工抠像覆盖（针对含第三方物品/自动抠像效果不佳的动作）
#   1. 在 PR 里手工抠像，导出带 alpha 的透明 .mov（如 ProRes 4444 with Alpha）
#   2. 放入 pr/，文件名与动作名一致（如 吃白饭.mov）
python pr_import_step02.py   # pr/*.mov → step02/（透明 webm，覆盖该动作自动抠像结果）

# 后续步骤两条路线共用：
python normalize_step03.py   # 归一化 2160×1215 统一站立居中 → step03/
python encode_thumbs.py      # 转码 640×360 播放变体 → step04/
```

**依赖**：Python 3 + ffmpeg + numpy + scipy（素材链脚本自动用工作区 `.tools/` 下的 ffmpeg）。

> **本项目全部采用路线 B**（全部动作均为 PR 手工抠像）：对"含第三方物品/透明边缘复杂"的动作，自动 HSV 抠像易残边或误抠，PR 手动遮罩更精细。两条路线产出同一级 `step02/`，后续步骤完全一致；`chroma_step02.py` 保留为自动化兜底，任何动作仍可一键自动生成。

### ②.5 🍎 Safari/HEVC 兼容素材（macOS 专用 mov）

插件默认只发布 `.webm`（VP9-alpha），Safari/WKWebView 不认 webm alpha（黑底），macOS 需要在 GitHub Release 下载官方转码的 **HEVC-with-Alpha `.mov`** 素材使用，三步：

1. **下载**：<https://github.com/PC2005-cloud/dsh-pet/releases/tag/assets-mov>（固定 tag，保持最新；zip 解压后文件名与 webm 一一对应）
2. **放入**：`.mov` 文件放进 `$DSH_HOME/dsh-pet/main-animation/mov/`（pet pack 宠物则是 `pet/<种类名>-animation/mov/`）
3. **改变量**：搜 `ANIMATION_EXT`，把 `.webm` 改为 `.mov`——npm 包改产物 `lib/client.js`（桌面端如需再改 `runtime/electron-helper/shared-core.js`）；自构建改源码 `src/shared/constants.ts` 后重新构建

宿主路由已固定双扩展名兜底（白名单 `webm|mov`、MIME、素材根按扩展名分派），无需改宿主。详情见插件 README「macOS 使用 mov」。

### ③ 动画 → 插件

```sh
# 把 step04 的播放变体同步进插件包（webm 直接 cp）
cp step04/*.webm dsh-pet/assets/webm/   # 播放格式（VP9-alpha）

# 本地安装插件
dsh plugin --profile web add file:D:/path/to/dsh-pet
```

> 中间产物（step01-04）由脚本生成、不入仓库；`video/` 源视频和脚本是成果、入库维护。

### 🎯 发布（单一 webm 格式）

插件只发布一个 npm 包、一个素材格式（webm）；`files` 收敛为固定清单（lib / src / assets/webm / runtime/electron-helper / assets/fonts / assets/pic / assets/config.jsonc / scripts/ensure-electron.mjs / cordis.patch.yml，见 `prepare.js`；浏览器与桌面模式共用，包体最小）：

```sh
cd dsh-pet
npm publish --tag latest   # npm publish 自动执行 prepare 钩子（构建完整产物 + 收敛 files），无需手动构建
```

- client 端不做运行时浏览器判断——唯一播放格式 webm 在源码写死，无发布期注入
- 需要 Safari/HEVC 版（macOS）：mov 素材官方发布在 GitHub Release `assets-mov`，下载解压进 `main-animation/mov/`，再把集中播放扩展名常量 `ANIMATION_EXT` 改为 `.mov`（见上方 ②.5）

### 项目结构

三件套按 ①②③ 分块（gitignore 的本地目录不列）：

```
├── prompts/           # ① 动画生成提示词配方（绿幕规范 + 按秒分解）
├── video/             # ② 素材源视频（绿幕 mp4；不入库，Releases 提供压缩包）
├── scripts/           # ② 素材生成链（Python/ffmpeg：水印 → 抠像 → 归一化 → 转码 → GIF 预览）
├── step01~04/         # ② 素材链中间产物（不入库）
├── pr/  prproj/       # ② 路线 B：PR 手工抠像输入与工程（本地工作数据，不入库）
├── tools/             # 开发小工具（素材链各阶段预览等）
├── assets/            # 仓库展示用截图
├── .github/workflows/ # CI：Safari/HEVC 转码流水线（macOS runner，手动触发 → 发布 assets-mov Release）
├── dsh-pet/           # ③ 插件（可独立 npm 发布）
│   ├── src/           #   TS 源码：host（配置/路由/工作状态）、client（动画链）、shared（双端共用纯逻辑）
│   ├── lib/           #   构建产物（prepare 自动构建，不入库）
│   ├── runtime/       #   桌面模式运行壳（Electron 透明窗）
│   ├── assets/        #   webm 动画 / preview GIF / 字体 / 图标 / config.jsonc 默认配置
│   └── scripts/       #   构建与发布脚本（prepare / prepack-check / ensure-electron 等）
└── LICENSE            # MIT
```

## 许可

- 代码：MIT
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
- **二次创作（二创）约定**：基于本项目的衍生 / 改版 / 换皮作品，在**任何介绍、展示、分发该作品的地方**，须附上原作者 GitHub 地址：<https://github.com/PC2005-cloud/dsh-pet>
