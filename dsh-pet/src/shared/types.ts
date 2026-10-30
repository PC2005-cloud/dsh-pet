/**
 * 与 config.jsonc 同构的类型模型：animations / animationWeights / pets 只此一份定义。
 * 运行时（浏览器半侧、桌面 Helper、设置页）直接使用这套结构，不额外造转换后的类型。
 * 纯类型与常量，无 React / DOM 依赖。
 * @module dsh-pet/src/shared/types
 */

/** 支持的角落。 */
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** 轴对齐矩形（左上角 + 宽高）：显示器工作区、窗口内容区、可视夹取区共用同一形状。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 显示位置：决定宠物在浏览器半侧与桌面中的可见性。 */
export type PetDisplay = 'web' | 'desktop' | 'both' | 'none';

/** 移动动作：动作名 + 可选覆盖参数（未写字段取 moves.default）。 */
export interface MoveSpec {
  name: string;
  params?: Record<string, number>;
}

/** 移动池。 */
export interface MovesConfig {
  default: Record<string, number>;
  actions: MoveSpec[];
}

/** 随机动作分类（带文字、镜像会颠倒，facing=right 时跳过）。 */
export interface Category {
  id: string;
  weight: number;
  noMirror?: boolean;
  actions: string[];
}

/** 事件档位槽位：单个动画名（固定播放）或候选数组（触发时档内随机抽 1）。 */
export type EventSlot = string | string[];

/** 事件动画：事件名 → 档位槽位数组（数组顺序即档位顺序；不进随机链，只由代码显式触发）。 */
export type Events = Record<string, EventSlot[]>;

/** 动画权重。 */
export interface Weights {
  idle: number;
  turn: number;
  move: number;
}

/** config.jsonc 的 animations 段。 */
export interface Animations {
  idle: string[];
  turn: string[];
  drag: string[];
  clicks: string[];
  moves: MovesConfig;
  categories: Category[];
  events: Events;
}

/** 一只宠物（与 config.jsonc 的 pets[i] 同形，position 嵌套）。
 *  可选段是渲染期派生或文件宠物专用：条目级字段由合并器在拍平时吹进每只实例，多实例共享；
 *  extra 标记文件宠物（设置页不可编辑、保存时排除，永不出现在持久化配置里）；
 *  assetRoot 是素材根（= 配置文件前缀），多实例共享同一素材目录，所以素材 URL 用它而不是 id。 */
