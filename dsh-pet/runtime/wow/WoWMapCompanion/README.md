# 魔兽陪伴精灵 · WoW 插件端 2.19.0

通信链路、当前版本、存档边界和排查步骤见 [游戏插件与 AIRI 通信说明](../wow-addon-airi-communication.md)。下方保留各功能的开发记录。

## 2.16.0：只读背包库存

`Inventory.lua` 只读取当前角色随身背包，以物品 ID 合并数量，不读取银行或执行制造、移动、买卖。银行范围固定为 `unknown`。
进入世界、背包变化时采集，静止背包在上次首轮发送完成后每 30 秒更新。任意槽位或容器读取受限时标记 `complete=false`，未返回物品不能当成零。
库存通过独立 `inv` 分片发送，不扩大 504 字节主心跳。当前会话和角色身份、采集时间、完整性随快照保留。
本次仅更新开发源码，未部署到游戏插件目录。新增模块需要完整更新插件并重新启动游戏；已载入模块的后续调试可用 `/reload`。尚待真实游戏验收。


## 2.15.0：组队增益语音提醒

新增进入副本、团队副本、场景战役或战场后的队伍增益检查。支持六种职业增益，使用当前角色语音提醒，详情见文末。

## 2.14.0：地图、副本和战场场景观测

新增可选 `instanceType` 和 `instanceID`，供陪伴精灵在抵达新地点后讲述逸闻。
类型区分野外、地下城、团队副本、战场、竞技场和场景战役。未知或不可公开读取的结果不会猜成野外。
`instanceID` 是副本地图标识，不是本次进本的唯一编号；野外和未知场景传 `null`。

