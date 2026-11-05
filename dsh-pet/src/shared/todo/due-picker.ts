/**
 * 待办的到期时间选择器：一个显示当前值的按钮 + 内嵌日历。
 *
 * 日历区在「日期 / 小时 / 分钟」三种网格之间切换，高度按内容算，不用预留。
 * 内嵌而不是浮层：桌面宠物窗口只比宠物大一圈，浮层会被窗口边缘裁掉；面板向上长，两端一致。
 * 显隐由面板的折叠容器控制（这里不设 hidden，display:none 会让折叠过渡失效），本模块只报告
 * aria-expanded 与 onOpenChange；值写成 `YYYY-MM-DDTHH:mm`，提醒链路不感知这里。
 * @module dsh-pet/src/shared/todo/due-picker
 */
import { monthCells } from './calendar.ts';
import { dueLabel, formatDateTimeLocal } from './format.ts';
import { chromeText, fillChrome, type ChromeKey } from '../../locale/chrome.ts';
import { getHostLocale } from '../../locale/current.ts';

/** 周一为一周首日，与国内日历习惯一致。文案键按这个顺序。 */
const WEEK_HEAD: readonly ChromeKey[] = [
  'todo.head.1',
  'todo.head.2',
  'todo.head.3',
  'todo.head.4',
  'todo.head.5',
  'todo.head.6',
  'todo.head.7',
];

function t(key: ChromeKey): string {
  return chromeText(getHostLocale(), key);
}

/** 分钟档位：与提醒的最短间隔一致，避免选出提醒策略分辨不出的时刻。 */
const MINUTE_STEP = 5;

/** 未选日期时的默认时分：早上九点，比零点更像个「该做事了」的时刻。 */
const DEFAULT_HOUR = 9;

/** 日历区的三种网格。 */
type PickerMode = 'day' | 'hour' | 'minute';

/** 选择器句柄。 */
export interface DuePicker {
  /** 表单行里的触发按钮。 */
  readonly el: HTMLButtonElement;
  /** 日历容器；由面板插进根节点，默认收起。 */
  readonly calendar: HTMLElement;
  /** 当前值，`YYYY-MM-DDTHH:mm`；未选为 `''`。 */
  value(): string;
  /** 收起日历，已选的值保持不变。 */
  close(): void;
  /** 回到「无期限」并收起。 */
  reset(): void;
  /** 摘掉文档监听。 */
  dispose(): void;
}

/** 选择器的创建参数。 */
export interface DuePickerOptions {
  /** 展开或收起时回调，面板据此收起清单腾出高度。 */
  onOpenChange?: (open: boolean) => void;
}

/** 选择器的可变状态；渲染函数只读它，事件处理只写它。 */
interface PickerState {
  /** 选中的日期（时分在下面两个字段），null = 无期限。 */
  picked: Date | null;
  hour: number;
  minute: number;
  /** 当前展示的月份（该月 1 号）。 */
  view: Date;
  /** 当前网格。 */
  mode: PickerMode;
  open: boolean;
}

/** 选择器持有的 DOM 引用。 */
interface PickerDom {
  el: HTMLButtonElement;
  calendar: HTMLDivElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  title: HTMLSpanElement;
  grid: HTMLDivElement;
  hourChip: HTMLButtonElement;
  minuteChip: HTMLButtonElement;
}

/** 两位补零。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 造一个带 class 的元素。 */
function make<K extends 'button' | 'div' | 'span'>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** 造一个按钮：全部是 `type="button"`，否则在表单里会触发提交。 */
function makeButton(className: string, text?: string): HTMLButtonElement {
  const button = make('button', className);
  button.type = 'button';
  if (text !== undefined) button.textContent = text;
  return button;
}