export interface Pet {
  /** 唯一标识（程序定位用：素材、记忆、端点参数都按它；绝不重叠，冲突即配置错误） */
  id: string;
  /** 显示名（可重复）：悬浮提示、AI 人设、命令行定位都用它。
   *  缺失或留空按该宠物 id 处理并告警。 */
  name: string;
  size: number;
  /** 是否启用余额功能：true = 触发余额动画并显示余额气泡，false = 该宠物完全禁用余额。缺失即配置错误 */
  balanceEnabled: boolean;
  /** 是否启用碎碎念：true = 按 eventsRefreshSec.whisper 周期生成一句话并播碎碎念动画，false = 禁用。
   *  缺失默认 true；碎碎念每次生成都会调用当前对话的模型，本地 LLM 单并发时会顶掉正在跑的任务的 KV cache，
   *  不需要的宠物请显式写 false。display 为 none 的宠物整体跳过：不生成、不调模型。 */
  whisperEnabled: boolean;
  /** 是否启用工作状态联动：true = 监听 DSH 会话事件，按 animations.events.workStatus 切档位动画与气泡。
   *  缺失默认 true。监听不调用模型，无 KV cache 风险。 */
  workStatusEnabled: boolean;
  /** 宠物固定：true = 随机链不抽转向与移动两档（权重按 0 算，份额并入原地小动作），只影响随机链——
   *  右键点播、/anim 接口、事件动画、点击回应与拖拽一律照常。缺失默认 false。 */
  fixedEnabled: boolean;
  /** 显示位置（必填）：缺失即配置错误，代码不做兜底 */
  display: PetDisplay;
  position: { corner: Corner; marginX: number; marginY: number };
  /** 实例级人设（pets[].whisperPrompt）：碎碎念与对话共用的系统提示词正文。
   *  写了就取代所属条目顶层那一份（替换而非拼接），没写或空串则回落条目——回落发生在宿主半侧，不是错误。
   *  只写正文：名字与时间背景由宿主无条件追加，不要在这里重复写。 */
  whisperPrompt?: string;
  animations?: Animations;
  animationWeights?: Weights;
  extra?: boolean;
  assetRoot?: string;
  /** 全局默认：事件刷新周期（秒，事件名 → 间隔；整段替换，缺的键由消费端各自兜底）。
   *  .whisper 按所属条目读（种类可覆盖），.balance 只读 main 条目。 */
  eventsRefreshSec?: Record<string, number>;
  /** 全局默认：拖拽抛掷物理参数（用户写一次即对所有宠物生效，含 pet pack；种类文件顶层写了则用自己那份） */
  physics?: PhysicsParams;
  /** 全局默认：是否锁定在当前屏幕——抛掷与自主漫游都只在当前所在那块屏内活动 */
  confineToScreen?: boolean;
  /** 条目级：工作状态气泡文案（外层索引 = 档位 0..5，内层每档可多句随机抽）。
   *  整字段缺失 = 不弹工作状态文本，只播动画。 */
  workStatusTexts?: string[][];
  /** 全局默认：碎碎念单独指定的服务商 + 模型；provider 与 model 都为空 = 跟随当前对话的模型 */
  whisperModel?: ModelSelection;
  /** 全局默认：对话单独指定的服务商 + 模型，都为空 = 跟随当前对话的模型 */
  chatModel?: ModelSelection;
  /** 全局默认：字体（种类 / 字号 / 是否随宠物大小缩放） */
  font?: FontConfig;
  /** 条目级：表情包清单（名称 → 给模型看的描述），合并器吹进每只实例、多实例共享。
   *  顺序即配置书写顺序，也就是 chatImageLimit 截取「前 N 张」的依据。 */
  memes?: Record<string, string>;
  /** 条目级：对话配图开关。true = 对话生成时把表情包清单交给模型按语境选一张；缺省按关处理。 */
  chatImageEnabled?: boolean;
  /** 条目级：对话配图张数上限（非负整数，0 = 不限制）。只截「交给模型的清单」，不截碎碎念抽图。 */
  chatImageLimit?: number;
}

/** 一处「服务商 + 模型」选择（config.jsonc 的 whisperModel / chatModel 段）。
 *  provider 与 model 要么都为空（= 跟随当前对话的模型），要么都非空，只填一半是配置错误。 */
export interface ModelSelection {
  /** 服务商路由 id（与 DSH 模型选择器同一命名空间） */
  provider: string;
  /** 该服务商下的模型 id */
  model: string;
}

/** config.jsonc 的 physics 段：拖拽抛掷手感参数（全局，所有宠物共用）。
 *  默认值见 {@link DEFAULT_PHYSICS}，内置配置与代码两侧保持一致。 */
export interface PhysicsParams {
  /** 重力加速度（px/s²）：越大落得越快；0 = 无重力（合法，均匀直线飞行） */
  gravity: number;
  /** 碰壁反弹恢复系数 0~1（1 = 完全弹性，0 = 撞上即停；墙与地共用） */
  restitution: number;
  /** 地面水平摩擦（/s）：落地时水平速度的衰减率，0 = 无摩擦 */
  groundFriction: number;
  /** 顶部是否反弹：false = 顶部无边界，抛掷可飞出屏幕顶部（重力仍会拉回落） */
  ceilingBounce: boolean;
  /** 总力度（拖拽与抛掷的输出增益）：弹簧 K/C、甩抛初速与软上限整体 ×p（1.0 = 现状，必须 > 0） */
  throwPower: number;
  /** 多宠物互相碰撞开关：true = 飞行中的宠物撞到其它宠物时按动量守恒弹开；false = 互相穿过（默认） */
  petCollision: boolean;
}

