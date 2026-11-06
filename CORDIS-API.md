# dsh-pet 对外 Cordis 接口一览

dsh-pet 提供两个 Cordis 服务：页面内的 `petApi7340`（浏览器半侧）与宿主进程内的同名服务（宿主半侧）。
同名但分属不同容器，互不可见——在页面里 `ctx.get()` 只拿到客户端那组，在宿主插件里只拿到宿主那组。
本文只做**功能预览**（成员 + 一句话），完整契约——参数、返回字段、边界与示例——见 [`CORDIS.md`](CORDIS.md)。

- **怎么拿**：`ctx.get('petApi7340')`；拿不到对应分组 = 你在另一半，或 dsh-pet 未启用 / 版本过旧
- **只读**：两个服务都不提供控制通道；让它说话、做动作、改配置仍走 HTTP（见 [`API.md`](API.md)）
- **零网络**：服务调用就是进程内函数调用，不占连接、不经过端口

---

## 一、客户端半侧（DSH web 页面内，只在该页面实例内有效）

| 成员 | 功能 |
| --- | --- |
| `pose(petId)` | 读一只宠物此刻的位置与朝向（视口归一化 0–1）；这一页没有它就回 `null` |
| `progress(petId)` | 读一只宠物此刻的播放进度：动画名、当前时间、总时长、是否暂停 / 缓冲 |
| `getState()` | 读本页最近一拍的 `/state` 全量快照（与 `GET /state` 同形）；首拍之前回 `null` |
| `menuEvents(owner)` | 取本页第三方菜单的点击结果（与 `GET /menu/events` 同形，**读取即消费**） |

## 二、宿主半侧（宿主插件进程内）

| 成员 | 功能 |
| --- | --- |
| `balance.register(def)` | 注册一个自定义余额服务商（`{ id, fetch }`）：`shape` 支持 `windows` / `money` / `points` / `custom`，最后一种是自己画节点树；宿主统一排期、统一渲染气泡 |
| `balance.list()` | 列出内置与已注册的余额服务商 id，用来确认注册是否生效 |
| `voice.register(def)` | 注册一个语音合成实现（`{ id, name, synthesize }`）：注册后 `POST /voice/speak` 改走它，`synthesize` 返回 mp3 字节；同一时刻只有一个生效，后注册覆盖先注册 |
| `voice.list()` | 列出内置与已注册的语音实现 id，用来确认注册是否生效 |
| `speech.register(def)` | 注册一个语音识别实现（`{ id, name, transcribe }`）：注册后 `POST /voice/hear` 改走它，`transcribe` 收 WAV 字节回文字；同一时刻只有一个生效，后注册覆盖先注册 |
| `speech.list()` | 列出内置与已注册的识别实现 id，用来确认注册是否生效 |
| `memory.register(def)` | 注册一个第三方记忆实现（`{ id, recall?, capture? }`）：`recall` 在生成前改本轮 `system/history/userText`，`capture` 在落盘后收这一轮；同一时刻只有一个生效，后注册覆盖先注册 |
| `memory.list()` | 列出原生与已注册的记忆实现 id，用来确认注册是否生效 |

---

## 相关

- [`CORDIS.md`](CORDIS.md) —— 完整契约：参数、返回字段、边界与示例
- [`API.md`](API.md) / [`openapi.yaml`](openapi.yaml) —— 同一个插件的 HTTP 一侧
- [`tools/cordis-probe`](tools/cordis-probe/README.md) —— 同页第三方插件的示例：自动列出 dsh-pet 的服务与成员，可直接调用
