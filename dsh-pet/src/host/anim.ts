/**
 * 播放动画（`POST /dsh-pet-7340/anim`）的**纯决策层**。
 *
 * 用途：宿主侧其他插件想让桌宠播一段动画（"点播"），效果与右键菜单里点「动作」树完全一致
 * ——两端都复用同一个菜单动作处理函数，本模块只负责**判定该不该播、播哪一个**。
 *
 * 为什么单独一层：契约就是"名字必须在菜单能点到的集合里"。播放端对不存在的动画没有兜底
 * （名字即文件名，404 → 加载失败 → 表现为"点了没反应"），所以名字校验是硬要求，且必须能
 * 脱离 HTTP 单测。本模块只依赖配置（动画池都在 animations 里，不碰文件系统），可完全离线测。
 *
 * 允许集合 = 右键菜单三级树叶里所有 `anim` 的并集。菜单树的唯一事实来源是
 * src/shared/menu.ts 的 buildMenuTree()，它取这 7 个池：idle / turn / drag / clicks /
 * moves.actions / categories / events。
 * **host 不 import src/shared**（DSH 单文件加载约束，见 index.ts 顶部说明），所以这里按同一
 * 口径自包含实现一份；两边的守卫测试会同时钉住这份口径，任一侧改了池子就会有一边失败。
 */

import { findPetInstance, flattenPetList } from './config';

/** 点播失败的分类（路由原样透出给调用方） */
export type AnimFailure = 'bad-request' | 'unknown-pet' | 'unknown-animation';

/** 决策结论：通过则给出最终要写进 S 的内容，否则给出显式原因 */
export type AnimDecision =
  { ok: true; petId: string; name: string } | { ok: false; reason: AnimFailure; message: string };

/** 字符串数组收窄（配置里的池子；非数组/空串 → 空数组） */
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/**
 * 该条目的 animations 配置 → 可点播的动画名（去重，保持首次出现顺序）。
 * 池子与顺序对齐 src/shared/menu.ts 的 buildMenuTree()：
 *   待机 → 转向 → 拖拽 → 点击回应 → 移动 → config 随机动作分类 → 事件（数组槽位展平）
 */
export function animationNames(animations: unknown): string[] {
  const a = (animations && typeof animations === 'object' ? animations : {}) as Record<string, unknown>;
  const out: string[] = [];
  const push = (names: string[]): void => {
    for (const n of names) if (!out.includes(n)) out.push(n);
  };

  push(strings(a.idle));
  push(strings(a.turn));
  push(strings(a.drag));
  push(strings(a.clicks));

  // 移动：actions 是 { name, ... } 对象数组，只取 name
  const moves = (a.moves && typeof a.moves === 'object' ? a.moves : {}) as Record<string, unknown>;
  push(
    Array.isArray(moves.actions)
      ? moves.actions
          .map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined))
          .filter((x): x is string => typeof x === 'string' && x !== '')
      : [],
  );

  // config 随机动作分类：每个分类一个 actions 池
  if (Array.isArray(a.categories)) {
    for (const c of a.categories) {
      if (c && typeof c === 'object') push(strings((c as { actions?: unknown }).actions));
    }
  }

  // 事件动画：值是「档位数组」，每档可能是单个名字或候选数组（展平）
  const events = (a.events && typeof a.events === 'object' ? a.events : {}) as Record<string, unknown>;
  for (const key of Object.keys(events)) {
    const pool = events[key];
    if (!Array.isArray(pool)) continue;
    const names: string[] = [];
    for (const slot of pool) {
      if (typeof slot === 'string') names.push(slot);
      else names.push(...strings(slot));
    }
    push(names);
  }

  return out;
}

/**
 * 把外部给的点播请求与当前配置核对成一个结论。
 *
 * @param cfg readAllConfig 的合并成品（所有字段已填满，这里不做兜底解析）
 * @param requested `?pet=` 的原值（可为空串）
 * @param active `resolveActivePetId()` 的结果（可为空串；无宠物时为空）
 * @param name 外部给的动画名（未规范化）
 */
export function decideAnim(args: {
  cfg: Record<string, Record<string, unknown>>;
  requested: string;
  active: string;
  name: unknown;
}): AnimDecision {
  const { cfg, requested, active } = args;

  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return { ok: false, reason: 'bad-request', message: 'name 为空' };

  // pet 缺省 = 当前桌宠；active 也为空时兜底 main（与 /broadcast 同一口径）
  const petId = String(requested || active || 'main');
  if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) {
    return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };
  }

  // 名字必须是该宠物菜单里点得到的动画。播放端"名字即文件名"，播不存在的动画只会静默失败，
  // 所以必须在这里拦住，而不是写进 S 让前端白跑一趟。
  const conf = (findPetInstance(cfg, petId) ?? { conf: cfg.main ?? {} }).conf;
  const allowed = animationNames(conf.animations);
  if (!allowed.includes(name)) {
    return { ok: false, reason: 'unknown-animation', message: '没有这个动画：' + name };
  }

  return { ok: true, petId, name };
}
