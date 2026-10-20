# dsh-pet 对外 HTTP 接口一览

dsh-pet 的宿主半侧向 DSH 自己的 Web 服务注册了**一条前缀路由** `/dsh-pet-7340`，浏览器端、
桌面端、设置页与第三方插件全都访问同一份实现。本文只做**功能预览**（接口名 + 一句话），
完整契约——参数、响应体、字段含义、错误码与示例——见根目录的 [`openapi.yaml`](openapi.yaml)。

- **基址**：`http://127.0.0.1:<port>/dsh-pet-7340`，`<port>` 是 DSH Web 服务实际监听的端口
- **只监听 127.0.0.1，且没有鉴权**：任何能访问本机该端口的进程都能调用，请勿转发到公网

---

## 一、读状态

| 接口 | 功能 |
| --- | --- |
| `GET /dsh-pet-7340/state` | **轮询唯一数据源**：所有状态位都在这里；带 `?since=&timeout=` 可长轮询 |
| `GET /dsh-pet-7340/config` | 读合并后的成品配置（内置默认 + 用户层，字段已填满） |
| `GET /dsh-pet-7340/config/meta` | 配置文件路径、各类数据落盘位置、卸载该用哪个 profile |
| `GET /dsh-pet-7340/models` | 可用服务商与模型清单（与 DSH 自己的模型选择器同源） |
| `GET /dsh-pet-7340/chat?pet=` | 读某只桌宠最近的对话记忆窗口；带 `?rounds=` 可指定本次读取的轮数（0–200，不传用配置的 `chatMemoryRounds`） |
| `GET /dsh-pet-7340/pose?pet=` | 读**桌面端**宠物的实况（位置 + 朝向）；网页端用客户端服务 `petApi7340`，不走这条路 |

## 二、占用锁

| 接口 | 功能 |
| --- | --- |
| `POST /dsh-pet-7340/lock?pet=` | **占用锁**：联动演出期间独占这只宠物（除持锁者外全静音）；`lockId` 给了=续期、没给=新建，回 `lockId` + `expiresAt` |
| `POST /dsh-pet-7340/lock/release?pet=` | **释放占用**：`lockId`=持锁者收工 / `force`=用户接管（渲染端上报，第三方不用调） |

**锁占用期间，桌宠完全静止**：它自己不动、也不弹气泡——余额、碎碎念、工作状态这些全都让路。

标了「（需锁）」的接口，第三方调用时**必须带上 `?lock=<lockId>`**。锁就是给第三方用的：带上它，
才能保证这段时间归你控制，不被别的插件、也不被桌宠自己的事件打断。没带 → `lock-required`；
编号不对 → `lock-lost`（附 `cause`：过期 / 已释放 / 被用户抢走）。

两条边界：

- **没有锁时**：不传 `?lock=` 一切照旧；传了 `?lock=` 说明你以为自己还持有 → 回 `lock-lost`，
  `cause` 告诉你锁是怎么没的（过期 / 已释放 / 被用户抢走）；
- **用户优先**：用户拖一下宠物、或把它隐藏 / 关闭，锁会立刻被撤掉。`/whisper`、`/balance`、`/chat`
  是用户自己点的入口（右键菜单 / 斜杠命令），占用期间照常可用。

## 三、让它说话（气泡）

| 接口 | 功能 |
| --- | --- |
| `POST /dsh-pet-7340/whisper?pet=` | 让桌宠**生成**一句碎碎念（走当前模型）；响应带 `text`（配图时另有 `image`），同时照旧写进气泡 |
| `POST /dsh-pet-7340/broadcast?pet=` | **第三方投喂**（需锁）：把外部给定的文本写进气泡（不生成，只搬运）；配图（`image` 池内名 / `url` 自带地址）、时长、动画联动可选 |
| `POST /dsh-pet-7340/bubble/clear?pet=` | **清空气泡**（需锁）：提前收起说话气泡（只动气泡，不动动画） |
| `POST /dsh-pet-7340/chat?pet=` | 对桌宠说一句话并生成回复，同时写入对话记忆；响应带 `text`（配图时另有 `image`），同时照旧写进气泡 |
| `POST /dsh-pet-7340/balance` | 立即刷新一次余额（可见效果同样是弹气泡 + 档位动画） |

## 四、让它做动作

