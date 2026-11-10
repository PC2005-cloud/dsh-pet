# dsh-pet 项目说明

> 本文由当前工作区源码与既有文档整理而成，用于快速理解仓库全貌。
> 面向使用者的安装/配置说明以 `README.md`、`INSTALL.md`、`CONFIG.md`、`FEATURES.md` 为准；
> 接口契约以 `API.md`、`openapi.yaml`、`CORDIS.md` 为准。本文只做结构与实现层面的总览。

## 1. 项目是什么

dsh-pet 是一个运行在 DeepSeek Harness（DSH）里的桌面宠物插件，同时也是一个可独立分发的三件套项目：

```text
① 提示词（配方）        ② 素材生成链（引擎）           ③ 插件（成品）
prompts/*.md      →     video/ → scripts/*.py     →    dsh-pet/（npm 包）
AI 生成绿幕视频          抠像 / 转码为透明 webm          宿主半侧 + 浏览器半侧 + 桌面壳
```

核心能力：

- 100+ 段透明动画（当前仓库 `dsh-pet/assets/webm` 共 114 个 `.webm`，约 55 MB），待机、漫游、玩耍、工作、对话、睡觉、余额分档等按权重首尾衔接
- 多开同屏，每只宠物独立 id、大小、位置、显示位置（web / desktop / both / none）
- 三种运行形态：DSH 浏览器 overlay、DSH 桌面应用中的 Electron 透明置顶窗、完全脱离 DSH 的独立模式
- 交互与物理：点击回应、拖拽甩抛、双击弹弓、宠物互撞、Q 弹挤压；移动端支持触屏、倾斜重力、摇一摇
- AI 能力：碎碎念、对话、长期记忆、配图、动作联动、语音合成与识别
- 与 DSH 联动：工作状态六档动画、余额分档动画与气泡、待办提醒、系统通知、斜杠命令 `/pet` `/chat` `/balance`
- 对外开放：HTTP 接口（`/dsh-pet-7340` 前缀）与页面内 Cordis 服务 `petApi7340`

## 2. 仓库结构

仓库根是“项目 + 文档 + 素材链”，插件本体在 `dsh-pet/` 子目录（该目录才是一个可独立发布的 npm 包）。

```text
.
├── README.md / INSTALL.md / FEATURES.md / CONFIG.md
├── API.md / CORDIS.md / CORDIS-API.md / openapi.yaml
├── MAKE-YOUR-OWN-PET.md          # 从零做一只宠物的完整流程
├── prompts/                      # ① 动画生成提示词配方（绿幕规范、按秒分解、睡觉三段接力）
├── scripts/                      # ② 素材链：水印遮罩 → 绿幕抠像 → 归一化 → 转码 / 预览图
├── video/                        # 源视频（mp4 不入 git，Release 提供压缩包）
├── tools/                        # API 调试台、cordis-probe（mock 服务商）、DPI 探针
├── assets/screenshots/           # README 展示截图
├── .github/workflows/            # hevc-alpha（Safari 兼容素材）、release-app（Windows 绿色包）
└── dsh-pet/                      # ③ 插件包
    ├── src/
    │   ├── host/                 # 宿主半侧（Node / Cordis 插件）
    │   ├── client/               # 浏览器半侧（DSH 页面 overlay + 设置页）
    │   ├── shared/               # 双端共用纯逻辑（无 DOM / 无 React）
    │   ├── standalone/           # 独立模式 CLI 与设置页
    │   └── app/                  # 独立应用（单进程 Electron：服务 + 宿主 + 窗口）
    ├── runtime/electron-helper/  # 桌面模式运行壳（Electron 主进程 + 渲染端）
    ├── assets/                   # webm / preview GIF / 字体 / 表情包 / 图标 / 默认配置
    ├── scripts/                  # 构建、发布、开发脚本
    ├── cordis.patch.yml          # bundle patch（把插件挂进 DSH 配置树，id = dsh-pet）
    ├── electron-builder.yml      # Windows 绿色包配置（asar、dist-app）
    ├── tsdown.config.mjs         # 五个构建入口
    └── lib/                      # 构建产物（不入库）
```

## 3. 插件如何挂进 DSH

`dsh-pet/package.json` 与 `cordis.patch.yml` 共同定义挂载方式：

| 声明 | 作用 |
|---|---|
| `main: lib/index.js` | 宿主半侧入口，Cordis 插件（`name` / `inject` / `apply`） |
| `exports["./client"]` | 浏览器半侧入口，DSH 模块系统提供 `/plugins/dsh-pet/client.js` |
| `dsh.bundle.patch` | 声明本包为 bundle，安装后 `cordis.patch.yml` 自动进入层栈 |
| `dsh.client` | 声明浏览器半侧注入依赖 `@deepseek-ai/dsh-client-connection`、平台 `web` |
| `bin.dsh-pet-standalone` | 独立模式 CLI（`lib/standalone.js`） |
| `files` | 发布白名单：`lib` / `src` / webm / 字体 / 图片 / 表情包 / 音效 / 默认配置 |

