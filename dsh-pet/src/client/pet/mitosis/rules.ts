/**
 * 有丝分裂的纯判定：连点够不够一次分裂、这次多生几只、分身用哪套物理与动作频率、上限怎么收。
 *
 * 不碰 DOM、不发请求、不持有状态：输入是当帧的数字与成品配置片段，输出是下一份值。
 * 依赖只有 shared 的物理与权重类型、以及归一化中心 Center。
 * 必须始终成立：同一组输入必得同一输出；随机只来自显式注入的 rand；
 * 模式切换只改上限与物理，不改分身身份键，也不动本体除互撞以外的任何参数。
 * @module dsh-pet/src/client/pet/mitosis/rules
 */
import type { Center } from '../motion/geometry.ts';
import type { PhysicsParams, Weights } from '../../../shared/types.ts';

/** 分裂模式：普通 = 分身无重力、带空气阻力；碰撞 = 在普通基础上打开互撞并去掉阻力。 */
export type MitosisMode = 'normal' | 'collide';

/** 一张卡在分裂关系里的位置。 */
export type MitosisRole = 'main' | 'clone';

/** 连点判定窗口（ms）：超出它就把计数归零重来。 */
export const MITOSIS_TAP_WINDOW_MS = 1000;

/** 触发一次分裂需要的连点次数。 */
export const MITOSIS_TAP_TIMES = 5;

/** 每种模式下的宠物总数上限（含本体）。 */
export const MITOSIS_CAP: Readonly<Record<MitosisMode, number>> = { normal: 64, collide: 32 };

/** 分身不受重力，空气阻力是唯一能把它的速度降到零的量（/s）。 */
export const CLONE_AIR_DRAG = 0.45;

/** 分身撞墙恢复系数：比默认弹性一些，看起来才像在漂。 */
export const CLONE_RESTITUTION = 0.95;

/** 分身出生区：横向留 6% 起、纵向留 6% 起，右边与底下留出本体与任务栏的余量。 */
const SPAWN_X = 0.06;
const SPAWN_Y = 0.06;
const SPAWN_W = 0.78;
const SPAWN_H = 0.68;

/** 连点窗口：起点时刻与已累计次数；count 到 0 表示已结算过这次分裂。 */
export interface TapWindow {
  startMs: number;
  count: number;
}

/** 分裂出来的一个分身实例（身份键 + 出生点）。 */
export interface CloneSeed {
  seq: number;
  spot: Center;
}

/**
 * 连点推进一步：够数就报一次分裂并把窗口清零。
 *
 * @param tap - 该宠物当前的窗口；`null` = 还没点过。
 * @param now - 本次点击时刻（ms）。
 * @returns 新窗口与「这次是否该分裂」。
 */
export const nextTap = (tap: TapWindow | null, now: number): { tap: TapWindow; split: boolean } => {
  const fresh = tap === null || now - tap.startMs > MITOSIS_TAP_WINDOW_MS;
  const count = fresh ? 1 : tap.count + 1;
  if (count < MITOSIS_TAP_TIMES) return { tap: { startMs: fresh ? now : tap.startMs, count }, split: false };
  return { tap: { startMs: now, count: 0 }, split: true };
};

/**
 * 这次分裂几只：与本地魔改版同口径——现有总数翻倍，但绝不超过上限。
 *
 * @param total - 现有宠物总数（本体 + 分身）。
 * @param cap - 当前模式的上限。
 * @returns 新增分身只数；已到上限时为 0。
 */
export const planSplit = (total: number, cap: number): number => (total >= cap ? 0 : Math.min(total, cap - total));

/**
 * 模式切换后把超出的分身收掉：按序号留最前面的几只，避免一次切换凭空消失一批。
 *
 * @param clones - 该宠物当前的分身列表（按 seq 升序）。
 * @param cap - 新模式的上限（含本体）。
 * @returns 收敛后的列表；不需要收敛时是同一个数组。
 */
export const trimClones = <T>(clones: readonly T[], cap: number): T[] => {
  const keep = Math.max(0, cap - 1);
  return clones.length <= keep ? [...clones] : clones.slice(0, keep);
};

/**
 * 分身的动作频率：把「转个身、走两步」的比重抬起来，idle 压低——
 * 一群不动的分身只是重复贴图，会动的才像一窝。
 *
 * @param weights - 本体（成品配置）的权重。
 * @returns 分身用的权重；三项各有下限，不会出现整群钉死。
 */
export const cloneWeightsOf = (weights: Weights): Weights => ({
  idle: Math.max(2, Math.round(weights.idle * 0.4)),
  turn: Math.max(2, Math.round(weights.turn * 1.4)),
  move: Math.max(3, Math.round(weights.move * 2.4)),
});

/**
 * 分身的物理：无重力 + 高弹 + 无摩擦 + 顶部反弹，阻力按模式给。
 *
 * @param physics - 本体（成品配置）的物理段。
 * @param mode - 当前分裂模式。
 * @returns 一份新的物理参数，不改入参。
 */
export const clonePhysics = (physics: PhysicsParams, mode: MitosisMode): PhysicsParams => ({
  ...physics,
  gravity: 0,
  restitution: CLONE_RESTITUTION,
  groundFriction: 0,
  ceilingBounce: true,
  petCollision: mode === 'collide' ? true : physics.petCollision,
  airDrag: mode === 'collide' ? 0 : CLONE_AIR_DRAG,
});

/**
 * 本体在碰撞模式下也要参与互撞，其余参数原样保留（本体仍有重力，不会飘走）。
 *
 * @param physics - 成品配置的物理段。
 * @param mode - 当前分裂模式。
 * @returns 需要覆盖时返回新对象，否则返回入参本身。
 */
export const mainPhysics = (physics: PhysicsParams, mode: MitosisMode): PhysicsParams =>
  mode === 'collide' ? { ...physics, petCollision: true } : physics;

/**
 * 一个出生点：视口内随机一块安全区域（归一化中心坐标）。
 *
 * @param rand - 随机源，测试里注入固定值。
 * @returns 分身的初始中心位置。
 */
export const spawnSpot = (rand: () => number): Center => ({
  rx: SPAWN_X + rand() * SPAWN_W,
  ry: SPAWN_Y + rand() * SPAWN_H,
});

/**
 * 分身身份键：只在渲染期与碰撞站场里用，宿主侧仍认本体那一只。
 *
 * @param petId - 本体宠物 id。
 * @param seq - 该本体的分身序号（从 1 起）。
 * @returns 形如 `<petId>~m<seq>` 的键。
 */
export const instanceKeyOf = (petId: string, seq: number): string => petId + '~m' + seq;

/**
 * 徽章数字：本体 1，分身从 2 起顺着排。
 *
 * @param seq - 分身序号；0 = 本体。
 * @returns 显示用的编号。
 */
export const badgeOf = (seq: number): number => seq + 1;

/**
 * 读取持久化的模式：脏值一律回普通模式。
 *
 * @param raw - 存储里的原始字符串；`null` = 没存过。
 * @returns 可用的模式。
 */
export const readMode = (raw: string | null): MitosisMode => (raw === 'collide' ? 'collide' : 'normal');
