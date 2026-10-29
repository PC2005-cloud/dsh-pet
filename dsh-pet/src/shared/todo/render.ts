/**
 * 待办面板的 DOM 骨架与清单渲染：只拼元素、绑事件，不取数、不定位、不关弹窗。
 *
 * 删除做成两步（先变成「确认」，2.5 秒后自动复原）：清单没有撤销，误点一次就没了太容易。
 * @module dsh-pet/src/shared/todo/render
 */
import { metaLabel, todoUrgency } from './format.ts';
import type { TodoItem } from './types.ts';

/** 面板里需要被面板逻辑持有的元素。 */
export interface TodoPanelParts {
  /** 根：定位与显隐的宿主。 */
  root: HTMLElement;
  /** 添加表单：回车提交。 */
  form: HTMLFormElement;
  /** 正文输入框。 */
  input: HTMLInputElement;
  /** 到期时间输入框（`datetime-local`，空 = 无期限）。 */
  due: HTMLInputElement;
  /** 添加按钮。 */
  addButton: HTMLButtonElement;
  /** 关闭按钮（右上角）。 */
  closeButton: HTMLButtonElement;
  /** 清单容器。 */
  list: HTMLUListElement;
  /** 空态提示。 */
  empty: HTMLDivElement;
  /** 顶部的未完成计数。 */
  count: HTMLSpanElement;
  /** 错误行（隐藏时为 `hidden`）。 */
  error: HTMLDivElement;
}

/** 清单条目上的交互回调。 */
export interface TodoListHandlers {
  /** 勾选 / 取消勾选。 */
  onToggle: (todo: TodoItem, done: boolean) => void;
  /** 删除（调用方已确认过一次）。 */
  onDelete: (todo: TodoItem) => void;
}

/** 删除按钮的二次确认窗口（ms）：超时自动复原，避免「确认」态一直挂着。 */
const DELETE_ARM_MS = 2500;

/** 空态文案：加载中会临时替换它，重渲染时再写回来。 */
const EMPTY_TEXT = '还没有待办。记一件要做的事，到点我会提醒你～';

/** 造一个带 class 的元素，避免每处都写 createElement + className。 */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 造面板骨架（尚未挂进文档）。
 *
 * @returns 面板需要的全部元素引用。
 */
export function createTodoPanelParts(): TodoPanelParts {
  const root = element('div', 'dsh-pet-todo');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', '待办事项');

  const head = element('div', 'dsh-pet-todo-head');
  const title = element('span', 'dsh-pet-todo-title', '待办事项');
  const count = element('span', 'dsh-pet-todo-count', '0 项未完成');
  count.setAttribute('aria-live', 'polite');
  const closeButton = element('button', 'dsh-pet-todo-close', '✕');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭待办面板');
  head.append(title, count, closeButton);

  const form = element('form', 'dsh-pet-todo-form');
  const input = element('input', 'dsh-pet-todo-input');
  input.type = 'text';
  input.maxLength = 200;
  input.placeholder = '记一件要做的事…';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', '待办内容');
  const row = element('div', 'dsh-pet-todo-row');
  const due = element('input', 'dsh-pet-todo-due');
  due.type = 'datetime-local';
  due.setAttribute('aria-label', '提醒时间（可选）');
  const addButton = element('button', 'dsh-pet-todo-add', '添加');
  addButton.type = 'submit';
  row.append(due, addButton);
  form.append(input, row);

  const error = element('div', 'dsh-pet-todo-err');
  error.hidden = true;

  const empty = element('div', 'dsh-pet-todo-empty', EMPTY_TEXT);
  empty.hidden = true;

  const list = element('ul', 'dsh-pet-todo-list');
  const hint = element('div', 'dsh-pet-todo-hint', '离到期越近，我会提醒得越勤快～');

  root.append(head, form, error, empty, list, hint);
  return { root, form, input, due, addButton, closeButton, list, empty, count, error };
}

/**
 * 渲染一整张清单。
 *
 * @param parts - 面板元素。
 * @param todos - 已排序的待办。
 * @param handlers - 勾选与删除的回调。
 * @param now - 当前时刻，用来生成「还剩多久」。
 */
export function renderTodoList(
  parts: TodoPanelParts,
  todos: readonly TodoItem[],
  handlers: TodoListHandlers,
  now: number,
): void {
  parts.list.textContent = '';
  const pending = todos.filter((todo) => !todo.done).length;
  parts.count.textContent = `${pending} 项未完成`;
  parts.empty.textContent = EMPTY_TEXT;
  parts.empty.hidden = todos.length > 0;
  for (const todo of todos) parts.list.appendChild(renderItem(todo, handlers, now));
}

/** 渲染一条；未完成项带紧迫度，已完成项划线。 */
function renderItem(todo: TodoItem, handlers: TodoListHandlers, now: number): HTMLLIElement {
  const item = element('li', 'dsh-pet-todo-item' + (todo.done ? ' is-done' : ''));
  if (!todo.done) item.dataset.urgency = todoUrgency(todo.dueAt, now);

  const check = element('input', 'dsh-pet-todo-check');
  check.type = 'checkbox';
  check.checked = todo.done;
  check.setAttribute('aria-label', (todo.done ? '标记未完成：' : '标记完成：') + todo.text);
  check.addEventListener('change', () => handlers.onToggle(todo, check.checked));

  const main = element('div', 'dsh-pet-todo-main');
  const text = element('div', 'dsh-pet-todo-text', todo.text);
  const meta = element('div', 'dsh-pet-todo-meta', metaLabel(todo, now));
  main.append(text, meta);

  const remove = element('button', 'dsh-pet-todo-del', '✕');
  remove.type = 'button';
  remove.setAttribute('aria-label', '删除：' + todo.text);
  remove.addEventListener('click', () => {
    // 第一次点击只进入确认态；再点一次才真的删。
    if (remove.dataset.armed !== '1') {
      remove.dataset.armed = '1';
      remove.classList.add('is-armed');
      remove.textContent = '确认';
      window.setTimeout(() => {
        // 面板已关闭 / 已重渲染时元素不再在文档里：静默复原即可。
        if (!remove.isConnected) return;
        delete remove.dataset.armed;
        remove.classList.remove('is-armed');
        remove.textContent = '✕';
      }, DELETE_ARM_MS);
      return;
    }
    handlers.onDelete(todo);
  });

  item.append(check, main, remove);
  return item;
}

/**
 * 显示 / 清除错误行。
 *
 * @param parts - 面板元素。
 * @param message - 错误文案；null 表示清除。
 */
export function setTodoError(parts: TodoPanelParts, message: string | null): void {
  parts.error.hidden = message === null;
  parts.error.textContent = message ?? '';
}

/**
 * 切换忙碌态：请求在途时禁掉输入与按钮，避免连点建出两条。
 *
 * @param parts - 面板元素。
 * @param busy - 是否请求在途。
 */
export function setTodoBusy(parts: TodoPanelParts, busy: boolean): void {
  parts.input.disabled = busy;
  parts.due.disabled = busy;
  parts.addButton.disabled = busy;
}
