# 🎀 桌宠控制面板（pet-panel）

一个本地控制面板，让你在浏览器里管理桌面桌宠：

- **使用/不使用**：开关某只桌宠（`display` = desktop / none）
- **调整大小**：滑块改每只桌宠的 `size`（80–400）
- **聊天**：选中某只桌宠直接对话（走引擎 `/chat`）
- **新增桌宠**：填 id / 名字 / Ollama 模型 / 人设，生成 `pet/<id>-config.json` 并重载
- **表情包/动作**：全局开关 `chatImageEnabled`（聊天配图）、`chatAnimationEnabled`（聊天动画）

## 运行

前提：桌宠 standalone 引擎已在运行（默认监听 `127.0.0.1:3080`，路由前缀 `/dsh-pet-7340/`）。

```bash
node pet-panel-server.js        # 默认端口 3090
node pet-panel-server.js 3100   # 指定端口
```

然后浏览器打开：<http://127.0.0.1:3090/>

## 原理

- `pet-panel-server.js`：本地小服务器，读取 `~/.dsh/dsh-pet/` 下的配置
  （`main-config.jsonc` + `pet/*-config.json`），并把聊天/开关/保存代理到桌宠引擎，
  自动带上 `standalone-runtime.json` 里的 token。
- `pet-panel.html`：纯前端单页（无框架），调面板服务器的 `/api/*`。

## 说明

- 面板只改配置 + 请求引擎重载，不直接改引擎进程，重启引擎/面板都安全。
- 新增宠物会创建 `~/.dsh/dsh-pet/pet/<id>-config.json`；该宠物需在 Ollama 中有对应模型才能聊天。
- 引擎配置结构变更时，面板的 `pet-panel-server.js` 需同步（尤其是 `/dsh-pet-7340` 路由前缀与 token 头名）。