`cordis.patch.yml` 只有一条 `insert`，`id` 与包名一致（DSH STORE 上架契约按 entry id 比对，裸名会冲突）。

宿主侧 `inject`：`webServer`、`agentDefaultModel`、`credentials`、`llm`、`commands`、`connection`。

## 4. 代码分层

### 4.1 五个源码区

| 目录 | 运行位置 | 职责 | 规模（当前） |
|---|---|---|---|
| `src/host` | Node / DSH 宿主 | 配置读写与合并、HTTP 路由、余额、对话、语音、待办、工作状态、占用锁、桌面 Helper 管理 | 199 文件（含测试）/ 约 13.4k 行 |
| `src/client` | DSH 网页 | 宠物 overlay、动画链、物理与交互、设置页、对话面板、右键菜单、内置玩法「吃白饭」 | 215 文件（含测试）/ 约 19k 行 |
| `src/shared` | 双端 + 桌面渲染端 | 纯逻辑：配置拍平、物理、几何、动画权重、菜单树、待办渲染、状态形状、字体 | 116 文件（含测试）/ 约 7.5k 行 |
| `src/standalone` | 无 DSH 的本机进程 | CLI、本机 HTTP 服务、独立 AI 配置、请求安全、独立设置页 | 64 文件（含测试）/ 约 4.4k 行 |
| `src/app` | Electron 主进程 | 单进程装配：本机服务 + 宿主 apply + 桌面 Helper + 单实例锁 | 5 文件 / 约 0.5k 行 |
| `runtime/electron-helper` | Electron 主进程 / 渲染端 | 透明置顶窗、托盘、点穿透、DPI、任务栏/置顶看门狗、跨窗碰撞 | 30 文件 / 约 5.7k 行 |

测试与源码同目录放置（`*.test.ts`）：`src/` 下当前 599 个 `.ts` 文件（含测试）中 204 个是测试文件，合计约 7.6 万行；`runtime/electron-helper` 另有 30 个 JS 文件、约 5.7k 行。

### 4.2 依赖方向

```text
入口 carrier（路由 / slot 组件 / CLI / tool）
        ↓
服务编排（balance-poll / chat-memory / desktop-helper / ...）
        ↓
领域纯逻辑（src/shared、host 的 parse / policy / store 判定）
        ↓
介质适配（config 文件、LLM、HTTP 素材、Electron 子进程）
```

几条硬约束（源码模块头里明确写过）：

- `src/host` 不 import `src/shared`（DSH 单文件加载约束会拆 chunk，host 侧配置实现自包含，规则与 shared 同步维护）
- `src/shared` 不依赖 React / DOM；DOM 样式与挂载导出集中在 `menu` / `chat` / `todo` / `tooltip`
- `src/client/index.ts` 只做模块外壳：把 `makeFactory()` 交给 `window.__ModuleLoader__`，不能有顶层 ESM import/export
- 浏览器产物整份包 IIFE：同一页面重复执行 bundle 时，顶层 `const/let` 不会二次声明报错

## 5. 运行时数据流

### 5.1 单一状态出口 `GET /state`

宿主侧 `PollStateStore` 是浏览器端、桌面端、设置页轮询的唯一数据源：

```text
sections: balance | workStatus | notify | config | menu | focusSession
pets.<id>: say | anim | position | throw | lock | sleep
每片叶子 = { counter, data }，counter 变化即视为更新
```

- 所有写入必须经 `writeSection` / `writePet`，并推进 counter
- 支持长轮询 `?since=<顶层 counter>&timeout=<ms>`（成对必填，上限 10s），有变化立即返回
- `config` 是纯信号叶子：只通知消费端去重拉 `GET /config`，本体不进每秒轮询
- `say` / `anim` / `position` / `throw` 是 host → 前端的指令；`lock` / `sleep` 是状态，由前端据此收尾

### 5.2 两条对外通道

| 通道 | 位置 | 使用方式 |
|---|---|---|
| HTTP | DSH Web 服务上的 `/dsh-pet-7340` 前缀 | 跨进程 / 脚本；只监听 `127.0.0.1`、无鉴权；动作类只回 `{ok}`，数据统一读 `GET /state` |
| Cordis 服务 | 页面内 `ctx.get('petApi7340')` | 同页客户端插件，零网络；只在该页面实例内有效 |

