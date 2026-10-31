/**
 * 物理默认参数：弹簧、重力、抛掷上限与挤压档位。
 *
 * 只提供默认值；运行时一律以成品配置的 physics 段为准。
 * 必须始终成立：与包内 config.jsonc 的 physics 段保持一致，改一处须同步另一处。
 * @module dsh-pet/src/shared/physics/constants
 */
import { type PhysicsParams } from '../types.ts';

/** 拖拽弹簧刚度：越大跟手越紧。 */
export const SPRING_K = 200;

/** 拖拽弹簧阻尼：ζ = c/(2√k) ≈ 1.06，过阻尼，不 overshoot。 */
export const SPRING_C = 30;

/** 拖拽轨迹保留窗口（ms）：只留最近这一段做初速估算。 */
export const TRAIL_KEEP_MS = 200;

/** 初速估算窗口（ms）。 */
export const RELEASE_WINDOW_MS = 150;

/** 松手前停顿超过它即温柔放下（不带残余速度），即使之前甩过。 */
export const RELEASE_STALE_MS = 150;

/** 窗口太短视为不可估算（ms）。 */
export const MIN_SPAN_MS = 20;

/** 分段速度的最小 dt（ms）：高回报率鼠标事件可低至 1ms，过小 dt 会把抖动放大成虚假峰值。 */
export const SEG_MIN_DT_MS = 8;

/** 低于此速度即不抛（原地放下），px/s。 */
export const DEAD_ZONE_SPEED = 500;

/** 甩出速度软上限（px/s）：cap×(1-e^(-s/cap))，任意力度仍单调可区分，渐近不超过 cap。 */
export const MAX_THROW_SPEED = 3600;

/** 初速大小 = 端点均值×(1-w) + 窗口峰值×w，弥补快甩时位移集中在窗口内一小段的低估。 */
export const PEAK_WEIGHT = 0.5;

/** 参考加速度（px/s²）：末段加速达到它即吃满增益。 */
export const ACCEL_REF = 8000;

/** 加速度增益上限：仍在加速的甩动最多放大 60%。 */
export const ACCEL_GAIN_MAX = 0.6;

// 抛掷物理默认值：与内置 config 的 physics 段一致，运行时以成品配置为准
/** 抛掷重力（px/s²）。 */
export const GRAVITY = 1400;

/** 碰边恢复系数：每次反弹保留约 78% 速度。 */
export const RESTITUTION = 0.78;

/** 接触面切向摩擦（/s）：撞墙、落地、撞顶后沿接触面方向的速度衰减率；0 = 四面都像冰面。 */
export const GROUND_FRICTION = 2.5;

/** 抛掷物理的默认参数（与内置配置一致；仅作配置缺失时的兜底）。 */
export const DEFAULT_PHYSICS: PhysicsParams = {
  gravity: GRAVITY,
  restitution: RESTITUTION,
  groundFriction: GROUND_FRICTION,
  ceilingBounce: true,
  throwPower: 1,
  petCollision: true,
  hapticEnabled: true,
  tiltGravity: false,
  shakeThrow: false,
};

/** 总力度默认量（throwPower=1 即现状）。 */
export const DEFAULT_THROW_POWER = 1;

/** 接触面法向速度低于它就贴住（px/s）：否则重力持续压向同一面时每帧都被反弹，表现为贴面抖动。 */
export const REST_NORMAL = 40;

/** 接触面切向速度低于它认为已静止（px/s）。 */
export const REST_TANGENT = 15;

/** 判静止时法向速度的容差（px/s）：比 {@link REST_NORMAL} 严得多，只用于确认「已经贴住」。 */
export const REST_NORMAL_EPS = 1;

/** 单步最大 dt（s）：防后台标签页卡顿恢复后的巨帧跳变。 */
export const MAX_STEP_DT = 0.05;

/** 下压幅度：高度压到 55%。 */
export const SQ_SQUASH = 0.55;

/** 挤压时长（ms）。 */
export const SQ_DURATION_MS = 220;

/** 落地冲击速度基准：低于此即轻落（按下限幅度）。 */
export const SQ_SOFT_SPEED = 300;

/** 落地冲击速度上限：达到或超过此即重砸（吃满最大下压）。 */
export const SQ_HARD_SPEED = 1500;

/** 落地最大下压幅度（与点击一致）；轻落下限 0.8——重力 1400px/s²、恢复 0.78 下典型落地速度
 *  400~1500px/s，映射太保守会让常规甩抛的落地 Q 弹不明显，故底部留底限。 */
export const SQ_MAX_SQUASH = 0.55;

/** 抛掷指令的力度锚点：power = 1.0 对应软钳速之前的 1200 px/s（实际初速被压到约 1021 px/s）。 */
export const THROW_SPEED_ANCHOR = 1200;

/** 弹弓（双击第二下按住拖）：力度 = 拉距，与手速无关。
 *  拉距只负责换成初速度，之后照旧走 throwStep / throwStepRegion，重力、反弹、摩擦、Q 弹都不变。
 *  方向 = 拉的反方向；力度不设上限——软钳速是为手速抖动设的，拉得远与拉得更远必须能区分开。
 *  刻度与 throwVelocity 同源：power = 1 对应 THROW_SPEED_ANCHOR，并乘同一个 physics.throwPower。
 *  「一倍力度」的参考拉距 = 宠物宽 × SLINGSHOT_REF_RATIO。 */
export const SLINGSHOT_REF_RATIO = 0.6;

// 积分细分：弹弓没有速度上限，靠拆步保证一帧内的落地与反弹不被跳过，不是力度上限
/** 单步允许的最大位移（px）：一帧位移超过它就拆成多步积分。 */
export const SUBSTEP_PX = 8;

/** 单帧最多拆几步（兜底：极端速度下别把一帧拖成几百次积分）。 */
export const SUBSTEP_MAX = 64;

/** 多宠物碰撞恢复系数：能量损失约 0.5%（e = 0.995，接近完全弹性）。 */
export const PET_BOUNCE_E = 0.995;
