# dsh-pet — 设计与实现

> 状态：已实现并运行。本文档描述当前实际实现；与代码有出入时以代码为准。
> 仓库：https://github.com/PC2005-cloud/dsh-pet

---

## 1. 项目定位

在 DeepSeek Harness Web 界面（`dsh web`）显示一只**常驻动画宠物**：待机呼吸、随机动作（含打瞌睡）、偶尔转向、屏幕漫游、点击反应、可拖拽。

**三件套成果**：
1. **提示词**（`prompts/`）——51 个动作的生成配方（绿幕规范 + 按秒分解）
2. **素材生成链**（`scripts/` + `video/`）——源视频 → 透明动画的完整处理管线
3. **插件**（`dsh-pet/`）——运行在 DSH 里的成品

任何人 clone 仓库后，可用提示词生成自己的宠物，跑素材链得到动画，安装插件使用——**从零到宠物全流程可复现**。

## 2. 素材处理链（Python + ffmpeg）

素材链在工作区 `scripts/` 目录，7 个脚本构成流水线：

> 注：`video/` 源 mp4 与 `dsh-pet/assets/preview/` GIF 不入 git，托管在 GitHub Releases（tag `assets-v1`：`video-src.zip` + 51 个拼音名 GIF），README 引用 `releases/latest/download/` 直链。

```
video/（51 个原始绿幕 mp4 + 水印 mask；源视频从 Releases 下载 video-src.zip 解压）
  → watermark_step01.py  水印遮罩填充          → step01/（mp4）
  → chroma_step02.py     HSV 色相绿幕抠像转透明  → step02/（透明 webm）
  → normalize_step03.py  归一化 2160×1215 统一站立居中 → step03/（母版）
  → encode_thumbs.py     转码 640×360 播放变体   → step04/（thumb）
```

- 运行方式：`cd scripts && python watermark_step01.py`（依次 4 步；`make_mask_black.py` 生成水印 mask，`fill_nn.py` 被 watermark_step01 调用）
- 依赖：Python 标准库 + numpy + scipy + 工作区自带 ffmpeg（`.tools/`）
- 关键点（踩过的坑）：
  - `chromakey` + `format=yuva420p` 保留 alpha 透明
  - `-c:v libvpx-vp9` 必须放在 `-i` 前（libvpx 解码才能保留 VP9 alpha，否则黑底）
  - Windows 下 `subprocess.run(text=True)` 需 `encoding="utf-8", errors="replace"`
  - 绿幕抠像最终采用 **HSV 色相方案**（非 chromakey/RGB 差值）：仅绿相 70~170° 且饱和度/明度 ≥0.15 才抠掉，人物保留 97~98%、绿幕清除 99.6%+，不误伤亮绿残边/白衣/蓝衣
  - 水平居中用**非透明像素 x 中位数**（非 bbox 中点）：手/零食等扩展物会把 bbox 中心带偏 200px，中位数全片稳定
- step04 产物同步到 `dsh-pet/assets/thumb/`（npm 包自包含播放资源）

## 3. 插件架构（dsh-pet/）

### 3.1 双半侧 bundle

```
dsh-pet/
├── package.json            # "dsh": {"bundle"} + exports["./client"] + "dsh":{"client"}
├── cordis.patch.yml        # insert pet 行
├── assets/thumb/*.webm     # 51 个 640×360 播放变体（~28MB）
├── lib/
│   ├── index.js            # host 半侧（服务器端，/pet 视频路由）
│   ├── client.js           # 浏览器半侧（手写官方 CJS bundle）
│   └── types/              # TypeScript 声明
├── scripts/prepack-check.js # npm 发布前健康检查
├── README.md               # 极简（指向仓库）
└── LICENSE                 # MIT
```

### 3.2 host 半侧（lib/index.js）

- 注册 `/pet/` 前缀路由（`ctx.webServer.register`）：
  - `/pet/thumb/<name>.webm` → 读 `assets/thumb/`（播放资源）
  - `/pet/full/<name>.webm` → 读 `$DSH_HOME/pet-assets/`（原始母版，需手动下载）
- 防路径穿越（`resolveAsset`）+ 流式返回 + 缓存 1 小时

### 3.3 浏览器半侧（lib/client.js）

- 注册到官方 `shell.overlay` 列表槽（全应用浮动层，点击穿透）
- **双缓冲播放**：两个 `<video>` 层叠交叉淡入，切换永无空白帧
- **竞态防护**：`genRef` 代数守卫 + `old !== el`，快速连点不导致宠物消失
- **朝向系统**：`facing`（left/right），right 时 CSS `scaleX(-1)` 镜像（素材全对称、不穿帮）
- **落地对齐**：360 画布脚底 y=330，按比例平移舞台使脚踩地面

