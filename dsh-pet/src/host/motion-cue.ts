/**
 * 位置 / 抛掷指令（`POST /dsh-pet-7340/position`、`POST /dsh-pet-7340/throw`）的**纯决策层**。
 *
 * 与 ./anim 同一分工：只判定"该不该受理、受理成什么"，不碰 HTTP、不碰 S，可完全离线单测。
 *
 * 抛掷**不引入任何新行为**：复用前端的 `startThrow`（参数换算成初速度），重力、反弹、地面摩擦、
 * 落地 Q 弹、宠物间碰撞等全部是既有行为。位置由 `mode` 三选一决定走哪条路（见 decidePosition），
 * 三条路同样是渲染端既有的运动学。所以本层一概不管运动，只剩两件事：**参数校验**与**坐标夹取**。
 */

import { flattenPetList } from './config';

/** 受理失败的分类（路由原样透出给调用方，与 ./anim 用同一套词汇） */
export type MotionFailure = 'bad-request' | 'pet-required' | 'unknown-pet';

/**
 * 位置指令的运动模式（三选一）。
 * **与 shared/state.ts 的同名联合体是两份**——宿主不 import src/shared（同 `Corner` 的处理方式），
 * 改动时两边要一起改。
 */
export type PositionMode = 'instant' | 'spring' | 'line';

/** 合法模式集合：校验与错误信息共用一份，避免两处各写一遍 */
export const POSITION_MODES: readonly PositionMode[] = ['instant', 'spring', 'line'];

/** 位置决策结论：通过则给出最终要写进 S 的内容（`duration` 为 `null` = 该模式不用时间） */
export type PositionDecision =
  | { ok: true; petId: string; x: number; y: number; mode: PositionMode; duration: number | null }
  | { ok: false; reason: MotionFailure; message: string };

/** 抛掷决策结论 */
export type ThrowDecision =
  { ok: true; petId: string; angle: number; power: number } | { ok: false; reason: MotionFailure; message: string };

/** 夹到 0~1：归一化坐标的合法范围，**越界夹取而不是拒绝**（调用方拿响应里的实际值即可） */
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 有限数字收窄：字符串 / 布尔 / NaN / Infinity 一律不算（配置里也这么判） */
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 模式收窄：只认三个字面量（大小写、空白、非字符串一律不算），不认识返回 `null` */
const positionMode = (v: unknown): PositionMode | null =>
  typeof v === 'string' && (POSITION_MODES as readonly string[]).includes(v) ? (v as PositionMode) : null;

/**
 * 目标宠物解析（与 ./anim、./broadcast 同一口径）：`?pet=` **必填**且必须真实存在。
 *
 * 两种失败分开报（issue #122 第 1 条「绝不默认退到列表第一只」）：
 * 没给 → `pet-required`；给了但配置里没有 → `unknown-pet`。
 *
 * 收紧前这里是 `requested || active || 'main'`：`active` 是"当前桌宠" = **有效宠物列表第一只**，
 * 而那个落点是用户 /pet 操作的函数——同一句不带 pet 的调用，落点会随用户操作而变，调用方无从
 * 预期。所以整条缺省链已删除，pet 与 /pet-display 的 `id` 一样是必填项。
 */
function resolvePet(
  cfg: Record<string, Record<string, unknown>>,
  requested: string,
): { ok: true; petId: string } | { ok: false; reason: MotionFailure; message: string } {
  const petId = String(requested ?? '').trim();
  if (!petId) return { ok: false, reason: 'pet-required', message: 'pet 必填：要指定操作哪只桌宠' };
  if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) {
    return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
  }
  return { ok: true, petId };
}

