/**
 * 动作频率权重的纯计算：夹取与「随机动作」占比推导。
 * 浏览器设置页与独立模式设置页共用同一份规则，避免两边各算一遍。
 * @module dsh-pet/src/shared/weights
 */
import type { Weights } from './types.ts';

/** 三个可编辑的权重字段；随机动作是余量，不单独存配置。 */
export const WEIGHT_KEYS = ['idle', 'turn', 'move'] as const;

/** 权重合计上限（百分比）：三项之和不能超过它，否则随机动作会是负数。 */
export const WEIGHTS_TOTAL = 100;

/** 内置默认值：与 assets/config.jsonc 的 animationWeights 一致；配置缺失或未就绪时的占位。 */
export const DEFAULT_WEIGHTS: Weights = { idle: 10, turn: 5, move: 5 };

/**
 * 取整并夹取；非有限数按下限处理，输入框里出现脏值时不写坏状态。
 *
 * @param value - 待归一的数值。
 * @param min - 下限。
 * @param max - 上限。
 * @returns 夹取后的整数。
 */
const clampInt = (value: number, min: number, max: number): number => {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded)) return min;
  // 手写坏配置可能让上限低于下限（三项合计已超过 100）：夹到下限，绝不产出负数。
  const upper = Math.max(min, max);
  return Math.min(Math.max(rounded, min), upper);
};

/**
 * 随机动作占比：总上限减去三项之和，最低 0。
 *
 * @param weights - 当前三项权重。
 * @returns 0–100 的整数；手写过大的值时按 0 处理。
 */
export function actionPercent(weights: Weights): number {
  return Math.max(0, WEIGHTS_TOTAL - weights.idle - weights.turn - weights.move);
}

/**
 * 改一个权重：其余两项不动，夹到「给随机动作留 0」的上限。
 *
 * @param weights - 当前三项权重。
 * @param key - 要改的字段。
 * @param value - 目标值；小数取整，越界夹取。
 * @returns 新的权重对象（不修改入参）。
 */
export function withWeight(weights: Weights, key: keyof Weights, value: number): Weights {
  const others = weights.idle + weights.turn + weights.move - weights[key];
  return { ...weights, [key]: clampInt(value, 0, WEIGHTS_TOTAL - others) };
}

/**
 * 从不可信输入解析权重：三项都是非负有限数才采用。
 *
 * @param raw - 成品配置里的 `animationWeights`。
 * @returns 解析出的权重；缺字段、非数字或负数返回 `undefined`，调用方保留表单现值。
 */
export function parseWeights(raw: unknown): Weights | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const idle = Number(record.idle);
  const turn = Number(record.turn);
  const move = Number(record.move);
  if ([idle, turn, move].some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  return { idle, turn, move };
}
