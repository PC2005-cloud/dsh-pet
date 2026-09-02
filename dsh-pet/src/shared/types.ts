// 与 config.jsonc 结构完全同构的类型模型（唯一事实来源 = config.jsonc 的
// animations / animationWeights / pets）。运行时（浏览器 PetCard / 桌面 sprite /
// 设置页）直接使用这套结构，不额外造转换后的类型。
//
// 本目录（src/shared）是浏览器 bundle 与桌面 shared-core（构建产物）共用的
// 纯逻辑层：无 React / DOM 依赖，两边各有一层薄壳做渲染与输入绑定。

/** 支持的角落 */
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * 宠物的显示位置（四个值，必填）：
 * - web     = 只显示在浏览器 overlay
 * - desktop = 只显示在桌面模式（Electron 透明窗）
 * - both    = 两者都显示
 * - none    = 都不显示（保留配置但不参与显示）
 */
export type PetDisplay = 'web' | 'desktop' | 'both' | 'none';

/** 移动动作：一个动作名 + 可选覆盖参数（未写字段取 moves.default） */
export interface MoveSpec {
  name: string;
  params?: Record<string, number>;
}

/** 移动池 */
export interface MovesConfig {
  default: Record<string, number>;
  actions: MoveSpec[];
}

/** 随机动作分类（带文字、镜像会颠倒，facing=right 时跳过） */
export interface Category {
  id: string;
  weight: number;
  noMirror?: boolean;
  actions: string[];
}

/** 事件动画：事件名 → 动画名数组（数组顺序 = 档位顺序；不进随机链，只由代码显式触发） */
export type Events = Record<string, string[]>;

/** 动画权重 */
export interface Weights {
  idle: number;
  turn: number;
  move: number;
}

/** config.jsonc 的 animations 段 */
export interface Animations {
  idle: string[];
  turn: string[];
  drag: string[];
  clicks: string[];
  moves: MovesConfig;
  categories: Category[];
  events: Events;
}

/** 一只宠物（与 jsonc pets[i] 同形，position 嵌套）。
 *  可选段（animations / animationWeights / extra / assetRoot / eventsRefreshSec / physics）为渲染期派生或
 *  「文件定义宠物」专用：
 *  - animations / animationWeights / eventsRefreshSec / physics：所属条目的条目级字段，由配置合并
 *    （host readAllConfig / 客户端 flattenConfigPets）在拍平时吹进每只实例——多实例共享；
 *  - extra: true 标记该宠物由 pet/ 目录文件定义：设置页不可编辑、保存时排除，
 *    由拍平逻辑统一打标，**永不出现在持久化配置里**；
 *  - assetRoot: 素材目录名（= 配置文件前缀 `<名>`，即 `pet/<名>-animation/`）；素材 URL
 *    用它而不是 id——多实例共享同一素材目录。main 等常规宠物并入 main 条目（assetRoot=main）。
 */
export interface Pet {
  /** 唯一标识（程序定位用：素材/记忆/端点参数都按它；绝不重叠，冲突即配置错误） */
  id: string;
  /** 显示名（可重复）：悬浮提示、AI 人设（无条件追加「你的名字是 X」）、未来命令行定位的显示层。
   *  与 id 的区别：id 唯一、程序认它；name 给人看、可重复。缺失/留空按该宠物 id 处理并告警 */
  name: string;
  size: number;
  /** 是否启用余额功能：true=触发余额动画+显示余额气泡；false=该宠物完全禁用余额。缺失即配置错误 */
  balanceEnabled: boolean;
  /** 是否启用碎碎念：true=按 eventsRefreshSec.whisper 周期生成一句话并播碎碎念动画；false=禁用。
   *  缺失默认 false（默认关闭：碎碎念每次生成会调用当前对话的模型，本地 LLM 单并发时
   *  会顶掉正在跑的任务的 KV cache，见 config.jsonc 注释） */
  whisperEnabled: boolean;
  /** 显示位置（web/desktop/both/none，必填）：缺失即配置错误，代码不做兜底 */
  display: PetDisplay;
  position: { corner: Corner; marginX: number; marginY: number };
  animations?: Animations;
  animationWeights?: Weights;
  extra?: boolean;
  assetRoot?: string;
  /** 渲染派生：所属条目的刷新周期（秒，事件名 → 间隔；合并时已填默认值） */
  eventsRefreshSec?: Record<string, number>;
  /** 条目级：拖拽抛掷物理参数（全局共用；host 合并已填默认，拍平时吹入） */
  physics?: PhysicsParams;
}

/** config.jsonc 的 physics 段：拖拽抛掷手感参数（全局，所有宠物共用）。
 *  默认值 = src/shared/physics.ts 的常量（1400 / 0.78 / 2.5 / true / 1.0 / false），内置配置与代码两侧保持一致。 */
export interface PhysicsParams {
  /** 重力加速度（px/s²）：抛掷下落/反弹的基础重力，越大落得越快；0 = 无重力（合法，永不下落/均匀直线飞行） */
  gravity: number;
  /** 碰壁反弹恢复系数 0~1（1 = 完全弹性，0 = 撞上即停；墙/地共用） */
  restitution: number;
  /** 地面水平摩擦（/s）：落地时水平速度的衰减率，0 = 无摩擦 */
  groundFriction: number;
  /** 顶部是否反弹：true = 碰顶反弹；false = 顶部无边界，抛掷可飞出屏幕顶部（重力仍会拉回落） */
  ceilingBounce: boolean;
  /** 总力度（拖拽/抛掷输出增益）：弹簧跟手 K/C、甩抛初速与软上限整体 ×p（1.0 = 现状；必须 > 0） */
  throwPower: number;
  /** 多宠物互相碰撞开关：true = 飞行中被甩出的宠物撞到其它宠物时按动量守恒弹开；false = 关闭（默认，互相穿过） */
  petCollision: boolean;
}

/** config.jsonc 全集——运行时直接使用（ANIM 即本类型） */
export interface ClientConfig {
  /** 系统通知总开关：true=对话完成/生成失败/输出截断/权限申请/用户选择时弹出系统通知；缺失即配置错误 */
  notificationsEnabled: boolean;
  pets: Pet[];
  animations: Animations;
  animationWeights: Weights;
  /** 拖拽抛掷物理参数（全局，所有宠物共用；host 合并已填默认） */
  physics: PhysicsParams;
  /** 事件刷新周期（秒）：事件名 → 间隔；balance = 余额数据刷新 + 动画触发间隔 */
  eventsRefreshSec: Record<string, number>;
}