仍使用原有 **64×64 像素**传输码，每秒采样，不增加屏幕面积。
极端长身份或计数占满 504 字节时，场景观测整体省略，保留原身份与金币数据。
详见 [场景协议](../WoWCompanion-PROTOCOL.md#scene-observations-2140)。
更新后在游戏输入 `/reload`，并正常退出、重新启动陪伴精灵以加载桥接 2.14.0。
无限服接口仍需客户端开放后实测。

2.13.0 增加宏导入回执传输。与独立的 `WoWMacroImport` 插件、桥接 2.13.0 和陪伴精灵 2.18.0 配合使用，可在聊天请求后自动粘贴并保存宏。命令为 `/import-marco`，详见相邻 `WoWMacroImport/README.md`。

采集角色状态并通过 WCP1 屏幕遥测供本机桥接模块接入 魔兽陪伴精灵。游戏画面保留数据传输码，合格的新装备会出现逐件确认换装窗口，角色、地图和金币信息在 魔兽陪伴精灵 中查看。
插件本身不调用大模型、不联网、不读取其他进程；仅在用户点击游戏内确认后执行对应换装。

## 已实现

- 2.10.1 默认使用 **64×64 物理像素**紧凑网格，是原 128×128 面积的四分之一。更新后首次加载会把旧网格缩至每格 1 像素，保留位置和开关；之后主动调大的格子尺寸会继续保存。`/wowc compact` 可随时恢复最小布局，画面不增加边框、文字或鼠标拦截。

- 2.10.0 在角色登录、新获取装备以及穿戴变化时读取当前 19 个穿戴槽位，按一份快照传入 魔兽陪伴精灵。包含名称、装等、公开属性和提示文本；空槽、未知资料和截断均明确标记。桥接与 魔兽陪伴精灵 使用 2.11.0。全身快照在后台分片传输，换装比较仍优先。

- 2.9.0 将传输刷新与业务心跳分离，分别为 0.25 秒和 1 秒。普通完整比较与换装提议在集成测试中 8 秒内送达，极长资料和队列会增加等待。桥接使用 2.10.0，采集间隔 100ms，魔兽陪伴精灵 轮询 250ms。
- 装等和当前专精主属性同时提高、且仅副属性下降的普通装备也会询问。提示列明提高和下降，不保证综合收益。真正特效、套装、资料不足以及耐力、护甲、武器伤害下降仍需人工判断。
- `/wowc equip check [物品ID]` 可复查当前背包中的既有装备，例如 `/wowc equip check 257002`。不填写物品 ID 时检查合格候选，最多排入 6 件。此命令不伪造新获取记录。资料未缓存时，等待加载后再次执行。最后仍在游戏中点击“确认换装”。

- 2.8.2 修复旧装备超链接接口中的“拾取后绑定”被当作复杂效果，以及“腕部”槽位文字漏认。实机发现旧装备 `GetHyperlink` 与新装备 `GetBagItem` 的绑定文字不同，现已分开测试。比较规则保持不变：副属性下降仍需人工复核，不以装等上涨替代属性收益判断。更新后 `/reload`，旧记录不会自动补发。

- 2.8.1 修复普通装备被误判为不可用：穿戴判断不再要求 `C_Item.IsUsableItem`，保留可装备、等级、专精、完整资料和游戏内点击重检。精确识别普通中文槽位、护甲、爆击、品质及制造者文字，避免把它们当作特效。真实特效、套装、附魔、插槽和未知文字仍需复核。
- 更新后在游戏输入 `/reload` 即可加载修复；桥接 2.9.0 和 魔兽陪伴精灵 2.9.1 无需重建。此前背包中的装备属于新会话基线，不会自动重播获取或换装询问。之后新获得的明确提升装备才进入提示流程，最终仍需游戏内确认。

- 2.7.0 增加角色阵营与本地化种族采集，写入 `v=3` 快照，供 魔兽陪伴精灵 按真实身份组织对话。阵营来自 `UnitFactionGroup("player")` 首项，种族来自 `UnitRace("player")` 首项；绝不由种族推断阵营。

- 2.6.0 增加当前换装候选传输，配合 魔兽陪伴精灵 的语音或文字气泡与 10 秒选择流程。最终仍在游戏内确认。
- 2.5.0 增加新装备逐件询问换装、槽位与实例核验、结果传输及 魔兽陪伴精灵 结果展示。详见下方“逐件确认换装”。

- 2.4.0 增加新获得装备采集。完整实例链接、名称、类型、装等、公开属性以及附魔、宝石、触发、套装等提示文本通过同一传输码分片发送。详见下方“新获得装备”。
- 2.1.1 移除游戏内的地图、角色和金币文字面板，只显示黑白数据传输码。数据采集和 魔兽陪伴精灵 读取继续运行。
- 采集角色 GUID、名字、服务器、等级、职业英文 token、专精 ID、地图 ID、地图名，以及战斗、死亡、是否进入世界。
- 金币：监听 `PLAYER_MONEY`，读取 `GetMoney()` 的铜币整数，保存当前余额和累计流入/流出。首次读数只建立余额基线，不把原有财富计入收入。
- 本机账号标识保存在账号级 SavedVariables，角色计数以 GUID 分开；重载沿用累计数，不能补回未观察到的交易。
- 监听升级、区域变化、专精、战斗进入/退出、死亡/复活、进入/离开世界事件。
- 升级使用 `PLAYER_LEVEL_UP` 的新等级参数，避免刚升级时 `UnitLevel` 暂时返回旧值。
- 区域事件后在 0.25、1、2、5 秒重试，等待地图数据稳定；新事件会取消旧重试。
- 只有业务状态变化时递增 `seq`；每秒递增 `tick`，使桌面端能识别静止或失效的画面。
- 左上角黑白网格承载完整快照，默认 64×64 物理像素、距游戏客户区左上 8×8 像素；不会拦截鼠标。
- `/wowc compact` 或 `/wowc cell 1` 使用 64×64 物理像素。魔兽陪伴精灵 / 桥接每格像素设为 1；尺寸和偏移按物理像素换算，不随游戏 UI 缩放放大。
- 按 `768 / 屏幕物理高度` 换算 UI 单位，并抵消父级缩放；心跳检查登录后较晚发生的 UI 缩放变化，仅在变化时重新布局。
- 颜色更新后恢复纹理像素吸附，兼容 NDui 等界面插件全局关闭吸附的行为；原生布局取整 API 可用时也会启用。
- CRC16 校验、明确字节长度、UTF-8 边界裁剪；纹理仅在位发生变化时更新。
- 对可能返回的 secret value 先调用 `issecretvalue`，不转换、不比较、不导出。姓名等原有显示字段暂不可用时保留最近公开值；新增阵营/种族在缺失、秘密值或接口错误时立即发送 `null`，不会沿用旧角色身份。地图/专精不可用时使用 0/未知文本，不把它解释成可用游戏情报。
- `SavedVariables` 保存设置和最近一次规范快照，供离线后备读取。

## 安装

退出游戏，把此目录下 **八个 Lua 文件、TOC 文件**放入：

```text
World of Warcraft\_retail_\Interface\AddOns\WoWMapCompanion\
    WoWMapCompanion.toc
    Protocol.lua
    Telemetry.lua
    Money.lua
    Equipment.lua
    Transfer.lua
    ConfirmEquip.lua
    WoWMapCompanion.lua
```

README 可一起复制，`tests` 目录无需安装。已有旧版则用新版文件覆盖，并保留相同插件目录名。
在插件列表启用“魔兽陪伴精灵 / 魔兽陪伴精灵 桥接”。更新到 2.7.0 后执行 `/reload`，并正常退出、重启 魔兽陪伴精灵 2.7.0 配套二开版本；插件、桥接与 魔兽陪伴精灵 必须同步更新以支持 `v=3`。首次安装或从更早版本升级时，完整重启游戏以加载 ConfirmEquip.lua。保留 SavedVariables，无需重新设定网格坐标或大小。

TOC 延用本工作区的正式服接口号 `120105, 120100`。客户端更新或其他分支必须核对实际接口号：
`/dump select(4, GetBuildInfo())`。声明接口号并不代表已在该版本实机测试。

## 游戏内命令

| 命令 | 行为 |
| --- | --- |
| `/wowc` | 查看命令帮助 |
| `/wowc telemetry` | 开启/关闭黑白遥测网格；关闭后桌面端应进入失联状态 |
| `/wowc status` | 显示金币、等级、业务序号、心跳、负载大小、遥测坐标 |
| `/wowc pos 8 8` | 遥测网格相对游戏客户区的左上坐标 |
| `/wowc compact` | 使用最小 64×64 物理像素网格；保留坐标和开关 |
| `/wowc cell 1` | 每个位格的像素尺寸，可用整数 1–6；对应网格 64–384 像素宽高 |
| `/wowc selftest` | 运行 WCP1 / CRC16 / UTF-8 编码自检 |
| `/wowc reset` | 重置遥测显示设置 |

坐标和格子尺寸更改后，应同步修改桌面桥接配置。在窗口模式下，桌面绝对捕获坐标还要加上游戏客户区在桌面上的偏移。建议无边框窗口模式，保持网格不被遮挡。隐藏 UI、最小化、加载画面、屏幕锁定或捕获位置错误都会中断可读画面。

最小网格：默认每格 1 像素，也可在游戏内输入 `/wowc compact`，无需重载即可生效；桥接页的“每格像素”同步设为 `1`。此时网格为 64×64 像素，面积是旧版 128×128 网格的四分之一。若显示链路使单像素模糊，可恢复 `/wowc cell 2`，桥接也改回 `2`。首次更新旧版缩放逻辑后需 `/reload`，再校准坐标；主屏无边框、插件位置 `(8,8)` 时桥接也设 `(8,8)`。

**网格有灰色/背景色边缘、CRC 校验失败时：**先确认两端每格大小一致、采集区域无遮挡。若仍失败，在游戏“系统 → 图形”中切到窗口模式并应用，再切回“全屏（窗口化）”，使用显示器原生分辨率并应用；然后输入 `/reload` 重建布局，再运行 `/wowc status`、校准桥接坐标并刷新预览。游戏报告的分辨率与 Windows 实际游戏客户区不一致时，整幅画面可能被再次拉伸，插件内部坐标正确也无法逐像素解码。本机曾出现游戏报告 2560×1440、实际客户区 2576×1460 的情况；重新应用显示模式并重载后，客户区恢复一致，64×64 网格成功实时解码。此时不要仅通过反复调解码阈值或盲目放大网格排错。

插件是单向发送器，`/wowc status` 仅描述插件本地状态，不能确认 魔兽陪伴精灵 是否已连接。

## WCP1 协议

64 列 × 64 行，共 4096 个黑白位：黑色 = 0，白色 = 1，行优先，每字节最高位优先。

| 字节偏移（从 0 起） | 内容 |
| --- | --- |
| 0–3 | ASCII `WCP1` |
| 4–5 | UTF-8 JSON 字节数，uint16 小端 |
| 6–7 | 负载 CRC16-CCITT，初始值 0xFFFF，多项式 0x1021，小端 |
| 8–511 | JSON 负载（最多 504 字节），剩余字节补零 |

```json
{"v":3,"session":"1700000000-12500-123456","seq":2,"tick":5,"guid":"Player-1-00000001","name":"冒险者","realm":"服务器","level":30,"class":"MAGE","faction":"Alliance","race":"人类","spec":64,"map":84,"zone":"暴风城","combat":false,"dead":false,"online":true,"account":"local-example","moneyEpoch":"segment-example","copper":12345,"earned":1000,"spent":250}
```

每次登录/重载生成新的 `session`。`seq` 描述该会话内业务变化；`tick` 每秒递增。
桌面端应先验证版本、长度、CRC，再读取 JSON；初次读取或会话改变应建立基线，不应误报升级。
`PLAYER_LEAVING_WORLD` 设置 `online=false`，它也可能是加载/传送过程，并不等价于永久退出游戏。
网格仍为 64×64 位，WCP1 帧头不变。JSON 版本升级为 3，插件、桥接和 魔兽陪伴精灵 必须一起更新。

`faction` 和 `race` 是必填 JSON 字段，但允许 `null`。阵营仅接受 `Alliance`、`Horde`、`Neutral`，中立不等于未知；种族为非空、本地化的完整名称，去除颜色标记和 C0/C1 控制字符，最多 48 个 UTF-8 字节。暂不可用或超长时设为 `null`，不发送半截种族名。登录、原有状态采样和 `NEUTRAL_FACTION_SELECT_RESULT` 后更新；阵营选择事件后同样在 0.25、1、2、5 秒重采，等待 API 完成更新。

仍使用 504 字节固定负载。超长时依次缩短地图名、服务器名、角色名；若仍超限，才将完整 `race` 置 `null`。阵营、职业、GUID、会话及金币标识和精确计数不会为凑帧而改写。若这些字段本身组成的极端组合仍超限，编码明确失败，旧画面和旧心跳不更新，桌面会按原有超时逻辑识别失联；不会伪装成新状态。真实生成标识长度下的最大计数，以及无法容纳的极端组合均有测试。

网格传递最新状态快照，不是可靠事件队列；捕获停止期间短暂发生又结束的状态可能无法重放。金币使用累计计数，能补上插件持续观察期间尚未被桌面读取的收支，但不保存逐笔时间或原因。

## SavedVariables 后备

声明全局变量 `WoWMapCompanionDB`，游戏写入账号目录下的 `SavedVariables\WoWMapCompanion.lua`。

- `money`：本机账号标识，以及按角色 GUID 保存的计数段、累计流入和流出铜币数。
- `settings`：遥测开关、x/y/cell。旧版 `panel` 设置在初始化时移除。
- `snapshot`：最后一份经过裁剪的安全快照表。
- `snapshotJSON`：与屏幕负载完全相同的 JSON 字符串。
- `updatedAt`：最后导出时的服务器 Unix 秒。

**内存变量更新不等于文件立即写入。** WoW 在退出/重载等时机保存；后备文件只可作为当时的快照，不应显示为实时连接。外部程序应解析数据，不能执行 SavedVariables 文件中的 Lua。

## 验证与实机验收

自动化测试执行真实 Lua 5.1 模块，使用最小 WoW API mock；没有模拟受保护的真实客户端运行时。

```powershell
python -m pip install --target tests/.deps lupa
python -m unittest discover -s tests -v
```

当前共 94 项真实 Lua 5.1 测试通过。其中新增 7 项覆盖三种阵营与中文种族、选择阵营延迟更新、秘密/缺失/错误值清空、角色切换、UTF-8 全名和控制字符、超限整项降级，以及编码失败不更新画面或心跳。原有回归覆盖：Lua/Python CRC 与位序一致、UTF-8 边界和长度、升级参数优先、心跳不生成业务事件、战斗/死亡/区域/上下线、secret 值过滤、命令参数与遥测开关，金币初始基线、快速收支、重载与角色切换、不可用值和计数溢出，以及物理像素换算、晚期 UI 缩放修复和 NDui 颜色纹理钩子的吸附恢复。

此前 2.0 版的网格实测：重新应用显示模式并 `/reload` 后，`/wowc cell 1` 的 64×64 物理像素网格已成功实时读取。以 500ms 间隔连续采样 20 次，20/20 均为 `live`、0 个错误，心跳从 41 递增至 50；BMP 实测为 64×64，标准 CRC 解码得到真实等级 90、区域“银月城”。此次保存的桌面采集设置为 `x=8、y=32、cellSize=1`；这是当前布局的校准结果，不是所有电脑的通用坐标。这验证了真实画面采集与状态读取；真实升级、死亡和 AI 语音回应仍需分别验收。

游戏内还需验收：

1. 登录后只出现数据传输码，不再出现地图、角色和金币文字面板；`/wowc selftest` 通过，桌面端收到姓名、等级、阵营与种族。分别用联盟/部落角色检查；若有尚未选择阵营的角色，检查中立与选择后的更新。
2. 升级后桌面端仅报告一次新等级；不需要 `/reload`。
3. 跨区域、进入副本、打开世界地图浏览其他区域，桌面端始终使用角色所在地图。
4. 战斗进入/退出、死亡与复活后状态正常且无 Lua 错误。
5. `/reload` 后新会话不会被误认为升级；隐藏网格或最小化游戏时桌面端及时显示失联。
6. 不同 UI 缩放、Windows 缩放、HDR/显示器布局下实际校准捕获位置。

## 魔兽陪伴精灵 金币汇总

打开 魔兽陪伴精灵 的“设置 → 魔兽陪伴精灵”，查看金币汇总。首次读取有效累计数后建立账号与角色记录。
同账号各角色合并显示流入、流出、净变化与已知余额；可给账号添加备注。金额显示为金、银、铜。

- 首次持有余额不计为收入；累计统计从插件开始观察起，不查询历史交易。
- 已知余额是各角色最近读数的合计。先逐个登录需要统计的角色，不会自动查询未登录角色。
- 统计对象是角色钱包。邮件、交易和银行存取会改变流入/流出；战团及公会银行自身余额不计入。
- 同账号转账会在不同角色分别体现收入、支出，不等于纯经济利润。
- 不读取战网账户信息。删除 SavedVariables 会产生新标识；跨账号复制该文件也会复制标识。
- 插件未运行、值不可用和游戏崩溃前未保存的变化无法完整追回。恢复旧 SavedVariables 导致同段计数回退时，魔兽陪伴精灵 会拒绝该角色回退记录，直到收入和支出均追上桌面记录。
- 备份时先正常退出游戏与 魔兽陪伴精灵，再保留插件 SavedVariables 和 魔兽陪伴精灵 用户数据根目录的 `wow-companion-gold-v1.json`。

## API 参考

- [暴雪 UI 源码镜像：Unit 接口](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/UnitDocumentation.lua)
- [暴雪 UI 源码镜像：地图接口](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/MapDocumentation.lua)
- [暴雪 UI 源码镜像：专精接口](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/SpecializationInfoDocumentation.lua)
- [暴雪 UI 源码镜像：受限操作及 InCombatLockdown](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/RestrictedActionsDocumentation.lua)

- [暴雪 UI 源码镜像：PLAYER_MONEY 与 GetMoney 使用](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_AuctionHouseUI/Shared/Blizzard_AuctionHouseFrame.lua)


## 新获得装备

`Equipment.lua` 监听 `BAG_UPDATE_DELAYED`、`PLAYER_EQUIPMENT_CHANGED` 和 `ITEM_PUSH`，合并短时间通知后扫描随身背包及穿戴栏。进入世界后前 2 秒只建立基线，原有装备不作为新获得广播。以物品 GUID 去重，整理背包、穿脱同一件装备、重复事件不会重复广播。同 ID 的不同实例分别识别。

“新增”指本次登录/重载后首次观察到进入随身物品的装备，可能来自掉落、任务、邮件、交易、购买或银行取出。不能据此断言它来自某个首领。没有 GUID 时，按完整链接的历史最大持有数量保守识别，可能漏掉卖出后再获得的同链接装备。初始 2 秒内获得、在两次扫描之间获得又移走、直接进穿戴栏且未被背包扫描观察到的装备也可能漏报。

采集方式：

- `C_Item.GetItemInfoInstant` 确认装备类型。`C_Item.GetItemInfo` 读取名称、品质、类型、子类型、装备位置和等级要求。
- `C_Item.GetDetailedItemLevelInfo` 读取当前实例装等。`C_Item.GetItemStats` 返回属性 token 与数值，包含客户端公开的主属性和次属性。
- 始终保留实际完整 `itemLink`，包括链接中编码的随机属性、附魔、宝石及 bonus 信息。不会用裸 itemID 替换实例链接。
- `C_TooltipInfo.GetBagItem` 读取当前背包位置的说明。位置移动后按原 GUID 或完整链接读取，避免读到新占该位置的另一件物品。
- 保留说明中的附魔、插槽奖励、使用/装备触发、特殊词条、套装名称及套装效果原文。效果以客户端公开说明为准，不推算隐藏触发率、伤害提升百分比或套装已激活状态。
- 资料未缓存时请求加载，等待 `GET_ITEM_INFO_RECEIVED` / `ITEM_DATA_LOAD_RESULT`，最多重试 4 次（间隔 0.5、1、2、4 秒）。最终仍缺失则发送已有部分，并分别标记基本信息、属性及说明是否完整。无法确认装备类型时跳过。
- secret 值及不可访问表不做比较、转换或解密。没有公开数据时发送未知/不完整，绝不填零假装已知。

范围限制：最多 32 个数值属性、48 行说明，每行 256 UTF-8 字节，普通文字 128 字节。超过限制或整个 JSON 超过 8192 字节时裁掉尾部说明/属性，并设置 `truncated=true` 和对应完整性标志。完整实例链接超过 1024 字节时整件跳过，不破坏链接。异步等待上限为 64 件，状态命令会报告等待数及跳过数。

## 装备分片传输

`Transfer.lua` 在原有 512 字节帧内发送 `kind=eq` 包。每片格式为 `{"v":1,"kind":"eq","s":"会话","g":"角色GUID","id":1,"p":1,"n":4,"d":"Base64数据"}`。最多 35 片，每个非末片解码后恰好 240 字节。UTF-8 文本可以跨片拆分；桌面端先拼接全部字节，再严格解码 JSON。每片使用原有帧头和 CRC16。

状态和装备片每秒交替，保持同一片完整显示 1 秒，业务变化不打断这段显示。有装备时角色状态每 2 秒发送一次；无装备时仍保留原有每秒心跳。默认 500 毫秒采集能覆盖正常显示，但遮挡、缩放、慢采集或游戏卡顿仍可能造成缺片。装备越长、队列越长，完整读取时间越久，通常为数秒到数十秒，极长多件连续获得可能需要数分钟。

最多缓存 6 件、每件保留 10 分钟，先发送尚未完成首轮的新记录，再循环重播缓存。队列溢出会移除最旧记录，状态命令报告跳过数。登录/重载会清空装备缓存，不写入 SavedVariables。该通道是单向、有限缓存的尽力传输，没有桌面 ACK，不能保证离线期间全部装备都能补回。

更新后请手动验收：

1. 完整重启游戏和 魔兽陪伴精灵，进入对应版本页面，保持数据传输码无遮挡。原有坐标和大小设置保留。
2. 等角色与地图正常出现后，再通过拾取、购买或任务奖励获得一件装备。
3. 在 魔兽陪伴精灵 的装备区域核对名称、类型、装等、属性值和提示原文。带附魔、宝石、套装的物品逐项对照游戏提示。
4. 整理背包并穿脱该物品，确认没有重复新增。连续获得同 ID 的不同实例时检查分别显示。
5. 缺失字段或不完整标志出现时保留截图、链接及 `/dump GetBuildInfo()` 输出。无限服尚未实机验收，以上 API 以开放后的客户端结果为准。

真实 Lua 5.1 测试增加 17 项：登录基线、受限背包数据不建立空基线、移动/穿脱去重、同实例链接、缓存异步加载、有限重试、部分信息、secret 值、非装备过滤、无 GUID 保守计数、位置替换、UTF-8/CRC/Base64 分片、说明及基本文字截断、长链接跳过、等待上限、缓存过期和实际主入口事件到网格像素集成。`tests/fixtures/lua-equipment.json` 及四个 `lua-equipment-*.bin` 由真实 Lua 采集和编码生成，供桌面桥接跨语言联测。

API 核对依据（暴雪 UI 的 generated API 文档镜像）：

- [C_Item：物品详情、属性、装等、缓存加载](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/ItemDocumentation.lua)
- [C_Container：背包扫描与 BAG_UPDATE_DELAYED](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/ContainerDocumentation.lua)
- [C_TooltipInfo：背包、GUID 与实例链接说明](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/TooltipInfoDocumentation.lua)
- [Forever 的 C_Item](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/ItemDocumentation.lua) 和 [C_TooltipInfo](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/TooltipInfoDocumentation.lua)


## 逐件确认换装

默认开启，命令 `/wowc equip on`、`/wowc equip off`、`/wowc equip status` 可开启、关闭或查看状态。只处理本次登录基线之后新进入背包的装备，不会扫描旧背包并批量换装。关闭后再开启只处理之后新观察到的装备。

新物品必须有公开 GUID、完整实例链接、名称、装等、要求等级、属性和提示资料，并由客户端报告可装备、可使用。只有装等严格高于目标槽，或目标槽为空时，才询问用户。这只是装等候选，不是 DPS 推荐；套装、饰品特效、附魔、宝石和属性组合没有计入收益。

1. 在非战斗且存活时，游戏弹出对话框，显示新旧装备名、装等和目标槽。
2. 核对背包和穿戴栏物品提示后，点击“确认换装”。点击“保留原装备”、按 Esc 或候选的剩余有效期内未选择（总计最多 120 秒），都不会换装，同一件不会反复询问。
3. 点击时再次核验角色、会话、候选 GUID 和完整实例链接，重新查找其真实背包格，并检查目标槽身份、锁定状态、光标、战斗和死亡状态。
4. 本次点击内通过 `C_Container.PickupContainerItem` 拾起准确实例，核验客户端允许该槽后调用 `PickupInventoryItem`。不会按装备名称查找，也不会模拟键鼠。
5. 原生绑定、失去退款资格、失去交易资格等确认仍需要你手动选择。插件不会替你确认这些弹窗，也不会绕过客户端限制。
6. 仅在目标槽的物品 GUID 已等于候选 GUID 时，才记录“已穿戴”。最多等待 45 秒；未确认时提示检查穿戴栏，不再次执行。若之后才完成原生确认，历史结果仍可能显示“未能确认”，以游戏穿戴栏为准。
7. 同一次点击内立即成功、光标上仍是已批准替换的旧装备、来源袋格仍为空时，插件将旧装备放回该格。任何身份不明、来源格被占用或异步完成的情况，都保留光标物品并提示你手工放回；不会清除或丢弃光标物品。

战斗或死亡会隐藏尚未点击的询问，恢复后重新询问，绝不沿用以前的点击自动重试。正在等待原生确认时进入战斗、死亡、离开世界或关闭功能，会结束本次请求；已显示的原生确认仍由游戏管理。询问队列最多 6 件，入队 120 秒到期；退出或重载不保留队列。

普通盔甲、披风、项链可逐件处理。戒指和饰品选择空槽或较低装等槽，但不计算套装、唯一装备分类和特效收益，最终仍由客户端检查装备限制。单手武器区分主手和客户端允许的双持副手；不会替换盾牌来推断双持方案。双手仅处理副手为空且不跨单/双手布局的情况，跨布局、多槽拆装及泰坦之握不推断。远程武器通过 `C_PaperDollInfo.IsRangedSlotShown` 和 `GetInventorySlotInfo("RangedSlot")` 判断是否使用独立 18 号槽；不能确认时跳过。衬衣、战袍、箭袋等不按装等推荐。

换装结果通过同一网格的 `kind:"swap"` 单帧发送，包含装备记录 ID、新旧物品 ID、槽位、结果、原因及时间。最多缓存 10 条结果，重播 10 分钟；尚未首播的新结果优先于旧结果重播。没有候选提示帧时，单条新结果通常在 8 秒内获得发送时隙；同时传送候选提示时约为 12 秒，多条新增则依次排队。正常状态仍每 2 秒至少一帧。候选提示每 3 个数据机会占一个，其余数据机会每 4 个最多一个换装结果。最大 35 片的单件装备单独传送约需 70 秒，加上换装结果约 94 秒，同时传送候选提示和结果时不超过约 140 秒（不含排队、丢帧与重传）。网格面积保持不变。魔兽陪伴精灵 只展示和解释结果，聊天中的“同意”不构成游戏内确认。

### 换装实机验收

完整退出并重启游戏与 魔兽陪伴精灵，以加载新增 `ConfirmEquip.lua`。先用不重要的、可用且装等较高的新装备验收：确认询问的新旧名称和槽位正确；先取消一次确认穿戴不变，再用另一件装备点击确认；遇到原生绑定等弹窗自行决定；核对实际穿戴栏及 魔兽陪伴精灵 的换装结果。另测试战斗中获得装备会延后询问、关闭功能不再弹窗。没有合格的新装备时不应弹窗。自动化测试不能替代客户端受保护 API、职业限制和原生弹窗的实机验收。

本次新增 35 项真实 Lua 5.1 测试覆盖真实 OnAccept 到动作 API、准确实例与背包移动、旧槽变更、光标、锁定、死亡、战斗、身份变化、秘密值、取消/超时、原生确认、双击和重入、世界切换、队列上限、武器槽位、旧装备归还边界、完整 35 片混合调度，以及主入口到像素结果。`tests/fixtures/lua-swap.json` 与 `lua-swap.bin` 来自各版本真实 Lua 回调和编码器，供 Python 跨语言校验。

当前动作接口依据：[官方界面装备管理代码](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_FrameXML/Mainline/EquipmentManager.lua)、[无限客户端槽位接口](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/PaperDollInfoDocumentation.lua)。


## 魔兽陪伴精灵 装备升级提示（2.6.0）

游戏弹窗可确认时，通过 `kind=offer` 单帧发送当前候选及其有效期。它包含会话、角色、装备记录 ID、递增状态序号、名称、槽位和新旧装等。候选完成或失效时改发 closed。

魔兽陪伴精灵 朗读固定提示并显示气泡。没有语音配置、静音或失败时只显示文字。播报结束后显示“好”“不用”，10 秒未选择自动关闭桌面气泡。选择“好”仅提示返回游戏点击确认；选择“不用”不关闭游戏弹窗。只有游戏内确认按钮执行换装，候选总有效期仍为 120 秒。

此功能按装等或空槽筛选，不推断套装、特效及属性组合收益。新提议占部分数据时隙，网格面积保持不变。

## 阵营与种族接口核对

已核对[暴雪正式服 UnitDocumentation 源码镜像](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/UnitDocumentation.lua)中的 `UnitFactionGroup`、`UnitRace` 返回顺序及 `NEUTRAL_FACTION_SELECT_RESULT` 事件。自动化测试不能替代当前客户端的实机验收。

## 自动比较后询问换装（魔兽陪伴精灵 二开 2.9.0）

本版新增 `EquipmentCompare.lua`。需要同时更新 魔兽陪伴精灵 和桥接至 2.9.0 配套二开版，快照仍为 v3，网格尺寸不变。正式服执行 `/reload` 加载新版；无限服安装后重启客户端。

每次获取新装备时，插件读取当前专精、首选主属性、物品适用专精、可用状态，以及新装备和目标槽旧装备的公开属性。通过独立 `kind=cmp` 分片将这次对比的两件物品事实交给 魔兽陪伴精灵。当前装备信息只针对这次候选对应的槽位，不表示完整全身穿戴列表。旧的获取记录不会被伪造为当前穿戴。

插件和 魔兽陪伴精灵 使用相同的保守规则：

- 同类、同槽、适合当前专精、资料完整；量化属性没有下降，且至少一项上升，物品等级不低于旧件，才判定明确提升。同装等也能因真实属性提升而被识别。
- 可使用的空槽物品可以成为提升候选。
- 不适合专精、不可使用或全部属性更弱时，不询问换装。惩戒圣骑士不会因单手武器装等更高而建议替换双手武器。
- 套装、饰品、特效、附魔、插槽、未知词条、属性有升有降、换武器类型或资料不完整时，标记需要人工复核，不作自动收益结论。不使用任意属性权重，也不把面板武器 DPS 当作角色输出提升。
- 仅使用当前专精对应的力量、敏捷或智力。其余两项主属性不影响比较。支持耐力、暴击、急速、精通、全能、武器每秒伤害、护甲等明确量化字段；未知字段必须复核。

只有明确提升才进入原有游戏确认队列。魔兽陪伴精灵 独立核对同一份比较事实及当前提议，再显示语音/文字气泡与“好”“不用”。选择“好”仍需回游戏点击“确认换装”。真正执行前，插件重新核对当前专精、装备身份、属性判断、战斗、死亡、锁定和鼠标状态。绑定或退款等原生确认仍由玩家处理。没有新后台输入或桌面直接操控游戏接口。

`cmp` 的 JSON 上限为 4096 字节，每片 240 字节，最多 18 片，每帧仍为 512 字节。不会裁剪比较属性来制造提升证据；无法完整编码时不发出对应换装提议。比较事实不可用、秘密值或不支持的语言提示会保守降级。

比较新记录优先于普通获取详情发送。正常状态/比较或装备数据仍逐秒交替；提议与换装结果保留各自时隙。18 片最大比较在有提议及结果流量时可在 72 秒内发送完成，不含之前其他比较的排队时间。随后最大 35 片普通获取详情仍在其自身 180 秒接收期限内完成。若新比较到来时旧获取详情已经部分发送，源端明确丢弃该旧在途记录并增加 dropped 计数，避免使其超过接收期限。缓存和持续连发不保证每件都能询问；候选仍在原始 120 秒后过期，不会超时后补做换装。

API 依据：[正式服物品接口](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/ItemDocumentation.lua)、[正式服专精接口](https://github.com/Gethe/wow-ui-source/blob/live/Interface/AddOns/Blizzard_APIDocumentationGenerated/SpecializationInfoDocumentation.lua)、[无限服物品接口](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/ItemDocumentation.lua)、[无限服专精接口](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/SpecializationInfoDocumentation.lua)。两服 `GetSpecializationInfo` 第六个返回值是首选主属性，`GetItemSpecInfo` 返回物品适用专精表。返回未知时不推断。


## Languages / 多语言

Version 2.11.0 uses the game client locale for addon messages and equipment confirmation. English, Simplified/Traditional Chinese, Spanish, French, Italian, Portuguese, Japanese, Korean, and Russian display strings are included. Unknown locales fall back to English. Game observations, slash commands, and telemetry keys remain unchanged. Fully restart the game after updating to load Localization.lua. The desktop language is selected separately in Settings → System → General → Language.


## Current map coordinates (2.12.0)

The addon samples public player map coordinates every second. Snapshot fields px and py store map fractions multiplied by 10000.
For example, px=1234 and py=5678 represent map coordinates 12.34 and 56.78 on the reported map.
Unavailable, restricted, offline, and invalid-map reads clear both coordinates. The addon never reuses a previous position.
Movement updates do not create companion voice events. The grid remains 64 by 64 pixels at the default cell size.
After updating these existing Lua files, use /reload in the game. No additional Lua module is required.

## 日历首次登录提醒

读取官方节日、奖励周及 PvP 日历活动，在服务器日期当天首次登录时合并提示：今天开始的活动、明天结束的活动。提醒包含日历中的具体时间；当天稍晚开始的活动会说“今天几点开始”。持续在线时不另设整点闹钟，同一天重登、重载或换角色不重复提交。需要新版陪伴精灵和桥接，模型支持正常聊天即可。日历尚未加载时等待，不将缺失数据当成没有活动。

更新后重启游戏和陪伴精灵。战斗、静音或其他对话忙碌会延后提醒；提醒提交失败不自动重试。本次尚未完成真实游戏日历与语音播放验收。

### 私人日程与副本重置

私人、公会、社区日程也纳入首次登录摘要，已拒绝或退出的邀请除外。私人日程开始当天提示；有明确结束时间的日程在结束前一天提示。角色副本锁定按游戏日历的实际时间，在重置前一天和重置当天提醒，包含副本难度，不推测未读取的重置计划。

私人日程和副本重置按角色去重；官方活动仍跨角色去重。更新后需要重启游戏和陪伴精灵。

## 组队增益语音提醒

组队进入地下城、团队副本、场景战役或战场后，检测当前角色已学会的队伍增益。支持战斗怒吼、奥术智慧、真言术：韧、野性印记、天怒、青铜龙的祝福。等待加载并连续确认缺失后，通过传输码通知陪伴精灵，使用当前陪伴角色的语音提醒一次。

离线、死亡、不可见、超出可检查距离、受限或读取失败的队友不计为缺少增益。战斗中、静音或语音忙碌时延后；补齐增益、离开副本或切换角色后取消旧提醒。需要启用陪伴连接并配置当前角色的语音。不会自动施法。

要求客户端提供 C_SpellBook.IsSpellKnown 和 C_UnitAuras.GetAuraDataByIndex。缺少这些接口的自定义客户端保持静默。当前版本需游戏内 `/reload`，并重启陪伴精灵以加载新的桥接与语音逻辑。

## 插件独立离线记录

无需开启陪伴精灵：插件会持续更新内存中的多角色档案，记录最近装备、金币变动和升级过程。`/reload`、登出或正常退出时，由游戏把 `snapshotJSON` 与档案写入 SavedVariables 的插件 Lua 文件。`snapshotJSON.offlineHistory` 是离线历史，传输码仍只发送实时快照。

下一次打开陪伴精灵后，会根据“游戏快捷启动”中配置的该版本游戏路径，读取账号 SavedVariables，并将离线历史补存到用户目录的对应 `wow-companion-*-addon-history-v1.json` 和汇总档案的 `addonHistory` 字段。不会把离线记录伪装成当前在线状态，也不会重复累加到原有桌面金币总额。

金币记录是插件观察到的每次余额变动，含观察时间和变动后余额，无法确认交易用途。升级耗时是插件运行期间观察到的在线秒数，首段标为 partial，缺失段标为 unknown，不等同于 `/played`。记录在本次更新后开始，不能恢复此前未记录的历史。异常断电或游戏崩溃可能来不及落盘；正常 `/reload`、登出和退出会触发保存。
