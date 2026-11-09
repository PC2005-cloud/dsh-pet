/**
 * 宠物 UI 的取词入口：共享模块不直接依赖 DSH 的 locale 服务，由 app.ts 在启动时注入。
 *
 * 没注入时按 zh 原文取词——单元测试、宿主侧与桌面 shared-core 都走这条，
 * 因此默认行为与本地化之前完全一致。注入后由宿主按当前语言返回译文。
 * @module dsh-pet/src/shared/ui/i18n
 */
import { zh, type Key } from './locales/zh.ts';

export type { Key };

/** 取词函数：键 + 插值参数 → 当前语言文案。 */
export type UiTranslate = (key: Key, params?: Record<string, string | number>) => string;

/** app.ts 注入的当前语言取词函数；null = 还没注入，回落中文。 */
let active: UiTranslate | null = null;

/**
 * 注入 / 清除取词函数。
 *
 * @param t - 宿主 locale 绑定的取词函数；null 表示退出当前语言，回落中文。
 */
export function setUiTranslate(t: UiTranslate | null): void {
  active = t;
}

/** 按 `{name}` 占位符做一次简单插值；缺参数时原样保留占位符，便于发现漏传。 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/**
 * 取一条 UI 文案。
 *
 * @param key - `pet.ui` 的键。
 * @param params - `{name}` 占位符的值。
 * @returns 当前语言文案；未注入时返回中文原文。
 */
export function uiT(key: Key, params?: Record<string, string | number>): string {
  if (active !== null) return active(key, params);
  return interpolate(zh[key], params);
}