HTTP 路由按领域串行分发，顺序即语义，素材路由是末端兜底：

```text
config → desktop → menu → state → session → balance → interaction → motion
→ playback → sleep → chat → attachment → todo → voice → avatar → character → assets
```

睡觉闸门在分发前统一拦截“打扰类”端点（白名单式），新增端点默认放行。

### 5.3 占用锁与睡觉

- 占用锁是第三方联动演出的租约：`POST /lock` 建锁 / 续期，默认 TTL 2 分钟、上限 30 分钟；带 `?lock=` 的接口才受约束
- 锁是内存态，重启即空；用户拖拽 / 点击 / 隐藏 / 关闭会立即抢占（`cause=preempted`）
- 睡觉是用户意图，无期限；进睡时一次写定 `start` / `loop` / `end` 三段动画名，渲染端照播；睡着期间自动来源与手动触发一律被拒绝并回随机台词

## 6. 配置体系

配置是 JSONC（允许注释），三层归属：

| 层级 | 位置 | 内容 |
|---|---|---|
| 内置默认 | `dsh-pet/assets/config.jsonc` | 完整默认值 + 字段注释（约 420 行） |
| 用户层 | `$DSH_HOME/dsh-pet/main-config.jsonc` | 设置页保存 / 「同步」整份写入；字段整体覆盖默认 |
| 文件宠物 | `$DSH_HOME/dsh-pet/pet/<名>-config.json` | pet pack 种类配置，顶层可覆盖条目级字段 |

合并规则：顶层字段整段替换，缺的子键不从默认补回（消费端各自兜底）。设置页只编辑 `main` 条目与全局默认；文件宠物永不回写。

用户数据目录 `$DSH_HOME/dsh-pet/` 还包含：

```text
logs.txt                 # 插件日志（按大小截断）
main-config.jsonc        # 用户主配置
pet/                     # 文件宠物（种类配置、头像、专属素材 / 表情包）
main-animation/          # 用户动画（webm / mov），优先于包内素材
memes/                   # 用户表情包
todos.json               # 待办清单（原子写 + 串行队列）
```

## 7. 素材链与宠物制作

`MAKE-YOUR-OWN-PET.md` 给出全流程；仓库根 `scripts/` 是可复现的实现：

```text
prompts/*.md → video/*.mp4（绿幕 16:9）
  → watermark_step01.py     水印遮罩填充
  → chroma_step02.py        HSV 绿幕抠像转透明
  → normalize_step03.py     归一化 / 步进处理
  → encode_hevc_alpha.sh    可选：Safari/HEVC 兼容 mov（macOS 流水线）
  → encode_preview_gifs.py  预览 GIF
  → dsh-pet/assets/webm/    发布格式：VP9-alpha webm（640×360）
```

Safari 不认 webm alpha，macOS 需要 `.mov` 素材；该分支由 `.github/workflows/hevc-alpha.yml`（macOS runner，手动触发）产出 `assets-mov` Release，不随 npm 包发布。

新增一只宠物有两种粒度：

- 同一角色多实例：改 `pets[]`（id / size / display / position / 开关）
- 新种类（pet pack）：`pet/<名>-config.json` + 该种类素材目录，设置页按种类分组展示

## 8. 构建与开发

包要求 Node.js `>= 22.12.0`，包管理器为 pnpm（`pnpm-lock.yaml` / `pnpm-workspace.yaml`）。

### 8.1 构建入口（`tsdown.config.mjs`，五个产物）

| 入口 | 产物 | 说明 |
|---|---|---|
| `src/client/index.ts` | `lib/client.js` | 浏览器半侧，`react` / `@deepseek-ai/*` 外部化，外层 IIFE |
| `src/host/index.ts` | `lib/index.js` | 宿主半侧，保持 ESM，由 DSH Loader import |
| `src/standalone/cli.ts` | `lib/standalone.js` | 独立 CLI；三个 DSH 专有包用 `src/standalone/shims/*` 替身，target es2022 |
| `src/app/main.ts` | `lib/app.js` | 单进程 Electron 应用；内联 zod / openai / anthropic / edge-tts |
| `src/standalone/settings-page/chat-mount.ts` | `lib/chat-panel.js` | 独立设置页对话面板，内联 react / react-dom |

`scripts/prepare.js`（`npm run build`）串起：`bundle` → `build:desktop-core` → `types` → 收敛 `package.json` 的 `files`，幂等。

### 8.2 常用命令（在 `dsh-pet/` 下执行）