/** 建整个选择器的 DOM（尚未挂进文档）。 */
function buildPickerDom(): PickerDom {
  const el = makeButton('dsh-pet-todo-due', t('todo.dueButton'));
  el.setAttribute('aria-haspopup', 'dialog');
  el.setAttribute('aria-expanded', 'false');
  el.setAttribute('aria-label', t('todo.dueAria'));

  const calendar = make('div', 'dsh-pet-todo-cal');
  calendar.setAttribute('role', 'dialog');
  calendar.setAttribute('aria-label', t('todo.calAria'));

  const head = make('div', 'dsh-pet-todo-cal-head');
  const prev = makeButton('dsh-pet-todo-cal-nav', '‹');
  prev.dataset.act = 'prev';
  prev.setAttribute('aria-label', t('todo.prevMonth'));
  const title = make('span', 'dsh-pet-todo-cal-title');
  const next = makeButton('dsh-pet-todo-cal-nav', '›');
  next.dataset.act = 'next';
  next.setAttribute('aria-label', t('todo.nextMonth'));
  head.append(prev, title, next);

  const week = make('div', 'dsh-pet-todo-cal-week');
  for (const name of WEEK_HEAD) {
    const cell = make('span', '');
    cell.textContent = t(name);
    week.appendChild(cell);
  }
  const grid = make('div', 'dsh-pet-todo-cal-grid');

  const foot = make('div', 'dsh-pet-todo-cal-foot');
  const today = makeButton('dsh-pet-todo-cal-act', t('todo.today'));
  today.dataset.act = 'today';
  const clear = makeButton('dsh-pet-todo-cal-act', t('todo.clear'));
  clear.dataset.act = 'clear';
  const grow = make('span', 'dsh-pet-todo-cal-grow');
  const hourChip = makeButton('dsh-pet-todo-cal-chip', '09');
  hourChip.dataset.act = 'hour';
  hourChip.setAttribute('aria-label', t('todo.hour'));
  const colon = make('span', 'dsh-pet-todo-cal-colon');
  colon.textContent = ':';
  const minuteChip = makeButton('dsh-pet-todo-cal-chip', '00');
  minuteChip.dataset.act = 'minute';
  minuteChip.setAttribute('aria-label', t('todo.minute'));
  const done = makeButton('dsh-pet-todo-cal-act', t('todo.donePick'));
  done.dataset.act = 'done';
  foot.append(today, clear, grow, hourChip, colon, minuteChip, done);

  calendar.append(head, week, grid, foot);
  return { el, calendar, prev, next, title, grid, hourChip, minuteChip };
}

/** 同一个自然日（忽略时分）。 */
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 选中日期 + 当前时分组成的时刻；未选日期为 null。 */
function dueMs(state: PickerState): number | null {
  if (state.picked === null) return null;
  const { picked } = state;
  return new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), state.hour, state.minute).getTime();
}

/** 造一个日历格：选中态同时写进 class 与 aria。 */
function cellButton(text: string, selected: boolean): HTMLButtonElement {
  const button = makeButton('dsh-pet-todo-cal-cell', text);
  button.classList.toggle('is-sel', selected);
  button.setAttribute('aria-pressed', String(selected));
  return button;
}

/** 画日期网格。 */
function renderDays(dom: PickerDom, state: PickerState): void {
  const today = new Date();
  for (const cell of monthCells(state.view.getFullYear(), state.view.getMonth())) {
    const { date } = cell;
    const button = cellButton(String(date.getDate()), state.picked !== null && sameDay(state.picked, date));
    button.classList.toggle('is-out', cell.out);
    button.classList.toggle('is-today', sameDay(today, date));
    button.dataset.ts = String(date.getTime());
    button.setAttribute(
      'aria-label',
      fillChrome(getHostLocale(), 'todo.dayAria', { month: date.getMonth() + 1, day: date.getDate() }),
    );
    dom.grid.appendChild(button);
  }
}

/** 画小时或分钟的网格：一格一个数，当前值高亮。 */
function renderNumbers(dom: PickerDom, state: PickerState): void {
  const isHour = state.mode === 'hour';
  const count = isHour ? 24 : 60;
  const step = isHour ? 1 : MINUTE_STEP;
  for (let value = 0; value < count; value += step) {
    const button = cellButton(pad2(value), (isHour ? state.hour : state.minute) === value);
    button.dataset.num = String(value);
    button.setAttribute(
      'aria-label',
      fillChrome(getHostLocale(), isHour ? 'todo.unitHour' : 'todo.unitMinute', { value }),
    );
    dom.grid.appendChild(button);
  }
}

/** 同步按钮文案、时分标签与当前网格的标题。 */
function syncPicker(dom: PickerDom, state: PickerState): void {
  const ms = dueMs(state);
  const id = getHostLocale();
  dom.el.textContent = ms === null ? chromeText(id, 'todo.undated') : dueLabel(ms, Date.now(), id);
  dom.el.classList.toggle('is-set', ms !== null);
  dom.hourChip.textContent = pad2(state.hour);
  dom.minuteChip.textContent = pad2(state.minute);
  dom.hourChip.classList.toggle('is-on', state.mode === 'hour');
  dom.minuteChip.classList.toggle('is-on', state.mode === 'minute');
}

