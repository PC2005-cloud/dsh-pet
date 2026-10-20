# dsh-cordis-probe

模拟「第三方客户端插件」消费 Cordis 服务。和 `tools/api-tester.html` 是一对：

| | 测什么 | 怎么到 |
|---|---|---|
| `tools/api-tester.html` | HTTP 接口（`/state`、`/anim`、`/pose` …） | 跨进程，走网络 |
| `tools/cordis-probe/` | Cordis 服务（`petApi7340` 及以后每一个） | 同页，`ctx.get()`，零请求 |

## 为什么不是独立 URL

客户端插件注册不了浏览器路由——DSH 客户端只给插槽，DSH web 是单页。而服务是**页面实例绑定**的：换 URL 就是换 window、换 Cordis 容器，`ctx.get('petApi7340')` 必然为空。

所以面板**直接常驻**在页面右下角，不挂路由、不用 hash 触发：装上后刷新页面就看到。

## 安装

DSH 设置 →「添加插件」→ 输入本目录的绝对路径：

```
D:\Projects\Web\pet\tools\cordis-probe
```

DSH 只接受**组合包**，所以 `package.json` 必须同时声明 `dsh.bundle.patch`：只写
`dsh.client` 会被拒（`declares no dsh.bundle`）。`cordis.patch.yml` 就是那一层 patch，
装完自动叠进配置树，不用再手动改 profile 的 `dependencies` / `bundles`。

装完重启 `dsh web`。

## 用法

刷新页面，面板在右下角。

- **服务清单**：只列 dsh-pet 提供的服务（按提供者过滤，平台那几十个不混进来），绿点 = 本页已提供
- **点一行**展开成员；函数成员有两个按钮：
  - 「调用」读一次，参数用逗号分隔逐段 `JSON.parse`（`main` 这种解析失败的原样当字符串）
  - 「跟随」每帧读一次，直到再点一次停止 —— 专治 `progress` 这类"读一次看不出变化"的量

## 文件

| 文件 | 作用 |
|---|---|
| `lib/client.js` | 浏览器半侧，手写经典脚本，无构建 |
| `lib/index.js` | 宿主半侧空壳（`main` 必须有，否则 patch 里的 entry 加载失败） |
| `package.json` | `exports['./client']` + `dsh.client.platform: 'web'` |

没有构建步骤：`lib/client.js` 直接就是 `window.__ModuleLoader__.load({ id, factory })` 形态，改完刷新页面即可（DSH 会重新取文件）。
