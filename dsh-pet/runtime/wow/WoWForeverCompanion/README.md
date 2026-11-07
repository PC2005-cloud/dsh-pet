# 魔兽无限陪伴精灵 · 独立插件 1.17.0

通信链路、当前版本、存档边界和排查步骤见 [游戏插件与 AIRI 通信说明](../wow-addon-airi-communication.md)。下方保留各功能的开发记录。

## 1.14.0：只读背包库存

`Inventory.lua` 只读取当前角色随身背包，以物品 ID 合并数量，不读取银行或执行制造、移动、买卖。银行范围固定为 `unknown`。
进入世界、背包变化时采集，静止背包在上次首轮发送完成后每 30 秒更新。任意槽位或容器读取受限时标记 `complete=false`，未返回物品不能当成零。
库存通过独立 `inv` 分片发送，不扩大 504 字节主心跳。当前会话和角色身份、采集时间、完整性随快照保留。
本次仅更新开发源码，未部署到游戏插件目录。新增模块需要完整更新插件并重新启动游戏；已载入模块的后续调试可用 `/reload`。尚待真实游戏验收。


## 1.13.0：进入高等级区域提醒

切换地图后，角色等级低于该地图探索等级下限，且客户端确认处于争夺中、敌方或战斗区域时，屏幕与聊天栏提示：

“这里对现在的你而言太早了，前面的区域，以后再来探索吧”

本方领地、圣域、未知领地、等级资料缺失、死亡及副本内跳过。阵营读取角色真实阵营，不按种族推断。
登录建立位置基线。进入新地图后等待至少 0.25 秒，让地图与领地状态同步，最多重试 5 秒。每次进入只提醒一次。
同地图的室内与子区域变化不重复提醒，离开后重新进入可再次提醒。

