// 纯选择逻辑：不依赖 React / DOM，可独立单测。
import type { Category } from './types';

/** 从字符串池里等概率随机抽一个；exclude 排除某个名字（避免连续重复） */
export const pick = <T,>(pool: T[], exclude?: T): T => {
  const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
  return entries[Math.floor(Math.random() * entries.length)];
};

/** 生成 [min, max) 区间内的随机整数 */
export const randomBetween = (min: number, max: number): number =>
  Math.floor(min + Math.random() * (max - min));

/**
 * 按权重在分类池中选一个分类；noMirror 分类在镜像(facing=right)时被排除，
 * 剩余权重自动归一化。分类池为空时返回 null。
 */
export const pickWeightedCategory = (categories: Category[], facing: string): Category | null => {
  const cats = categories.filter((c) => c.actions.length > 0);
  if (!cats.length) return null;
  const filtered = cats.filter((c) => !(c.noMirror && facing === 'right'));
  const eligible = filtered.length ? filtered : cats;
  const totalW = eligible.reduce((s, c) => s + c.weight, 0) || 1;
  let t = Math.random() * totalW;
  for (const c of eligible) {
    t -= c.weight;
    if (t <= 0) return c;
  }
  return eligible[eligible.length - 1];
};
