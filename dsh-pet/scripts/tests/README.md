# 设置页浏览器回归

在 `dsh-pet/` 包目录运行：

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
npm run test:ui
```

Linux CI 缺少系统库时用 `pnpm exec playwright install --with-deps chromium`。

测试用真实 React 和 Chromium 渲染设置页，拦截配置与模型接口，验证加载、失败重试、恢复默认与保存，以及中英文窄窗口布局。只访问临时本地服务，不读取或修改用户的 DSH 配置。与 `npm test` 的 Node 单元测试分开运行，普通插件安装不下载浏览器。

可选设置 `DSH_PET_UI_ARTIFACTS` 为输出目录，保存布局截图。桌面 Electron 窗口、操作系统点击穿透和显示器缩放仍需另做运行时测试。