### 3.4 构建形态

- `lib/client.js` 手写官方 `__ModuleLoader__.load({ id, factory })` 形态
- React 从 DSH 外壳平台模块表 require（不自己打包）
- 零构建链、零依赖、可读可改

## 4. 动画流程（链式模型）

**核心设计：没有常驻待机、没有定时器**。每个动画（含待机呼吸休闲）都是一次性播放，播完立即按概率选下一个——首尾相接、永不停止。

### 4.1 动画分类（51 段）

| 组 | 动画 | 用途 |
|---|---|---|
| 待机 | 待机呼吸休闲 | 链中一环（30% 概率），播 10s 后切走 |
| 转向 | 东张西望 | 播完翻转 facing |
| 移动 | 螃蟹走路、原地漂浮踏步、原地左转奔跑 | 漫游姿态（位置由代码驱动） |
| 动作池 | 其余 32 个（含打瞌睡被惊醒） | 等概率随机抽 1 段 |
| 点击回应 | 点击回应 ×3 | 仅点击触发 |
| 拖拽 | 被鼠标拖拽悬空反馈 | 仅拖拽触发 |

### 4.2 动画链

```
开始（初始待机呼吸休闲）
  │ 播完（10s）
  ▼
pickNext() 按概率选下一个 ──────────────┐
  30% 待机 / 10% 转向 / 40% 动作 / 20% 移动 │
  └──────────────────────────────────────┘
        ▲ 播完
        └── 循环（永不停止）

交互打断：点击/拖拽 → 交互动画 → 播完先回待机缓冲 → 待机播完进动画链
```

### 4.3 关键机制

- **`pickNext()`**：`roll = Math.random()`，`<0.3` 待机 / `<0.4` 转向 / `<0.8` 动作 / `>=0.8` 移动（空间不够回退动作）
- **`seq` 序号**：每次切换 +1，连续选中同一动画也强制重播
- **移动系统**：动画是"皮"（姿态）、rAF 是"骨架"（位移），位置随 `video.currentTime` 同步；前后各 2s 准备/收尾位置不动，中间 6s 走完全程；播放前检查屏幕空间
- **交互**：点击 3 回应随机、拖拽超 5px 判定 + 跟手、松手停在拖拽处

## 5. 配置项

当前 client 端 `apply(ctx, config)` 收到空对象（DSH 客户端配置管线限制），参数走代码内默认值：

| 参数 | 默认 | 位置 |
|---|---|---|
| size / position | 462（宽度，≈260px 高）/ bottom-right | client.js |
| 动画链概率 | 30/10/40/20 | client.js `pickNext` |
| 移动距离/边距 | 60-240px / 20px | client.js 常量 |
| 移动准备/收尾 | 2s / 2s | client.js 常量 |
| 转码分辨率/质量 | 640×360 / CRF 40 | scripts/encode_thumbs.py |

## 6. 构建与发布

```
1. scripts/*.py（素材链）    video/ → step01-04
2. step04 → dsh-pet/assets/thumb/（同步）
3. prepack-check.js          npm publish 前健康检查
4. npm pack                  检查 tarball（~10MB）
5. npm publish               之后 dsh plugin add dsh-pet 一条命令安装
6. GitHub Releases           上传原始母版（step03/，172MB 存档）
```

## 7. 里程碑

| 阶段 | 状态 |
|---|---|
| M1 骨架（host 路由 + overlay 挂载） | ✅ |
| M2 交互（点击/拖拽/转向/双缓冲/竞态防护） | ✅ |
| M3 素材链（转码管线 + 51 动画 + 对齐） | ✅ |
| M4 动画链模型（无常驻待机） | ✅ |
| M5 开源（README/LICENSE/仓库） | ✅ 仓库已建，待推送 |
| M6 发布（npm + Releases） | ⏳ |

## 8. 许可

- 代码：MIT（仓库根 + dsh-pet/LICENSE）
- 素材（动画/提示词）：与代码同协议或单独声明（待定）

## 9. 踩坑记录

1. **jsx 第三参数是 key 不是 children**——children 必须放 props
2. **双缓冲竞态**——genRef 代数守卫防两个 video 同时透明
3. **VP9 alpha 丢失**——`-c:v libvpx-vp9` 必须在 `-i` 前（解码端）
4. **Windows 编码**——subprocess text=True 需 utf-8 + errors=replace
5. **thumbRoot 路径**——`assets/thumb/` 子目录 vs `assets/` 根
6. **pnpm file: 依赖是复制**——改源码后必须 remove+add 重新安装
