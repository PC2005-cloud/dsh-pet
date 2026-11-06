# dsh-cordis-probe

仓库级测试插件：模拟第三方消费者。

| 半侧 | 职责 |
|---|---|
| 客户端 | 页面右下角面板，列出 dsh-pet 的服务并调用（`ctx.get`，零请求）；头部多两个**语音 / 识别开关**按钮 |
| 宿主 | 注册五个 mock 服务商，让模型选择器里能选到它们，用来验证余额气泡（含两种自定义多页）；另提供语音、识别与记忆三个开关路由 |

## 安装

DSH 设置 →「添加插件」→ 填本目录绝对路径，重启 `dsh web`。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/client.js` | 服务清单面板 + 语音 / 识别开关按钮 |
| `lib/index.js` | 宿主半侧：注册模型路由、余额服务商与两个开关路由 |
| `lib/mock-balance.js` | 五个 mock 服务商的数据：3 种内置形态 + 2 个自定义多页（4 页 / 3 页） |
| `lib/mock-adapter.js` | 让 mock 服务商出现在模型选择器里 |
| `lib/mock-voice.js` | mock 语音实现：不论文本，一律返回一段内置提示音（0.3 秒 660Hz） |
| `lib/mock-speech.js` | mock 识别实现：不看音频，一律回「mock 识别：收到 N 字节」 |
| `lib/mock-memory.js` | mock 记忆实现：每只宠物存最近 5 轮，问到「记得/之前/上次」时把上一轮作为证据注入 |
| `lib/toggle-route.js` | 三个开关共用的路由：`GET` 读状态、`POST` 翻转 |

## 语音开关

面板头部的「语音：关/开」按钮控制一个 mock 语音实现，**默认关闭**：

- 打开 → 调 `petApi7340.voice.register` 注册 `mock-tone`，此后 `POST /voice/speak` 改走它，返回一段提示音；
- 关闭 → 调注册返回的 disposer 注销，合成回到内置实现；
- 插件卸载时会自动注销，不会把 mock 语音留在宿主里。

## 识别开关

面板头部的「识别：关/开」按钮控制一个 mock 识别实现，**默认关闭**：

- 打开 → 调 `petApi7340.speech.register` 注册 `mock-asr`，此后 `POST /voice/hear` 改走它，回来一段带字节数的假文字；
- 关闭 → 调注册返回的 disposer 注销，识别回到宿主自带能力（DSH 的 `speechToText`）；
- 插件卸载时会自动注销，不会把 mock 识别留在宿主里。

返回的文字里带字节数，是为了验证音频真的穿过了 base64 与 HTTP：发一段 121 KB 的 WAV，回「收到 121388 字节」就说明整条链路通到了宿主。

按钮与注册分属两半（页面 / 宿主），中间隔着 HTTP，所以宿主额外开了两个最小路由——只服务本示例，不属于 dsh-pet 的接口面。

## 记忆开关

`/cordis-probe-memory` 控制一个 mock 记忆实现，**默认关闭**（面板头部有按钮，也可以直接打路由）。

**怎么证明扩展真的生效**（原生历史做不到这两点）：

1. 打开记忆 → 聊一句 → `GET /cordis-probe-memory` 的 `captured` 加 1：`capture` 收到了这一轮；
2. 再发一句带「记得/上次」的话 → 回复开头应出现 `[MOCK-RECALL-OK]`：`recall` 改写了本轮内容。这个标记是 mock 要求模型复读的，原生历史不会产生它。

关闭 → disposer 注销，`recall`/`capture` 都不再发生；再问同样的话，标记消失、`captured` 停住。插件卸载时自动注销。

```bash
curl -X POST http://127.0.0.1:<port>/cordis-probe-memory   # 打开 / 关闭
curl http://127.0.0.1:<port>/cordis-probe-memory           # {"ok":true,"on":…,"captured":N}
```

## 余额 mock 一览

| provider id | 形态 | 气泡内容 |
|---|---|---|
| `mock-windows` | windows | 三窗口用量（5h / 周 / 月），最紧迫的是月窗口 |
| `mock-money` | money | 双币种余额 + 峰谷装饰 |
| `mock-points` | points | 积分 800 / 1000 |
| `mock-custom-kinds` | custom（4 页） | 用节点树复刻「窗口 / 金额 / 积分」三页 + 一页三者汇总 |
| `mock-custom-fancy` | custom（3 页） | 多模型余量、钱包构成（含 PRO 角标）、用量统计格 |

自定义服务商的气泡**点击循环切页**（末页回第一页），`percent` 字段驱动档位动画。
