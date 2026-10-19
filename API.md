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
| `GET /dsh-pet-7340/chat?pet=` | 读某只桌宠最近的对话记忆窗口 |

## 二、让桌宠做事

| 接口 | 功能 |
| --- | --- |
| `POST /dsh-pet-7340/whisper?pet=` | 让桌宠**生成**一句碎碎念（走当前模型） |
| `POST /dsh-pet-7340/broadcast?pet=` | **第三方投喂**：把外部给定的文本写进气泡（不生成，只搬运）；配图（`image` 池内名 / `url` 自带地址）、时长、动画联动可选 |
| `POST /dsh-pet-7340/bubble/clear?pet=` | **清空气泡**：提前收起说话气泡（只动气泡，不动动画） |
| `POST /dsh-pet-7340/anim?pet=` | **点播动画**：播池内名字（同右键「动作」菜单）或第三方自带的 `url`；回 `playbackId` |
| `GET /dsh-pet-7340/playback/{id}` | **播放回执**：查那次点播的真实状态；带 `?wait=&timeout=` 可挂起等待 |
| `POST /dsh-pet-7340/playback/{id}/report` | 渲染端上报播放状态（**内部通道**，第三方不用调） |
| `POST /dsh-pet-7340/chat?pet=` | 对桌宠说一句话并生成回复，同时写入对话记忆 |
| `POST /dsh-pet-7340/position?pet=` | **位置控制**：挪到归一化坐标，`mode` = 直接/弹簧/直线；不碰动画 |
| `POST /dsh-pet-7340/throw?pet=` | **原生抛掷**：给桌宠一个初速度让它飞出去（`angle` 度、`power` 倍率） |
| `POST /dsh-pet-7340/balance` | 立即刷新一次余额 |
| `POST /dsh-pet-7340/reload` | 重载桌面端（重启桌面宠物进程，按最新配置重建窗口） |

## 三、改配置

| 接口 | 功能 |
| --- | --- |
| `PUT /dsh-pet-7340/config` | 保存用户层配置（白名单重建，用户手写的精调字段会保留） |
| `POST /dsh-pet-7340/pet-display` | **改单只宠物的显示位置**（`web` / `desktop` / `both` / `none`），只传 `{ id, display }` |
| `POST /dsh-pet-7340/config` | 用内置默认整份覆盖用户配置，即「恢复默认」 |

## 四、素材

| 接口 | 功能 |
| --- | --- |
| `GET /dsh-pet-7340/thumb/{petId}/{file}` | 动画素材（`.webm` / `.mov`，按宠物归属） |
| `GET /dsh-pet-7340/font/{file}` | 字体文件 |
| `GET /dsh-pet-7340/pic/{file}` | 通知图标（`pic/`）与表情包（`pic/memes/{素材根}/`，按宠物归属） |

---

## 三条要记住的约定

1. **数据只有一个出口**：`GET /state`。它返回宿主内存里的已发布状态，每个状态位是
   `{ counter, data }`。
2. **动作端点不返回数据**：第二节与第三节的 `POST` 只回 `{ ok: true }`；结果写进状态，
   长轮询那一拍会立刻把它送到（调用方不必主动补拉）。
   **两个例外**，都只多回"受理"层面的信息：
   - `POST /anim` 额外带回 `playbackId`——只代表"受理了"，**不等于播完了**；
     真实回执看 `GET /playback/{id}`。
   - `POST /position` 额外带回夹取后的 `x`/`y`（越界会被夹到 `0~1`，回的是实际生效值）。
3. **`counter` 变了才渲染**：它是 `Date.now()` 且严格递增，宿主重启也不会倒退。
   状态位的路径（如 `sections.balance`、`pets.<id>.say`）请当作**不透明键**使用——
   宠物 id 允许含点号，**不要按 `.` 切分**。

## 快速试一下

