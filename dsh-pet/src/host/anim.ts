/**
 * 点播动画（`POST /dsh-pet-7340/anim`）的纯决策层：判定该不该播、播哪一个，结论交给写入方。
 *
 * 不负责播放，也不写 S；与右键菜单「动作」树复用同一个动作处理函数。动画名必须落在允许集合里——
 * 播放端没有兜底（名字即文件名，404 表现为「点了没反应」），所以这条校验是硬要求，且必须能
 * 脱离 HTTP 单测。允许集合 = 菜单三级树叶里所有 anim 的并集 ∪ 玩法自带动画（`animations.baifan`）：
 * 前者的来源是 src/shared/menu.ts 的 buildMenuTree()（宿主不 import src/shared，故自包含一份），
 * 后者不进菜单、但同样是本插件自有素材（吃白饭按名字点播它）。只依赖成品配置，不碰文件系统。
 * 契约见 API.md 与 openapi.yaml。
 * @module dsh-pet/src/host/anim
 */

import { findPetInstance } from './config.ts';

/** 点播失败的分类；路由原样透出给调用方。 */
export type AnimFailure = 'bad-request' | 'pet-required' | 'unknown-pet' | 'unknown-animation';

/**
 * 朝向：`left` = 素材原样，`right` = 镜像（渲染端贴 `scaleX(-1)`）。
 * 与 shared/state.ts 的同名联合体是两份（宿主不 import src/shared），改动时两边要一起改。
 */
export type PetFacing = 'left' | 'right';

/**
 * 决策结论：通过则给出最终要写进 S 的内容（`name` 与 `url` 恰好一个），否则给出显式原因。
 * `facing` 缺席 = 调用方没指定，渲染端不动朝向（不是回落 left）。
 */
export type AnimDecision =
  | { ok: true; petId: string; name?: string; url?: string; facing?: PetFacing }
  | { ok: false; reason: AnimFailure; message: string };

/** 配置里的池子收窄：非数组、非字符串项一律丢弃。 */
function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** 朝向收窄：只认两个字面量，其余（大小写、空白、非字符串）一律不算。 */
const petFacing = (v: unknown): PetFacing | null => (v === 'left' || v === 'right' ? v : null);

/**
 * 该条目的 animations 配置 → 可点播的动画名（去重，保持首次出现顺序）。
 * 池子与顺序对齐 src/shared/menu.ts 的 buildMenuTree()：待机 → 转向 → 拖拽 → 点击回应 →
 * 移动 → 随机动作分类 → 事件（数组槽位展平）；菜单池之后追加玩法池（`baifan`）。
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

  // 玩法自带动画（吃白饭）：不在菜单树上，但同样是本插件自有素材，按名字点播。
  // 追加在最后：菜单池的顺序被菜单树口径与顺序测试钉住，新玩法不该插进菜单序列中间。
  push(strings(a.baifan));

  return out;
}

/**
 * 第三方资源地址规范化：只放行 http / https 的完整 URL，其余一律 null（调用方回 bad-request）。
 *
 * 桌面端换源是 `el.src = url` 直连（不经 `/thumb`），`file:` 能让渲染端读本地任意文件，
 * `javascript:` / `data:` 更没有理由开这个口。跨域不在这里解决、也不该在这里解决：桌面素材走
 * fetch + blob，CORS 由浏览器强制，第三方只能自己配响应头或注册同源路由；宿主不做代理，因此也
 * 没有 SSRF 面。与 ./broadcast 共用这一条规则（两个「第三方投喂」端点的 url 参数同一口径）。
 */
export function normalizeHttpUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const raw = v.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return raw;
}

/**
 * 把外部给的点播请求与当前配置核对成一个结论。
 *
 * `name` 与 `url` 二选一：`url` 是第三方自带的素材地址，给了它就不查动画池——素材在别人手里，
 * 池里当然没有这个名字；两个都给 / 都不给都是意图不明，直接 bad-request，不替调用方猜一个。
 *
 * @param args - 点播参数：`cfg` 为成品配置（字段已填满，不做兜底解析）；`requested` 是 `?pet=` 原值
 *   （空串 → `pet-required`）；`name` / `url` 未规范化且二选一；`facing` 可选，没给则不动朝向。
 */
export function decideAnim(args: {
  cfg: Record<string, Record<string, unknown>>;
  requested: string;
  name: unknown;
  url: unknown;
  facing?: unknown;
}): AnimDecision {
  const { cfg, requested } = args;

  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (name && rawUrl) return { ok: false, reason: 'bad-request', message: 'name 与 url 只能给一个' };
  if (!name && !rawUrl) return { ok: false, reason: 'bad-request', message: 'name 或 url 必须给一个' };

  // facing 可选：没给（undefined / null 都算，复用 body 模板时两种都常见）→ 不动朝向，保持宠物
  // 当前朝向，而不是回落 left。给了就必须合法：非法值不静默忽略（与 /position 的 mode 同一口径，
  // 全插件没有「非法值当没传」的先例）。放在宠物解析之前——参数是调用方的错，先纠它。
  let facing: PetFacing | undefined;
  if (args.facing !== undefined && args.facing !== null) {
    const f = petFacing(args.facing);
    if (f === null) return { ok: false, reason: 'bad-request', message: 'facing 必须是 left / right' };
    facing = f;
  }

  // pet 必填且必须真实存在（与 /broadcast、/position 同一口径）：绝不默认退到「当前桌宠」——
  // 那是有效宠物列表第一只，落点随用户 /pet 操作而变，第三方无从预期。
  const petId = String(requested ?? '').trim();
  if (!petId) return { ok: false, reason: 'pet-required', message: 'pet 必填：要指定操作哪只桌宠' };
  // 一次查找同时给出「存在性」与「所属条目」（动画池按条目取）：校验与取值用同一份结果，
  // 后面不必再查一次。
  const found = findPetInstance(cfg, petId);
  if (!found) return { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId };

  // url 形态：地址合法即放行，不查动画池、也不要求素材真的取得到——播放端对取不到的地址没有
  // 兜底（浏览器 fetch 失败 / 桌面 video error），会经回执如实报 failed，而不是在这里猜。
  if (rawUrl) {
    const url = normalizeHttpUrl(rawUrl);
    if (url === null) {
      return { ok: false, reason: 'bad-request', message: 'url 必须是 http/https 的完整地址' };
    }
    return { ok: true, petId, url, facing };
  }

  // name 形态：名字必须是该宠物菜单里点得到的动画。播放端"名字即文件名"，播不存在的动画只会静默失败，
  // 所以必须在这里拦住，而不是写进 S 让前端白跑一趟。
  const allowed = animationNames(found.conf.animations);
  if (!allowed.includes(name)) {
    return { ok: false, reason: 'unknown-animation', message: '没有这个动画：' + name };
  }

  return { ok: true, petId, name, facing };
}
