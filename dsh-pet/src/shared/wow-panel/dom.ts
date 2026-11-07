/** 魔兽工具面板的原生表单与无 HTML 插值的展示组件。 */
import { object, text, type JsonObject, type WowApi, type WowGame, type WowLocale } from './api.ts';

/** 每个分区共享当前选择和操作反馈。 */
export interface PanelContext {
  game: WowGame;
  locale: WowLocale;
  state: JsonObject;
  api: WowApi;
  t: (zh: string, en: string) => string;
  task: (button: HTMLButtonElement, work: () => Promise<void>, success?: string) => void;
  refresh: () => Promise<void>;
}

/** 创建元素；所有远端文本仅通过 textContent 写入。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content = '',
  className = '',
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = content;
  if (className) result.className = className;
  return result;
}

/** 创建有标题的卡片。 */
export function card(title: string, hint = ''): HTMLElement {
  const result = el('section', '', 'dsh-wow-card');
  result.append(el('h3', title));
  if (hint) result.append(el('p', hint, 'dsh-wow-hint'));
  return result;
}

/** 创建表单项，标签包装控件以便键盘与读屏访问。 */
export function field(label: string, control: HTMLElement): HTMLLabelElement {
  const result = el('label', '', 'dsh-wow-field');
  control.setAttribute('aria-label', label);
  result.append(el('span', label), control);
  return result;
}

/** 创建文本、密码或数值输入。 */
export function input(value: unknown = '', type = 'text'): HTMLInputElement {
  const result = el('input');
  result.type = type;
  result.value = text(value, '');
  if (type === 'password') result.autocomplete = 'new-password';
  return result;
}

/** 创建本地选项下拉框。 */
export function select(options: ReadonlyArray<readonly [string, string]>, value: unknown): HTMLSelectElement {
  const result = el('select');
  for (const [id, label] of options) {
    const option = el('option', label);
    option.value = id;
    result.append(option);
  }
  result.value = text(value, '');
  return result;
}

/** 创建开关。 */
export function checkbox(label: string, checked: boolean): { node: HTMLLabelElement; input: HTMLInputElement } {
  const control = input('', 'checkbox');
  control.checked = checked;
  const node = el('label', '', 'dsh-wow-check');
  node.append(control, el('span', label));
  return { node, input: control };
}

/** 创建异步操作按钮，统一处理重入和错误。 */
export function action(
  ctx: PanelContext,
  label: string,
  work: () => Promise<void>,
  success?: string,
): HTMLButtonElement {
  const button = el('button', label);
  button.type = 'button';
  button.addEventListener('click', () => ctx.task(button, work, success));
  return button;
}

/** 显示一组名称与值。 */
export function facts(entries: ReadonlyArray<readonly [string, unknown]>): HTMLDListElement {
  const result = el('dl', '', 'dsh-wow-facts');
  for (const [label, value] of entries) result.append(el('dt', label), el('dd', text(value)));
  return result;
}

/** 通过横向滚动容器展示数据表格。 */
export function table(
  rows: JsonObject[],
  columns: ReadonlyArray<readonly [string, (row: JsonObject) => unknown]>,
  empty: string,
): HTMLElement {
  if (!rows.length) return el('p', empty, 'dsh-wow-hint');
  const wrap = el('div', '', 'dsh-wow-table');
  const result = el('table');
  const header = el('tr');
  for (const [label] of columns) header.append(el('th', label));
  const head = el('thead');
  head.append(header);
  result.append(head);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const [, value] of columns) tr.append(el('td', text(value(row))));
    body.append(tr);
  }
  result.append(body);
  wrap.append(result);
  return wrap;
}

/** 将原始档案放入可折叠区域，保留非摘要字段。 */
export function details(title: string, value: unknown): HTMLDetailsElement {
  const result = el('details');
  result.append(el('summary', title), el('pre', JSON.stringify(value, null, 2) ?? '—'));
  return result;
}

/** 读取当前游戏实时档案；Classic 没有采集桥时返回空对象。 */
export function profile(ctx: PanelContext): JsonObject {
  return object(object(ctx.state.profiles)[ctx.game]);
}

/** 显示有效时间戳，未知值保持为空。 */
export function date(value: unknown, locale: WowLocale): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '—';
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? '—' : result.toLocaleString(locale);
}

/** 将铜币的整数或十进制字符串格式化为金银铜，避免大额账本精度损失。 */
export function money(value: unknown, t: PanelContext['t']): string {
  if (!/^-?\d+$/.test(text(value, ''))) return '—';
  const amount = BigInt(text(value));
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 10000n}${t('金', 'g')} ${(absolute / 100n) % 100n}${t('银', 's')} ${absolute % 100n}${t('铜', 'c')}`;
}
