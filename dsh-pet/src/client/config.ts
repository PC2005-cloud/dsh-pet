// 配置层：拉取 / 解析 config.jsonc，构建运行时动作配置（唯一事实来源）。
import type { AnimConfig } from './types';

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
