# 安装（dsh-pet）

> 返回 [README](README.md)

装法取决于你在用哪个 DSH：**桌面应用**用应用内「插件管理」，**`dsh web`** 用命令行，改用源码安装则先 clone 再构建。几条路最终都是把插件装进 profile 的 `node_modules`，效果一样；区别只是入口。

装完**重开 DSH**（`dsh web` 用户则重启 `dsh web`）才生效——运行中的进程持有内存里的旧插件。宠物出现在界面右上角（默认配置角落，可在设置页修改）。

## 前置要求

命令行安装需要 Node.js 与 DSH 启动器；桌面应用自带 CLI 与运行时，可跳过本节。

```sh
# ① 前置要求：确认 Node.js 已安装
node -v

# ② 安装 DSH 启动器与 pnpm（已装可跳过；装完请重新打开终端）
npm install -g @deepseek-ai/dsh pnpm
dsh --version   # 验证 dsh 命令可用
```

## 方式一：应用内「插件管理」（桌面应用）

直接打开应用内「插件管理」页，在安装框里填 `dsh-pet`，不用开终端。需要在终端里操作插件时，用桌面应用自带的那份 CLI。

## 方式二：命令行（`dsh web` 与桌面应用）

`--profile <profile>` 指定装进哪个 profile，按你在用的界面填：

| 你在用的界面 | `--profile` 的值 |
| --- | --- |
| `dsh web`（浏览器） | `web` |
| 桌面应用（Electron 版） | `desktop` |

```sh
# dsh web
dsh plugin --profile web add dsh-pet

# 桌面应用（Electron 版）
dsh plugin --profile desktop add dsh-pet
```

> **兼容性**：本插件当前在 dsh **`0.2.2-alpha.2`** 下开发并测试（`dsh --version` 可查看你的版本）。建议使用相同版本；其他版本如遇问题欢迎反馈。

## 方式三：从源码安装（clone 本仓库后）

`lib/` 构建产物不入库，clone 后需要先构建再安装：

```sh
# ① clone 本仓库，进入插件目录
git clone https://github.com/PC2005-cloud/dsh-pet.git
cd dsh-pet/dsh-pet

# ② 安装依赖
npm install

# ③ 构建（完整 lib：tsdown → lib + 桌面共享核心 + 类型声明）
npm run build       # 必须手动跑一次（克隆后 npm install 不再自动构建）

# ④ 安装到 DSH（file: 指向**插件目录**——上面 cd 进去的那一层，用构建好的 lib）
#    --profile 填实际在用的那个：dsh web → web；桌面应用 → desktop
dsh plugin --profile web add file:D:/path/to/dsh-pet/dsh-pet
```

> 注：`npm run build`（即 `scripts/prepare.js`）才产出**完整可安装**的 lib——除 tsdown 构建外还构建桌面共享核心（`shared-core.js`）、生成类型声明并收敛发布 `files` 清单；裸 `tsdown` 构建会缺桌面运行时与类型。发布与打包（`npm publish` / `npm pack`）时由 `prepack` 自动调用它，克隆仓库后需手动跑一次。

## 独立模式（无需 DSH）

完全不装 DSH 也能用：宿主半边跑在伪 ctx 上，由一个本机服务接管路由（**路由表仍是插件那一份**），桌宠显示在独立窗口里。两种拿到它的方式——用 Release 里的绿色包，或从源码自己构建。

### 直接运行（Release 绿色版）

