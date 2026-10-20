# dsh-pet

桌面宠物：DSH（DeepSeek Harness）的 Cordis 插件，同时可作为独立应用在桌面上运行。

## 架构导航

同一个 npm 包里有三层，改动前先确认自己在哪一层：

- **宿主半边**（`dsh-pet/src/host/`）—— 挂在 DSH 进程里，注册 `/dsh-pet-7340` 路由，负责拉起桌面壳
- **桌面壳**（`dsh-pet/runtime/electron-helper/`）—— 一个被 `electron.exe main.js` 直接拉起的裸脚本，每只宠物一个透明置顶小窗，经 bridge 管道与宿主通信
- **独立模式**（`dsh-pet/src/standalone/`）—— 用伪 Cordis ctx 直接跑宿主外边，起本机 HTTP 服务，不需要 DSH

浏览器半边（`src/client/`）只在前两层都存在时才工作。

## 构建与验证

所有命令都在 `dsh-pet/` 目录下执行（包根在那里，不在仓库根）。

依赖用 **pnpm** 安装（有 `pnpm-lock.yaml`）。**先装依赖再跑任何检查**，否则 `npm test` 会因 `ERR_MODULE_NOT_FOUND` 全红、`typecheck` 找不到 `tsc`。

验证命令见 `dsh-pet/package.json` 的 `scripts`；CI 在 `.github/workflows/check.yml` 里跑同样的四项（typecheck / test / lint / format:check）。

## Agent skills

### Issue tracker

本仓库用**本地 Markdown** 追踪 issue 与 spec，文件放在 `.scratch/<feature>/` 下，不依赖 `gh` / `glab`。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个规范化标签，标签字符串与角色名一致：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）布局：仓库根 `GLOSSARY.md` + `docs/adr/`。详见 `docs/agents/domain.md`。