/** 整块重画：标题、翻月按钮、网格与文案一次到位。 */
function renderPicker(dom: PickerDom, state: PickerState): void {
  const day = state.mode === 'day';
  const id = getHostLocale();
  dom.title.textContent = day
    ? fillChrome(id, 'todo.monthTitle', { year: state.view.getFullYear(), month: state.view.getMonth() + 1 })
    : state.mode === 'hour'
      ? chromeText(id, 'todo.hour')
      : chromeText(id, 'todo.minute');
  dom.prev.hidden = !day;
  dom.next.hidden = !day;
  dom.grid.className = 'dsh-pet-todo-cal-grid is-' + state.mode;
  dom.grid.textContent = '';
  if (day) renderDays(dom, state);
  else renderNumbers(dom, state);
  syncPicker(dom, state);
}

/** 选中某一天：同步展示月份，并回到日期网格。 */
function pickDay(dom: PickerDom, state: PickerState, date: Date): void {
  state.picked = date;
  state.view = new Date(date.getFullYear(), date.getMonth(), 1);
  state.mode = 'day';
  renderPicker(dom, state);
}

/** 点日历里的按钮：翻月、切网格、今天、清除、完成，或选中某一天 / 某个数。 */
function onCalendarClick(dom: PickerDom, state: PickerState, button: HTMLButtonElement, close: () => void): void {
  const { ts, num, act } = button.dataset;
  if (ts !== undefined) {
    pickDay(dom, state, new Date(Number(ts)));
    return;
  }
  if (num !== undefined) {
    if (state.mode === 'hour') state.hour = Number(num);
    else state.minute = Number(num);
    state.mode = 'day';
    renderPicker(dom, state);
    return;
  }
  if (act === 'prev' || act === 'next') {
    state.view = new Date(state.view.getFullYear(), state.view.getMonth() + (act === 'prev' ? -1 : 1), 1);
    renderPicker(dom, state);
    return;
  }
  if (act === 'hour' || act === 'minute') {
    // 再点一次当前网格的标签就退回日期，省一个返回按钮。
    state.mode = state.mode === act ? 'day' : act;
    renderPicker(dom, state);
    return;
  }
  if (act === 'today') {
    const now = new Date();
    pickDay(dom, state, new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    return;
  }
  if (act === 'clear') state.picked = null;
  renderPicker(dom, state);
  // 收起必须走 close：它还要同步 aria 与面板的 is-picking（清单靠它重新露出来）。
  if (act === 'clear' || act === 'done') close();
}

/**
 * 造一个到期时间选择器。
 *
 * @param options - 展开与收起的回调。
 * @returns 触发按钮、日历容器与读写句柄。
 */
export function createDuePicker(options: DuePickerOptions = {}): DuePicker {
  const now = new Date();
  const state: PickerState = {
    picked: null,
    hour: DEFAULT_HOUR,
    minute: 0,
    view: new Date(now.getFullYear(), now.getMonth(), 1),
    mode: 'day',
    open: false,
  };
  const dom = buildPickerDom();

  const setOpen = (open: boolean): void => {
    if (state.open === open) return;
    state.open = open;
    dom.el.setAttribute('aria-expanded', String(open));
    options.onOpenChange?.(open);
  };

  dom.el.addEventListener('click', () => {
    // 打开时落到「已选日期的月份」，没选过就落到当月，并总是从日期网格开始。
    if (!state.open) {
      const anchor = state.picked ?? new Date();
      state.view = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      state.mode = 'day';
      renderPicker(dom, state);
    }
    setOpen(!state.open);
  });
  dom.calendar.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button');
    if (button !== null) onCalendarClick(dom, state, button, () => setOpen(false));
  });
  // 点面板里别处就收起日历：面板自己也挂了同样的监听，两者互不干扰（各判各的容器）。
  const onDocMouseDown = (event: MouseEvent): void => {
    if (!state.open) return;
    const target = event.target as Node | null;
    if (target !== null && (dom.el.contains(target) || dom.calendar.contains(target))) return;
    setOpen(false);
  };
  document.addEventListener('mousedown', onDocMouseDown, true);

  renderPicker(dom, state);
  return {
    el: dom.el,
    calendar: dom.calendar,
    value: () => {
      const ms = dueMs(state);
      return ms === null ? '' : formatDateTimeLocal(ms);
    },
    close: () => setOpen(false),
    reset: () => {
      state.picked = null;
      state.hour = DEFAULT_HOUR;
      state.minute = 0;
      state.mode = 'day';
      renderPicker(dom, state);
      setOpen(false);
    },
    dispose: () => document.removeEventListener('mousedown', onDocMouseDown, true),
  };
}
