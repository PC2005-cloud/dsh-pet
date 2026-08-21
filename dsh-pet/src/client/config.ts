// 配置层：拉取 / 解析 config.jsonc，构建运行时动作配置（唯一事实来源）。
import { DEFAULT_PETS } from './settings';
import type { PetConfigUI } from './settings';
import type { AnimConfig, Corner } from './types';

/** 安全兜底待机名：用于初始渲染 / 配置缺失时宠物不至于空白 */
export const FALLBACK_IDLE = '待机呼吸休闲';
/** 移动默认参数（仅当 config.jsonc 未提供 moves.default 时兜底） */
export const DEFAULT_MOVE_PARAMS: Record<string, number> = {
  minDist: 60,
  maxDist: 240,
  margin: 20,
  leadSec: 2,
  tailSec: 2,
};

/** 剥除 JSONC 注释（行注释 // 与块注释），得到纯 JSON 字符串。仅用于插件自带配置（无含 // 的 URL 值） */
export const stripJsonc = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

/** 最小兜底配置：仅当 config.jsonc 缺失时使用，保证宠物不至于空白 */
export const buildMinimalAnim = (): AnimConfig => ({
  idle: [FALLBACK_IDLE],
  turn: [],
  drag: [],
  clicks: [],
  moves: {
    default: { ...DEFAULT_MOVE_PARAMS },
    actions: [],
  },
  categories: [],
  weights: { idle: 100, turn: 0, move: 0 },
});

/** 从 config.jsonc 解析出的对象构建运行时动作配置（缺字段/写错尽量安全兜底） */
export const buildAnim = (obj: unknown): AnimConfig => {
  const a = (obj as any)?.animations;
  const w = (obj as any)?.animationWeights ?? {};
  const strArr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
  const idle = strArr(a?.idle);
  if (!idle.length) idle.push(FALLBACK_IDLE);
  const turn = strArr(a?.turn);
  const drag = strArr(a?.drag);
  const clicks = strArr(a?.clicks);
  let mdef: Record<string, number> = { ...DEFAULT_MOVE_PARAMS };
  let mActs: { name: string; params?: Record<string, number> }[] = [];
  if (a?.moves && typeof a.moves === 'object') {
    if (a.moves.default && typeof a.moves.default === 'object') mdef = { ...mdef, ...a.moves.default };
    if (Array.isArray(a.moves.actions)) {
      const list = a.moves.actions
        .filter((x: any) => x && x.name)
        .map((x: any) => ({ name: String(x.name), params: x.params && typeof x.params === 'object' ? { ...x.params } : undefined }));
      if (list.length) mActs = list;
    }
  }
  let cats: { id: string; weight: number; noMirror?: boolean; actions: string[] }[] = [];
  if (Array.isArray(a?.categories)) {
    const list = a.categories
      .filter((c: any) => c && c.id && Array.isArray(c.actions) && c.actions.length)
      .map((c: any) => ({ id: String(c.id), weight: Number(c.weight), noMirror: !!c.noMirror, actions: c.actions.map(String) }));
    if (list.length) cats = list;
  }
  return {
    idle,
    turn,
    drag,
    clicks,
    moves: { default: mdef, actions: mActs },
    categories: cats,
    weights: {
      idle: Number(w.idle) >= 0 ? Number(w.idle) : 10,
      turn: Number(w.turn) >= 0 ? Number(w.turn) : 5,
      move: Number(w.move) >= 0 ? Number(w.move) : 5,
    },
  };
};

// ============================================================================
// 多开宠物配置解析（纯函数，不依赖 React）
// ============================================================================
/** 支持的角落白名单 */
export const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** 归一化一个宠物条目（缺字段回落默认） */
export function normalizePet(p: any): PetConfigUI {
  const pos = p && p.position && typeof p.position === 'object' ? p.position : {};
  return {
    id: String(p && p.id ? p.id : 'main'),
    size: Number(p && p.size) > 0 ? Number(p.size) : DEFAULT_PETS[0].size,
    corner: CORNERS.indexOf(pos.corner) !== -1 ? (pos.corner as Corner) : DEFAULT_PETS[0].corner,
    marginX: Number.isFinite(Number(pos.marginX)) ? Number(pos.marginX) : DEFAULT_PETS[0].marginX,
    marginY: Number.isFinite(Number(pos.marginY)) ? Number(pos.marginY) : DEFAULT_PETS[0].marginY,
  };
}

/** 从 config.jsonc 对象提取默认宠物列表：必须为 pets 数组；缺失/为空回落代码兜底 DEFAULT_PETS */
export function extractDefaultPets(obj: any): PetConfigUI[] {
  const arr = obj && Array.isArray(obj.pets) ? obj.pets.filter((p: any) => p && p.id) : [];
  if (!arr.length) return DEFAULT_PETS.map((p) => ({ ...p }));
  const seen = new Set<string>();
  const out: PetConfigUI[] = [];
  for (const p of arr) {
    const id = String(p.id);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(normalizePet(p));
    }
  }
  return out.length ? out : DEFAULT_PETS.map((p) => ({ ...p }));
}

/** 合并最终宠物列表：用户层（{ pets: 完整列表 }）全量替换默认；无用户层回落默认 */
export function resolvePets(defaults: PetConfigUI[], user: any): PetConfigUI[] {
  if (user && Array.isArray(user.pets)) {
    const list = user.pets.filter((p: any) => p && p.id).map(normalizePet);
    return list.length ? list : defaults; // 用户层空数组视为无覆盖
  }
  return defaults;
}