/** 字体种类预设 id（font.family 白名单；清单与对应字体栈见 shared/fonts.ts）。 */
export type FontFamilyId = 'candy' | 'yahei' | 'youyuan' | 'kaiti' | 'simsun' | 'comic' | 'system';

/** config.jsonc 的 font 段：字体（全局一份，所有宠物共用）。
 *  默认值 = shared/fonts.ts 的 DEFAULT_FONT（candy / 21 / true）。
 *  整段替换（与 physics 同）：写了就整段用自己的，缺的子键不会从内置默认补回来——
 *  手改时必须三个子键写全，否则整段非法 → 告警并取默认。 */
export interface FontConfig {
  /** 字体种类（预设 id）：影响气泡、悬浮提示、对话窗与得分弹窗 */
  family: FontFamilyId;
  /** 字号 px：只影响气泡与悬浮提示（对话窗与得分弹窗的字号不变），提示与气泡内小字按既有比例派生 */
  size: number;
  /** 字号是否随宠物大小等比缩放：true = 按「实际 size / 基准尺寸」缩放（默认）；false = 恒为 size px */
  followPet: boolean;
}

/** config.jsonc 全集——运行时直接使用。 */
export interface ClientConfig {
  /** 系统通知总开关：true = 对话完成 / 生成失败 / 输出截断 / 权限申请 / 用户选择时弹出通知；缺失即配置错误 */
  notificationsEnabled: boolean;
  /** 点击音效开关：true = 点击宠物时播放内置 click-duck.wav（音量 0.5、100ms 内去重），false = 静音。
   *  内置默认 false（默认静音，不突袭既有用户）。只读 main 条目这一份，pet pack 不单独覆盖。 */
  clickSoundEnabled: boolean;
  /** 桌面模式系统托盘开关：true = 桌面端启动后在通知区域（macOS 为菜单栏）建托盘，列出配置里全部宠物
   *  （含 display 为 web/none 的），勾选即可切回桌面；false = 不建。
   *  缺失默认 true。关掉后「把不在桌面的宠物叫回桌面」在桌面侧没有入口，只能走设置页或网页端右键菜单。 */
  trayEnabled: boolean;
  /** 碎碎念配图开关：true = 每次从表情包池随机抽 1 张连同文本显示（碎碎念无上下文，故随机） */
  whisperImageEnabled: boolean;
  /** 对话配图开关：true = 把表情包清单交模型按语境选 1 张（可不选），false = 纯文本 */
  chatImageEnabled: boolean;
  /** 是否锁定在当前屏幕：true = 宠物只在当前所在那块屏内活动——甩出去只在该屏内弹（屏缝当墙），
   *  自主漫游也只在屏内走；false = 跨屏飞行与跨屏行走。根字段，不属于 physics——它不改手感，只改「被允许去哪」。
   *  条目级，必填，缺失即配置错误。 */
  confineToScreen: boolean;
  pets: Pet[];
  animations: Animations;
  animationWeights: Weights;
  /** 拖拽抛掷物理参数（全局，所有宠物共用；合并器已填默认） */
  physics: PhysicsParams;
  /** 碎碎念用的服务商 + 模型（条目级；两者都为空 = 跟随当前对话的模型） */
  whisperModel: ModelSelection;
  /** 对话用的服务商 + 模型（条目级；两者都为空 = 跟随当前对话的模型） */
  chatModel: ModelSelection;
  /** 事件刷新周期（秒）：事件名 → 间隔；balance = 余额数据刷新与动画触发间隔 */
  eventsRefreshSec: Record<string, number>;
}