```bash
npm run build          # 完整构建 + files 收敛（克隆后跑一次）
npm run bundle         # 仅 tsdown
npm run build:desktop-core
npm run watch
npm run typecheck
npm run lint
npm run format:check
npm run check:cycles   # import 环检查
npm run check:runtime  # runtime/electron-helper 的 eslint
npm run check:openapi  # openapi.yaml 与路由一致性
npm test               # node --test + strip-types
npm run test:ui
npm run start:desktop  # 桌面模式
npm run start:app      # 独立应用
npm run standalone     # 独立 CLI
npm run dist           # 打 Windows 绿色包到 dist-app/
npm run dev:mock       # mock 服务商
```

发布前 `prepack` 固定链路：`build → typecheck → lint → check:cycles → check:runtime → format:check → prepack-check → check:openapi`。

### 8.3 桌面与分发

- 桌面 Helper 由宿主拉起 Electron 子进程（版本 `43.3.0`，按平台自动探测 / 下载）；Linux 无 `DISPLAY` / `WAYLAND_DISPLAY` 时跳过桌面窗口
- 独立模式默认端口 `3080`，被占用自动顺延；额外提供 `GET /` `GET /health` `POST /shutdown`
- `electron-builder.yml` 产出解包目录，CI 压成固定名 `dsh-pet-win-x64.zip` 挂到已有 Release（`release-app.yml`）

## 9. 测试与质量门禁

- 单元 / 契约测试与源码同目录，`node --experimental-strip-types --test`
- 重点覆盖：配置合并与写回、路由与错误码、锁与睡觉状态机、动画权重与几何、物理（拖拽 / 抛掷 / 碰撞 / 挤压）、工作状态聚合、对话记忆、语音缓存
- 门禁：`typecheck`、`lint`、`format:check`、`check:cycles`、`check:runtime`、`check:openapi`、`test`、`build`
- 生成物（`lib/**`、`runtime/electron-helper/shared-core.js`）不入库

## 10. 扩展点

| 想做什么 | 入口 |
|---|---|
| 第三方驱动桌宠说话 / 播动画 / 读状态 | HTTP `/dsh-pet-7340/*` 或页面内 `petApi7340` |
| 注册余额服务商 | `ctx.get('petApi7340').balance.register(def)`（内置优先，id 冲突抛错，返回 disposer） |
| 注册语音合成 / 识别 | `petApi7340.voice.register` / `petApi7340.speech.register` |
| 注册对话记忆后端 | `petApi7340.memory.register` |
| 往右键菜单加项目 | `POST /menu/item` + `GET /menu/events`（统一收在「更多」下） |
| 加一种宠物 | `pet/<名>-config.json` + 素材目录（pet pack） |
| 加内置余额服务商 | `src/host/balance/providers/` 新增文件并在 `registry.ts` 登记 |
| 加动画 | 素材链产出 webm，写进对应条目的 `animations` |

## 11. 已知边界

- 浏览器 overlay 依赖 VP9-alpha webm：Chromium / Firefox 可用，Safari 不支持（需换 `.mov` 素材）
- HTTP 接口只监听回环且无鉴权，不能转发到公网
- 独立模式不提供 DSH 页面浮层；余额、DSH 工作状态、系统通知仍依赖 DSH 宿主（接口会结构化降级，不假装成功）
- 宿主半侧代码改动需重开 DSH 才生效；浏览器半侧刷新页面即可
- 素材（动画 / 提示词 / 源视频）遵循 CC BY-NC-SA 4.0，禁止商用；二创在公开渠道须署名原作者

## 12. 文档索引

| 文档 | 内容 |
|---|---|
| `README.md` | 项目总览、功能预览、安装入口、许可 |
| `INSTALL.md` | 前置要求、三种安装方式、独立模式、打包 |
| `FEATURES.md` | 余额 / 碎碎念与对话 / 语音 / 工作状态 / 待办 / 睡觉详解 |
| `CONFIG.md` | 设置页、`config.jsonc`、手改配置、pet pack |
| `API.md` | HTTP 接口一览与 `/state` 结构 |
| `openapi.yaml` | OpenAPI 3.1 完整契约 |
| `CORDIS.md` / `CORDIS-API.md` | 页面内 Cordis 服务 |
| `MAKE-YOUR-OWN-PET.md` | 提示词 → 视频 → 透明动画 → 插件 → 发布 |
| `tools/api-tester.html` | 第三方消费方示例（本地代理解决跨域） |
| `tools/cordis-probe/` | 同页客户端插件消费示例 + mock 服务商 |

## 13. 版本与许可

- 插件版本：`0.4.7`（`dsh-pet/package.json`）
- 代码：MIT
- 素材：CC BY-NC-SA 4.0（署名 · 非商业 · 相同方式共享）
- 形象出处：社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），非官方形象；原型「溟月」出自 B 站 @上善无形，DeepSeek 版设计出自 B 站 @ZipZipPipe