等级表来源：[无限图鉴 wuxianwow.com 地图集](https://wuxianwow.com/atlas)，2026-10-30 查询。
采用地图探索等级下限，不采用任务等级、怪物等级或临时 QuestieDB 数据。
44 张区域地图中 42 张有等级资料。缺资料的海加尔山、辛德拉不猜测。
15 级兽人进入希尔斯布莱德丘陵（20–31 级）的争夺区域会提醒。塔伦米尔为部落据点，客户端返回本方领地时豁免。
聊天栏附地图等级与来源网页。游戏内无需联网，维护时运行 `python tools/update_exploration_levels.py` 刷新等级表。

从当前仓库复制完整的 `WoWForeverCompanion` 源码文件夹更新插件后，完整退出并重新启动游戏，以加载新增 Lua 模块。旧版本 ZIP 已从当前分支清理。
本功能为游戏内文字提醒，仍需在无限客户端实机验证区域事件和领地 API。

## 1.12.0：组队增益语音提醒

新增进入副本、团队副本、场景战役或战场后的队伍增益检查。支持六种职业增益，使用当前角色语音提醒，详情见文末。

## 1.11.0：地图、副本和战场场景观测

新增可选 `instanceType` 和 `instanceID`，供陪伴精灵在抵达新地点后讲述逸闻。
类型区分野外、地下城、团队副本、战场、竞技场和场景战役。未知或不可公开读取的结果不会猜成野外。
`instanceID` 是副本地图标识，不是本次进本的唯一编号；野外和未知场景传 `null`。

仍使用原有 **64×64 像素**传输码，每秒采样，不增加屏幕面积。
极端长身份或计数占满 504 字节时，场景观测整体省略，保留原身份与金币数据。
详见 [场景协议](../WoWCompanion-PROTOCOL.md#scene-observations-2140)。
更新后在游戏输入 `/reload`，并正常退出、重新启动陪伴精灵以加载桥接 2.14.0。
无限服接口仍需客户端开放后实测。

这是为《魔兽世界：无限》准备的独立插件，供 魔兽陪伴精灵 的“魔兽世界：无限”设置页读取。保留角色、地图、升级、死亡、金币采集，游戏内保留左上角黑白数据传输码，没有中央状态面板；合格的新装备会出现逐件确认换装窗口。

**当前没有用户的无限客户端，尚未完成实机验收。** 2026-10-24 的开发基线为公开的 Forever UI 源码分支、客户端版本 `1.60.x`、接口号 `16001`。未来下载的客户端可能改变接口和加载方式，安装后必须按下面步骤核对。此目录不需要正式服插件一起安装。

## 功能与隔离

- 1.7.1 首次加载迁移为每格 1 像素的 **64×64 物理像素**紧凑网格，保留位置与显示开关；之后主动调整的格子尺寸不会在重载时被覆盖。`/wowf compact` 可随时恢复最小布局，仍保留旧 `cell 1–6` 命令。

- 1.7.0 同步正式服的当前全身装备快照，在登录、新获取装备和穿戴变化时读取 19 槽公开信息。空槽、未知和截断分别标记，桥接与 魔兽陪伴精灵 使用 2.11.0。无限客户端仍待实机验收。

- 1.6.0 同步正式服的主属性提升、副属性取舍询问，提示明确列出提高和下降。保留游戏内确认，以及复杂装备和核心属性下降的人工判断。传输每 0.25 秒刷新，业务每秒采样，搭配桥接 2.10.0 的 100ms 采集和 魔兽陪伴精灵 的 250ms 轮询。
- `/wowf equip check [物品ID]` 复查当前背包中的完整候选，不伪造新获取记录。资料未缓存时，等待加载后再次执行。无限客户端尚待实机验收。

- 1.5.2 同步正式服实机发现的普通“拾取后绑定”与“腕部”漏识别修复，分离背包与超链接提示测试路径。属性取舍、真正特效及游戏内确认规则保持不变，当前仍待无限客户端实机验证。

- 1.5.1 同步修复装备“可使用”与“可穿戴”混用，以及普通中文槽位、护甲、爆击、品质和制造者文字误判复杂效果的问题。仍保留等级、专精、完整资料、真实复杂效果和游戏内点击检查；无限客户端尚待实机验收。更新后 `/reload`，旧背包装备不会补发成新获取记录。

- 1.4.0 增加角色真实阵营与本地化种族，进入 `v=3` 快照供 魔兽陪伴精灵 对话使用。分别读取 `UnitFactionGroup("player")` 和 `UnitRace("player")` 的首项，不由种族推断阵营。

- 1.1.0 增加新获得装备采集：完整实例链接、名称、类型、装等、公开属性及附魔、触发、套装等提示文本。用原有网格轮播分片，不增加屏幕面积。详情见“新获得装备”。
- 角色 GUID、姓名、服务器、等级、职业、公开可读的专精 ID；专精尚未开放或接口不可用时发送 `0`，不推测天赋。
- 使用现代 `C_Map` 读取角色所在地图；区域变更后延迟重试。地图暂不可用时显示可读的区域名称。
- 监听升级、战斗、死亡、复活、进入与离开世界；每秒心跳。升级优先使用事件的新等级参数。
- 监听 `PLAYER_MONEY`，记录角色钱包铜币余额、累计流入和流出。首次读数只建立基线，重载沿用已保存累计数。
- 默认网格为 **64×64 物理像素**，位于游戏客户区左上 `(8,8)`。可调整格子为 1–6 像素。抵消 UI 缩放，在心跳时修复晚期缩放变化，并恢复 NDui 颜色钩子可能关闭的纹理像素吸附。
- 独立插件名 `WoWForeverCompanion`、独立全局设置 `WoWForeverCompanionDB`、独立命令 `/wowf`、独立帧名 `WoWForeverCompanionTelemetry`，不改正式服插件数据。
- 无限服帧标识为 **`WCF1`**；正式服为 `WCP1`。桥接必须按所选版本校验，选错版本应报告不匹配，不能将无限服金币混入正式服账本。
- 只读取公开状态；遇到 secret value 直接忽略，不转换、不解包。插件不调用大模型、不联网；仅在用户点击游戏内确认后执行对应换装。

账号标识是本机 SavedVariables 中生成的随机标识，不是战网账号。角色钱包转账、邮件和银行存取均可能产生流入/流出，不等于经济利润。未登录角色余额、银行自身余额和历史交易不会自动获取；插件没有观察到的变化也无法补回。

## 将来如何安装

1. 下载并退出无限客户端。在战网中选择“魔兽世界：无限”，打开该版本的安装位置，找到该客户端实际使用的 `Interface\AddOns`。公开测试资料使用过 `_classic_beta_`，**未来正式开放的目录以实际客户端为准**，不要复制到正式服的 `_retail_`。
2. 下载或克隆当前仓库，将 `WOWAddons/WoWForeverCompanion` 整个文件夹复制到上述 `AddOns`；已有版本请先备份。
3. 确认没有多套一层目录，以下文件必须直接位于 `AddOns\WoWForeverCompanion\`：

```text
WoWForeverCompanion.toc
WoWForeverCompanion_Camelot.toc
Protocol.lua
Money.lua
Equipment.lua
Transfer.lua
ConfirmEquip.lua
Telemetry.lua
WoWForeverCompanion.lua
README.md
```

4. 完整启动游戏，在插件列表启用“魔兽无限陪伴精灵 / 魔兽陪伴精灵 桥接”，加载 TOC 中的全部模块。同时更新并重启 魔兽陪伴精灵 2.7.0 配套二开版本；插件、桥接与 魔兽陪伴精灵 必须同步更新以支持 `v=3`。
5. 游戏内输入 `/dump GetBuildInfo()`，核对版本 `1.60.x` 和第 4 项接口号 `16001`。插件不以 `WOW_PROJECT_ID` 区分，因为无限客户端也可能报告 Mainline。其他版本会停止采集并显示提示；请记录输出以便更新兼容层，**不要只改 TOC 来假装兼容**。
6. 输入 `/wowf selftest` 和 `/wowf status`。正常时编码自检包含 `WCF1 / CRC16 / UTF-8`，状态中有等级、金币、心跳和网格位置。编码自检只验证本地协议，不能证明客户端 API 和画面采集全部正常。
7. 打开 魔兽陪伴精灵，进入“设置 → 魔兽陪伴精灵 → 魔兽世界：无限”，启用该版本连接。首次将每格像素设为 `1`，采集坐标先设为 `(8,8)`，保持网格无遮挡；窗口模式时要加上游戏客户区相对桌面的偏移，推荐无边框窗口模式。
8. 核对 魔兽陪伴精灵 里的角色姓名、等级、地图、金币与游戏一致，再按下方清单验收。当前没有客户端时只能开发、运行自动化测试和查看演示数据，不能接收真实无限服数据。

同时提供普通 TOC 和 `_Camelot.toc`，两者内容一致，覆盖普通及 Forever 专用清单加载入口；不依赖 `_Classic.toc` 的回退行为。运行时仍检查客户端版本，避免误装到正式服后输出无限服帧。

## 游戏命令

| 命令 | 功能 |
| --- | --- |
| `/wowf` | 帮助 |
| `/wowf status` | 等级、金币、序号、心跳、负载大小和网格位置 |
| `/wowf selftest` | WCF1、CRC16、UTF-8 编码自检 |
| `/wowf pos 8 8` | 设置相对游戏客户区左上角的物理像素位置 |
| `/wowf compact` | 使用最小 64×64 物理像素网格；保留坐标和开关 |
| `/wowf cell 1` | 每格 1 像素，对应 64×64 网格；可选整数 1–6 |
| `/wowf telemetry` | 显示或隐藏数据传输码；隐藏会导致桌面端失联 |
| `/wowf reset` | 恢复显示设置：网格开启、`x=8`、`y=8`、`cell=1`；保留金币记录 |

位置或格子尺寸更改后，魔兽陪伴精灵 无限服设置中的采集参数也要同步。如果单像素被拉伸变模糊，可改 `/wowf cell 2` 并把 魔兽陪伴精灵 每格像素改为 `2`，网格会变为 128×128。先保证 Windows 和游戏采用原生分辨率、采集区域没有遮挡，再校准。最小化、锁屏、隐藏 UI、加载画面都会中断屏幕读取。

## 协议与保存

64 列 × 64 行，行优先，黑色为 0、白色为 1，每字节最高位先发送。固定 512 字节：

| 偏移 | 内容 |
| --- | --- |
| 0–3 | ASCII `WCF1` |
| 4–5 | UTF-8 JSON 长度，uint16 小端 |
| 6–7 | CRC16-CCITT 校验，小端；初始值 `0xFFFF`、多项式 `0x1021` |
| 8–511 | 最多 504 字节 JSON，剩余补零 |

JSON 使用与正式服一致的 `v=3` 快照字段：`session/seq/tick/guid/name/realm/level/class/faction/race/spec/map/zone/combat/dead/online/account/moneyEpoch/copper/earned/spent`。帧标识负责隔离游戏版本，不增加屏幕面积。业务变化递增 `seq`，每秒递增 `tick`，登录或重载更换 `session`。金币按累计计数传输，桌面漏采几帧后仍可合并插件已观察到的收支；其他短暂事件可能在漏采期间丢失，不是可靠事件队列。

`faction` 与 `race` 是必填且可为 `null` 的 JSON 字段。阵营仅接受 `Alliance`、`Horde`、`Neutral`；中立和未知明确区分。种族为完整的本地化名称，去除颜色标记及 C0/C1 控制字符，非空且最多 48 个 UTF-8 字节；过长或暂不可用时发送 `null`。秘密值、缺失 API、接口错误和切换角色时不会沿用旧阵营/种族。登录和原有采样事件会更新；`NEUTRAL_FACTION_SELECT_RESULT` 后立即读取并在 0.25、1、2、5 秒重试。

固定负载仍为 504 字节。超长时先缩短地图名、服务器名、角色名，仍不足才将 `race` 整体置 `null`，不发送半截种族名。阵营、职业、GUID、会话/金币标识和精确计数不会为凑帧改写。极端组合本身仍超限时明确编码失败，旧快照、画面和心跳不更新，桌面按超时识别失联；不会传送被损坏的身份或计数。

`WoWForeverCompanionDB` 保存显示设置、账号标识、各角色金币计数和最新快照。游戏通常在 `/reload` 或正常退出时写入账号目录的 `SavedVariables\WoWForeverCompanion.lua`，不是实时磁盘接口。备份时先正常退出游戏；勿把正式服的 SavedVariables 复制过来。外部程序不得执行该数据文件中的 Lua。

## 自动化验证与待验收项

在本目录运行真实 Lua 5.1 模块的 API 模拟测试：

```powershell
python -m pip install --target tests/.deps lupa
python -m unittest discover -s tests -v
```

99 项测试通过，新增 7 项覆盖三阵营/中文种族、阵营选择重试、秘密/错误/缺失 API 清空、角色切换、完整 UTF-8 名称与控制字符、超限整项降级和编码失败时冻结画面心跳。原有测试覆盖帧标识、长度、CRC 与位序、UTF-8、升级与地图/战斗/死亡事件、现代专精 API 和无专精分支、secret 值过滤、金币基线/收支/重载/换角色/溢出、UI 缩放和 NDui 钩子、64×64 默认布局、独立命令/存档/帧名、错误客户端拒绝采集、缺失可选 API、两份 TOC 的文件完整性，以及下方的装备采集与分片场景。

**这些测试不包含真实无限客户端。开放后还需你协助完成：**

1. 保存 `/dump GetBuildInfo()` 的完整输出，确认插件无 Lua 错误；若提示版本未知，反馈版本与接口号。
2. 确认只出现传输码、没有中央面板；在 魔兽陪伴精灵 无限服页校准并确认实时心跳、角色、地图、金币、阵营和种族正确；联盟、部落及尚未选择阵营的中立角色分别核对。
3. 实际升级一次、跨区域、死亡再复活，确认 魔兽陪伴精灵 事件和陪伴回应只触发一次；战斗免打扰按设置生效。
4. 完成一次已知收入和支出，检查金币汇总分别增加正确金额；换角色、`/reload` 和正常退出再登录后检查连续性。
5. 隐藏网格、最小化再恢复，检查离线提示和恢复连接；切换正式服页面，确认数据及账本不会混用。

## 核对来源

- [暴雪 UI 源码镜像：Forever 分支](https://github.com/Gethe/wow-ui-source/tree/forever)
- [Forever 阵营/种族接口和阵营选择事件定义](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/UnitDocumentation.lua)
- [Forever 专精接口定义](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/SpecializationInfoDocumentation.lua)
- [Forever 地图接口定义](https://github.com/Gethe/wow-ui-source/blob/forever/Interface/AddOns/Blizzard_APIDocumentationGenerated/MapDocumentation.lua)
- [Forever API 实测记录：接口号、Mainline 项目及测试安装目录](https://github.com/Thunderz96/forever-addon-kit)
- [ManaMaster 开发者记录：`_Camelot.toc` 加载实测与 Interface 16001](https://github.com/olav9/ManaMaster/blob/main/CLAUDE.md)

外部开发者的实测只用于核对客户端基线和加载规则，不代表本插件已完成实机验收。没有引入这些项目的代码。


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

默认开启，命令 `/wowf equip on`、`/wowf equip off`、`/wowf equip status` 可开启、关闭或查看状态。只处理本次登录基线之后新进入背包的装备，不会扫描旧背包并批量换装。关闭后再开启只处理之后新观察到的装备。

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

Version 1.8.0 uses the game client locale for addon messages and equipment confirmation. English, Simplified/Traditional Chinese, Spanish, French, Italian, Portuguese, Japanese, Korean, and Russian display strings are included. Unknown locales fall back to English. Game observations, slash commands, and telemetry keys remain unchanged. Fully restart the game after updating to load Localization.lua. The desktop language is selected separately in Settings → System → General → Language.


## Current map coordinates (1.9.0)

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
