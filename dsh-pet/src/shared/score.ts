// 点击积分（src/shared，浏览器 bundle 与桌面 shared-core 共用）：
// 点击**飞行中**的宠物（抛掷进行中）且当前速度达标时触发 → 粒子爆发 + 积分弹窗。
// 分数由当前速度与宠物大小决定：速度越快 / 宠物越小，分越高（线性映射，可单测）。
import { PET_REF_WIDTH } from './constants';

/** 达标速度阈值（px/s）：飞行中被点击时低于它不给分（低速点击维持普通点击动画） */
export const SCORE_MIN_SPEED = 400;

/** 每 100 px/s 记 1 分（基准尺寸 462px 下） */
const SCORE_SPEED_PER_POINT = 100;

/**
 * 点击积分：score = round(speed/100 × 462/size)，至少 1 分。
 * 小宠物（目标小、飞行中更难命中）反而分高；speed ≤ 0 / size ≤ 0 返回 0
 * （调用方按 0 不触发）。达标判定用 SCORE_MIN_SPEED 由调用方做。
 */
export const clickScore = (speed: number, size: number): number => {
  if (speed <= 0 || size <= 0) return 0;
  return Math.max(1, Math.round((speed / SCORE_SPEED_PER_POINT) * (PET_REF_WIDTH / size)));
};