```bash
BASE=http://127.0.0.1:<port>/dsh-pet-7340

# 拉一次状态（只读、零副作用，可以随便轮询）
curl -s $BASE/state

# 长轮询：带上上一拍拿到的 counter —— 叶子一变立刻返回，最多挂 1 秒
curl -s "$BASE/state?since=1755000000007&timeout=1000"

# 让桌宠说一句外部给的话，然后立刻回读状态
curl -s -X POST "$BASE/broadcast?pet=main" \
     -H 'content-type: application/json' \
     -d '{"text":"巡检完毕，一切正常"}'
curl -s $BASE/state   # → pets.main.say.data.text

# 只弹 3 秒气泡、不播说话动画
curl -s -X POST "$BASE/broadcast?pet=main" \
     -H 'content-type: application/json' \
     -d '{"text":"该喝水了","duration":3000,"anim":false}'

# 配图两种形态二选一：image 给池内名，url 给自己托管的完整地址（不给两个都给）
curl -s -X POST "$BASE/broadcast?pet=main" \
     -H 'content-type: application/json' \
     -d '{"text":"巡检完毕","url":"https://cdn.example.com/拒绝换壁纸.png"}'

# 提前收起气泡（正在播的动画不受影响）
curl -s -X POST "$BASE/bubble/clear?pet=main"

# 让它播一段动画（名字取自 GET /config 里**该宠物所属条目**的 animations：
#  main 条目的宠物用 main 的池，pet/<名>-config.json 的种类各用自己的池）
curl -s -X POST "$BASE/anim?pet=main" \
     -H 'content-type: application/json' \
     -d '{"name":"东张西望"}'

# 或者播自己托管的素材：给 url 就不查动画池（name 与 url 二选一）
curl -s -X POST "$BASE/anim?pet=main" \
     -H 'content-type: application/json' \
     -d '{"url":"https://cdn.example.com/拉侧栏.webm"}'
```

## 独立模式（不打开 DSH）

不启动 DSH 时，同一份 `/dsh-pet-7340` 契约由一个本机 HTTP 服务提供（`src/standalone/server.ts`，
用法见 [`dsh-pet/README.md`](dsh-pet/README.md) 的「🧍 独立运行（完全不打开 DSH）」）：

```bash
BASE=http://127.0.0.1:3080/dsh-pet-7340   # 独立模式默认端口 3080（被占用则顺延）
```

**上表所有端点与约定在这里完全不变** —— 独立模式把插件的宿主半边跑在伪 ctx 上，
路由表仍是 `src/host/index.ts` 那一份（桌面助手照旧走 bridge 管道）。因此本文件与
[`openapi.yaml`](openapi.yaml) 描述的 `/dsh-pet-7340` 契约**不需要为独立模式做任何改动**。

独立模式另外多两个只属于该服务的运维端点（不在 `/dsh-pet-7340` 前缀下，故不在 OpenAPI 契约里）：

| 端点 | 说明 |
| --- | --- |
| `GET /`、`GET /health` | 服务与插件信息：名称、插件根与版本、监听端口、已运行秒数 |
| `POST /shutdown` | 优雅停机：释放插件注册的 effect（停止桌面助手、清掉周期定时器）后关闭服务，进程退出码 0 |

依赖 DSH 的能力在独立模式下**明确降级**（结构化失败，不假装成功）：`POST /whisper`、`POST /chat`
回 `{ ok: false, reason: 'provider-missing' }`（没有模型服务），`POST /balance` 回
`{ ok: false, reason: 'unsupported' }`，`GET /state` 的各状态位保持空闲初始值。

## 相关

- [`openapi.yaml`](openapi.yaml) —— 完整契约（OpenAPI 3.1，可直接导入 Swagger UI / Postman）
- [`tools/api-tester.html`](tools/api-tester.html) —— 桌宠控制台：扮演第三方消费方的示例页面，
  可直观试用上述接口（用 `node tools/api-tester.cjs` 启动，它会带上本地代理解决跨域）
