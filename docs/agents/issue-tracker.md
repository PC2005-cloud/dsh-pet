# Issue tracker: 本地 Markdown

本仓库的 issue 与 spec 都以 markdown 文件保存在 `.scratch/` 下（不依赖 `gh` / `glab`，不联网）。

## 约定

- 一个功能一个目录：`.scratch/<feature-slug>/`
- spec 是 `.scratch/<feature-slug>/spec.md`
- 实施 ticket 一文件一条：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号，**不要**合并成一个 tickets 文件
- 每个 issue 文件顶部附近用 `Status:` 行记录 triage 状态（取值见 `triage-labels.md`）
- 评论与讨论记录追加到文件末尾的 `## Comments` 标题下

## 当技能说「发布到 issue tracker」

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在就创建）。

## 当技能说「取出相关 ticket」

读取引用路径对应的文件。用户通常会直接给出路径或 issue 编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个文件，每个 **child** 是独立的 ticket 文件。

- **Map**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 正文）。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文写问题。`Type:` 行记录类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **阻塞**：文件顶部附近 `Blocked by: NN, NN`。它列出的文件全部 `resolved` 时才算解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/`，找未关闭、未阻塞、未认领的文件，编号小的优先。
- **认领**：开工前先写 `Status: claimed` 并保存。
- **解决**：在 `## Answer` 标题下追加答案，置 `Status: resolved`，再把一条上下文指针（要点 + 链接）追加到 `map.md` 的 Decisions-so-far。