1. 到 [Releases](https://github.com/PC2005-cloud/dsh-pet/releases) 页面挑一个版本，下载它的 `dsh-pet-win-x64.zip`（固定名）；
2. 解压到任意目录，例如 `D:\dsh-pet`；
3. 双击目录里的 `dsh-pet.exe`。

不需要 Node.js，也不需要 DSH，Electron 运行时已经打进包里；关闭窗口即退出。

> Release 只提供 **Windows x64**；macOS / Linux 用下面的 npm 形态。

### 用 npm 全局安装（Node 形态）

需要 Node.js，跨平台通用：

```sh
npm install -g dsh-pet        # 必须 npm 装；dsh plugin add 会装进 profile，bin 不在 PATH 上
dsh-pet-standalone            # http://127.0.0.1:3080/dsh-pet-7340/（端口占用则顺延）
dsh-pet-standalone --check    # 只体检，不启动
dsh-pet-standalone --port 3100
```

`Ctrl+C` 或 `POST /shutdown` 退出。

### 从源码构建与启动

```sh
npm install
npm run build          # 完整 lib：tsdown + 桌面共享核心 + 类型声明
npm run standalone     # Node 形态启动，等同 dsh-pet-standalone
```

### 打包成 exe

```sh
npm run ensure:electron   # 首次：解析本机 Electron 解压目录（没有则下载到 ~/.dsh/electron）
npm run dist              # electron-builder 打包
```

产物在 `dist-app/win-unpacked/`，双击其中的 `dsh-pet.exe` 即可运行。**只出「解包目录」一种形态**（绿色版），不出 nsis 安装包——要分发就把整个目录压成 zip。

- 本机找不到 Electron 解压目录时 `dist` 会直接失败并提示先跑 `ensure:electron`（可用 `DSH_PET_ELECTRON_DIST` 指向现成目录）；CI 里设 `DSH_PET_ALLOW_ELECTRON_DOWNLOAD=1` 让它自行下载。
- 发版由 `v*` tag 触发 `.github/workflows/release-app.yml`：构建后把固定名 `dsh-pet-win-x64.zip` 挂到该 tag 的 Release 上（不创建 Release、不改更新日志）。

### 能力边界

- **能用**：动画链、点击/拖拽/甩抛、右键菜单、多开、自定义动画与表情包、pet pack。
- **不可用**：余额、碎碎念、对话、系统通知——没有 DSH 的凭据与模型连接，接口返回带 `reason` 的结构化失败（见 [API.md](API.md)）。
- **配置**：与 DSH 同一份（`$DSH_HOME/dsh-pet/main-config.jsonc` → 包内默认）。
- **只显示** `display` 含 `desktop` / `both` 的实例；端口默认 3080（占用则顺延）。
- **可与 DSH 内运行同时开**，但共用 `%APPDATA%\dsh-pet-electron-helper`，可能互相踩缓存（仅告警）。

## 安装后你会看到什么

默认配置是 `display: "both"`（浏览器与桌面都显示），所以重开 DSH 之后会依次出现两处，不必手动开：

1. **浏览器端先出现。** 宠物落在界面右上角（默认角落，设置页可改），此时桌面上还是空的。
2. **宿主自动补桌面运行时。** 本机没有 Electron 时，插件会自己下载一份（落在 `~/.dsh/electron`，同一版本只下一次；默认走 npmmirror 镜像）。进度直接打在 DSH 的控制台里，形如：

   ```
   [dsh-pet] Electron not found, downloading to <用户目录>/.dsh/electron/electron.exe ...
   [dsh-pet] Electron not found, downloading v43.3.0 (win32-x64) ...
   [dsh-pet] downloading 42.3MB / 104.1MB
   [dsh-pet] download complete (37.5s), extracting to <用户目录>/.dsh/electron ...
   ```

   这一步在**后台**进行，浏览器里的宠物照常可用；要等多久取决于网速（几十秒到几分钟），期间不用管它。

3. **桌面端随后出现。** 解压完自动拉起桌面 Helper，同一只宠物以透明窗形式落到桌面上——**此时屏幕上一共两只**：浏览器里一只、桌面上那只，共用同一份配置与同一套动画。
4. **想只留一只。** 两条路都行，改完即时生效：
   - **设置页**：选中该宠物 →「显示位置」下拉框 → 仅浏览器 / 仅桌面 / 两者都显示 / 都不显示；
   - **宠物右键**：菜单里的「显示位置」子菜单 → 仅网页 / 仅桌面 / 两者 / 都不（不用回设置页）。

> 已经装过 Electron（或设了 `DSH_PET_ELECTRON_PATH` 指向现成可执行文件）时，第 2 步会跳过，桌面端几乎立刻出现。下载失败**只影响桌面模式**：控制台会给出提示，浏览器里的宠物不受影响；网络受限时可以设 `DSH_PET_ELECTRON_MIRROR` 换镜像、`DSH_PET_ELECTRON_VERSION` 指定版本，重启后再试。

## 下一步

- 大小、位置、多开、物理参数等配置：见 [CONFIG.md](CONFIG.md)
- 想自己生成一只宠物：见 [MAKE-YOUR-OWN-PET.md](MAKE-YOUR-OWN-PET.md)
