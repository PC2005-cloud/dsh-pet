// 纯选择逻辑：不依赖 React / DOM，可独立单测。浏览器 bundle 与桌面 shared-core 共用同一份源码。
import type { Category, EventSlot, Events, Weights } from './types';

/** 从字符串池里等概率随机抽一个；exclude 排除某个名字（避免连续重复） */
export const pick = <T>(pool: T[], exclude?: T): T => {
  const entries = exclude ? pool.filter((n) => n !== exclude) : pool;
  // 排除后池空（单元素池 + 排除自己）：退回原池抽——宁可重复，也不要返回 undefined
  const src = entries.length ? entries : pool;
  return src[Math.floor(Math.random() * src.length)];
};

/**
 * 事件档位取值：字符串槽位原样返回（固定播放，原行为不变）；
 * 数组槽位 = 档内候选，随机抽 1 并尽量避开 exclude（当前正在播的动画，避免连续重复）；
 * 排除后池空（单候选 + 排除自己）退回原数组——宁可重复，也不要返回 undefined（与 pick 同一哲学）。
 */
export const pickSlot = (slot: EventSlot, exclude?: string): string => {
  if (typeof slot === 'string') return slot;
  const entries = exclude === undefined ? slot : slot.filter((n) => n !== exclude);
  const src = entries.length ? entries : slot;
  return src[Math.floor(Math.random() * src.length)];
};

/** 槽位是否包含某动画名：字符串按名比；数组查成员（成员判断必须走这里——直接 includes 会漏掉数组槽位） */
export const slotIncludes = (slot: EventSlot, anim: string): boolean =>
  typeof slot === 'string' ? slot === anim : slot.includes(anim);

/** 事件池（档位槽位数组）是否包含某动画名 */
export const poolIncludes = (pool: readonly EventSlot[], anim: string): boolean =>
  pool.some((slot) => slotIncludes(slot, anim));

/** 整个 events 段是否包含某动画名（事件动画播完回 idle / switchTo 诊断 / 循环护栏共用） */
export const isEventAnim = (events: Readonly<Events> | undefined, anim: string): boolean =>
  events ? Object.values(events).some((pool) => poolIncludes(pool, anim)) : false;

/** 生成 [min, max) 区间内的随机整数 */
export const randomBetween = (min: number, max: number): number => Math.floor(min + Math.random() * (max - min));

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

/** 掷骰结果类别 */
export type RollKind = 'idle' | 'turn' | 'move' | 'action';

/**
 * 按权重掷骰：roll ∈ [0,1) → 下一个动画类别（纯函数，可单测）。
 * topEnd = (idle+turn+move)/100：三档权重占比之和，剩余概率归入 'action'。
 */
export const rollKind = (roll: number, w: Weights): RollKind => {
  const topEnd = (w.idle + w.turn + w.move) / 100;
  if (roll < w.idle / 100) return 'idle';
  if (roll < (w.idle + w.turn) / 100) return 'turn';
  if (roll < topEnd) return 'move';
  return 'action';
};

/** 从分类池选一个动作；无可用分类时回退 idle 池（返回 {id, name}，纯函数）。
 * facing 用于 noMirror 镜像过滤；current 用于避免连续重复（pick 的 exclude）。 */
export const pickCategoryAction = (
  categories: Category[],
  idlePool: string[],
  facing: string,
  current: string,
): { id: string; name: string } => {
  const cat = pickWeightedCategory(categories, facing);
  if (!cat) return { id: 'FALLBACK', name: pick(idlePool, current) };
  return { id: cat.id, name: pick(cat.actions, current) };
};
