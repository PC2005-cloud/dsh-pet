# Triage 标签

技能用五个规范化的 triage 角色说话。本文件把角色映射到本仓库实际使用的标签字符串。

| mattpocock/skills 中的角色 | 本仓库的标签        | 含义                             |
| -------------------------- | ------------------- | -------------------------------- |
| `needs-triage`             | `needs-triage`      | 维护者需要评估这条 issue         |
| `needs-info`               | `needs-info`        | 等待报告者补充信息               |
| `ready-for-agent`          | `ready-for-agent`   | 已完整规格化，可交给 AFK agent   |
| `ready-for-human`          | `ready-for-human`   | 需要人类实现                     |
| `wontfix`                  | `wontfix`           | 不处理                           |

当技能提到某个角色（例如「打上 AFK-ready triage 标签」），使用上表对应的标签字符串。

本地 Markdown 追踪下，标签写在 issue 文件的 `Status:` 行里，例如 `Status: ready-for-agent`。

要换词汇表，直接改上表「本仓库的标签」一列。