| 接口 | 功能 |
| --- | --- |
| `POST /dsh-pet-7340/anim?pet=` | **点播动画**（需锁）：播池内名字（同右键「动作」菜单）或第三方自带的 `url`；`facing` 可选指定朝向（`left`/`right`，不传则不动朝向）；回 `playbackId` |
| `GET /dsh-pet-7340/playback/{id}` | **播放回执**：查那次点播的真实状态；带 `?wait=&timeout=` 可挂起等待 |
| `POST /dsh-pet-7340/playback/{id}/report` | 渲染端上报播放状态（**内部通道**，第三方不用调） |
| `POST /dsh-pet-7340/pose/report?pet=` | 桌面渲染端上报实况（**内部通道**，第三方不用调） |
| `POST /dsh-pet-7340/position?pet=` | **位置控制**（需锁）：挪到归一化坐标，`mode` = 直接/弹簧/直线；不碰动画。额外回**夹取后**的 `x`/`y` |
| `POST /dsh-pet-7340/throw?pet=` | **原生抛掷**（需锁）：给桌宠一个初速度让它飞出去（`angle` 度、`power` 倍率） |

## 五、改配置与重载

| 接口 | 功能 |
| --- | --- |
| `PUT /dsh-pet-7340/config` | 保存用户层配置（白名单重建，用户手写的精调字段会保留） |
| `POST /dsh-pet-7340/config` | 用内置默认整份覆盖用户配置，即「恢复默认」 |
| `POST /dsh-pet-7340/pet-display` | **改单只宠物的显示位置**（`web` / `desktop` / `both` / `none`），只传 `{ id, display }` |
| `POST /dsh-pet-7340/reload` | 重载桌面端（重启桌面宠物进程，按最新配置重建窗口） |

## 六、素材

| 接口 | 功能 |
| --- | --- |
| `GET /dsh-pet-7340/thumb/{petId}/{file}` | 动画素材（`.webm` / `.mov`，按宠物归属） |
| `GET /dsh-pet-7340/font/{file}` | 字体文件 |
| `GET /dsh-pet-7340/pic/{file}` | 通知图标（`pic/`）与表情包（`pic/memes/{素材根}/`，按宠物归属） |

---

## state 详解

`GET /state` 是所有状态位的唯一出口，结构固定：

```jsonc
{
  "counter": 1755000000007,   // 整份 S 的版本号 = 最后一次写入的编号（顶层，不是叶子）
  "sections": {               // 全局段：所有端共享一份
    "balance": {…}, "workStatus": {…}, "notify": {…}, "config": {…}
  },
  "pets": {                   // 每只宠物各自一份；键是宠物 id（可含点号，勿切分）
    "main": { "say": {…}, "anim": {…}, "position": {…}, "throw": {…}, "lock": {…} }
  }
}
```

每个 `{…}` 是一个叶子 `{ counter, data }`：**`counter` 变了就表示它更新了**（唯一判据）。

**长轮询**：`?since=<上次的顶层 counter>&timeout=<ms>`（成对必填，上限 10s）。有字段改变就
**立刻返回**，否则一直挂到 `timeout` 到点；返回体与不带参数时一样。

**前端在每个需要的地方各存一份 `counter`**：首拉只记基线不渲染，之后一样就不渲染、不一样就
渲染并更新——据此判断变了没有、要不要触发。

## 独立模式（不打开 DSH）

不启动 DSH 时，同一份 `/dsh-pet-7340` 契约由本机服务提供，另外多出三个**挂在服务根上**的端点
（**不在 `/dsh-pet-7340` 前缀下**）：

| 接口 | 功能 |
| --- | --- |
| `GET /`、`GET /health` | 服务与插件信息：名称、插件根与版本、监听端口、已运行秒数 |
| `POST /shutdown` | 优雅停机：释放插件注册的 effect（停止桌面助手、清掉周期定时器）后关闭服务，进程退出码 0 |

`/dsh-pet-7340` 下的端点形状不变，但三个依赖 DSH 的接口**明确降级**（结构化失败，不假装成功）：
`POST /whisper`、`POST /chat` 回 `reason: 'provider-missing'`，`POST /balance` 回 `reason: 'unsupported'`。

## 相关

- [`CORDIS.md`](CORDIS.md) —— 对外 Cordis 服务（客户端半侧，页面内 `ctx.get()`，不走网络）
- [`openapi.yaml`](openapi.yaml) —— 完整契约（OpenAPI 3.1，可直接导入 Swagger UI / Postman）
- [`tools/api-tester.html`](tools/api-tester.html) —— 桌宠控制台：扮演第三方消费方的示例页面，
  可直观试用上述接口（用 `node tools/api-tester.cjs` 启动，它会带上本地代理解决跨域）