/**
 * 把外部给的位置请求核对成一个结论。
 *
 * `x`/`y` 是宠物**中心**的归一化坐标（0~1）。选中心而不是左上角：前端持久位置 `customPos`
 * 存的就是中心（`rx = (px + halfW) / W`），且调用方不必知道宠物多大。
 *
 * `mode` **必填**，三种运动模式（三条路都是渲染端既有运动学，宿主只负责选路）：
 *
 *   - `instant`：一帧到位；
 *   - `spring`：拖拽跟手那套过阻尼弹簧（`springStep`）平滑追过去；
 *   - `line`：**按 `duration` 毫秒直线走到**——该模式下 `duration` **必填**（非负有限数，
 *     `0` = 立即到位）。
 *
 * `instant` / `spring` 给了 `duration` 也**不看**：调用方常把 body 模板整个复用，为此报错只会
 * 逼他们删字段。
 *
 * 校验顺序：`x`/`y` → `mode` → `duration` → 宠物解析。参数是调用方的错，先纠它。
 */
export function decidePosition(args: {
  cfg: Record<string, Record<string, unknown>>;
  /** `?pet=` 的原值（**必填**：空串 → `pet-required`） */
  requested: string;
  x: unknown;
  y: unknown;
  /** 必填：`instant` / `spring` / `line` */
  mode?: unknown;
  /** 仅 `line` 模式必填：行程时间（毫秒），非负有限数，`0` = 立即到位 */
  duration?: unknown;
}): PositionDecision {
  const x = finite(args.x);
  if (x === null) return { ok: false, reason: 'bad-request', message: 'x 必须是有限数字' };
  const y = finite(args.y);
  if (y === null) return { ok: false, reason: 'bad-request', message: 'y 必须是有限数字' };

  const mode = positionMode(args.mode);
  if (mode === null) {
    return { ok: false, reason: 'bad-request', message: 'mode 必须是 instant / spring / line' };
  }
  let duration: number | null = null;
  if (mode === 'line') {
    const d = finite(args.duration);
    if (d === null || d < 0) {
      return { ok: false, reason: 'bad-request', message: 'line 模式的 duration 必须是非负有限数字（毫秒）' };
    }
    duration = d;
  }

  const pet = resolvePet(args.cfg, args.requested);
  if (!pet.ok) return pet;

  return { ok: true, petId: pet.petId, x: clamp01(x), y: clamp01(y), mode, duration };
}

/**
 * 决策结论 → 写进 S 叶子的载荷。**非 `line` 模式不带 `duration`**：叶子形状本身就是语义
 * （有 `duration` 就是"按时间走直线"），也省得前端去读一个恒为 `0` 的字段。
 */
export const positionLeafData = (d: {
  x: number;
  y: number;
  mode: PositionMode;
  duration: number | null;
}): Record<string, unknown> =>
  d.duration === null ? { x: d.x, y: d.y, mode: d.mode } : { x: d.x, y: d.y, mode: d.mode, duration: d.duration };

/**
 * 把外部给的抛掷请求核对成一个结论。
 *
 * `angle` 单位度，`0` = 正右、**逆时针为正**（屏幕坐标 y 向下，所以这是数学惯例而非屏幕惯例：
 * "往上抛"写 90）。这里**不做角度归一化**——前端换算成 vx/vy 时 sin/cos 对任意实数都成立。
 *
 * `power` 是力度倍率（`1.0` = 1200 px/s 软钳速**前**，实际初速会被既有软上限压到约 1021）。
 * **不设死区**：拖拽松手时低于 500 px/s 算"温柔放下"，那是拖拽语义；接口是明确命令，再小也照抛。
 */
export function decideThrow(args: {
  cfg: Record<string, Record<string, unknown>>;
  /** `?pet=` 的原值（**必填**：空串 → `pet-required`） */
  requested: string;
  angle: unknown;
  power: unknown;
}): ThrowDecision {
  const angle = finite(args.angle);
  if (angle === null) return { ok: false, reason: 'bad-request', message: 'angle 必须是有限数字' };
  const power = finite(args.power);
  if (power === null || power <= 0) {
    return { ok: false, reason: 'bad-request', message: 'power 必须是大于 0 的有限数字' };
  }

  const pet = resolvePet(args.cfg, args.requested);
  if (!pet.ok) return pet;

  return { ok: true, petId: pet.petId, angle, power };
}
