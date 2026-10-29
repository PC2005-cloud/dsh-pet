/**
 * 待办面板的挂载与生命周期：取数、提交、跟随宠物定位、点外与 Esc 关闭。
 *
 * 只负责一次弹窗：骨架与列表在 ./render，定位在 ./position，HTTP 在 ./api。
 * 全页同时只允许一个面板；点宠物命中区不算「点外面」，好让再次点击宠物由调用方收起面板。
 * @module dsh-pet/src/shared/todo/panel
 */
import { TODOS_PATH, addTodo, loadTodos, patchTodo, removeTodo, type TodoResult } from './api.ts';
import { parseDateTimeLocal } from './format.ts';
import { placeTodoPanel, type AnchorRect } from './position.ts';
import { createTodoPanelParts, renderTodoList, setTodoBusy, setTodoError, type TodoListHandlers } from './render.ts';
import { injectTodoCss } from './styles.ts';
import type { TodoItem } from './types.ts';

/** 挂载参数。 */
export interface TodoPanelOptions {
  /** 读宠物命中区的当前矩形（视口坐标）；返回 null 表示宠物已不在，面板自行关闭。 */
  anchor: () => AnchorRect | null;
  /** 命中区元素：点它不关闭面板，交给宠物自己的单击开关处理。 */
  anchorEl?: HTMLElement | null;
  /** 接口基址；桌面端可传绝对地址，缺省走同源前缀。 */
  baseUrl?: string;
  /** 面板关闭后调用（点外 / Esc / 关闭按钮 / 再次挂载顶掉旧面板都会触发一次）。 */
  onClose?: () => void;
}

/** 面板挂载句柄。 */
export interface TodoPanelMount {
  /** 根元素（`document.body` 下）。 */
  el: HTMLElement;
  /** 关闭并清理（幂等）。 */
  close: () => void;
}

/** 跟随宠物位置的巡检间隔（ms）：宠物会自己走位，面板得跟着挪。 */
const FOLLOW_MS = 200;

/** 当前打开的面板；全页唯一。 */
let active: TodoPanelMount | null = null;

/**
 * 挂载待办面板（已有面板先关闭）。
 *
 * @param options - 锚点、基址与关闭回调。
 * @returns 挂载句柄；调用方只需在卸载时 `close()`。
 */
export function mountTodoPanel(options: TodoPanelOptions): TodoPanelMount {
  injectTodoCss();
  active?.close();
  const parts = createTodoPanelParts();
  const baseUrl = options.baseUrl ?? TODOS_PATH;

  let closed = false;
  let busy = false;
  let todos: TodoItem[] = [];
  let followTimer: number | null = null;
  let mount: TodoPanelMount | null = null;

  /** 关闭并清理：监听、跟随定时器、根节点与单例引用一起收。 */
  function close(): void {
    if (closed) return;
    closed = true;
    if (followTimer !== null) window.clearInterval(followTimer);
    followTimer = null;
    window.removeEventListener('resize', place);
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    parts.root.remove();
    if (active === mount) active = null;
    options.onClose?.();
  }

  /** 把面板贴到宠物命中区旁；宠物没了就收摊。 */
  function place(): void {
    const anchor = options.anchor();
    if (anchor === null) {
      close();
      return;
    }
    const size = { width: parts.root.offsetWidth, height: parts.root.offsetHeight };
    const point = placeTodoPanel(anchor, size, { width: window.innerWidth, height: window.innerHeight });
    parts.root.style.left = point.left + 'px';
    parts.root.style.top = point.top + 'px';
  }

  // 三个函数互相引用（列表回调 → 修改 → 重拉 → 渲染）：mutate / reload 用函数声明提升，
  // 回调里引用它们不会在构造期求值，也就不存在初始化顺序问题。
  const handlers: TodoListHandlers = {
    onToggle: (todo, done) => void mutate(() => patchTodo(todo.id, { done }, baseUrl)),
    onDelete: (todo) => void mutate(() => removeTodo(todo.id, baseUrl)),
  };

  /** 重新拉整张清单：修改一律以宿主返回为准，不在本地猜结果。 */
  async function reload(): Promise<void> {
    const result = await loadTodos(baseUrl);
    if (closed) return;
    if (!result.ok) {
      setTodoError(parts, result.message);
      // 加载失败时别让空态一直停在「加载中…」。
      parts.empty.textContent = '清单加载失败，关掉面板再开一次试试';
      parts.empty.hidden = false;
      return;
    }
    todos = result.value;
    setTodoError(parts, null);
    renderTodoList(parts, todos, handlers, Date.now());
  }

  /** 串行执行一次修改：请求在途时禁止再次提交，成功后统一重拉。 */
  async function mutate(task: () => Promise<TodoResult<unknown>>): Promise<void> {
    if (closed || busy) return;
    busy = true;
    setTodoBusy(parts, true);
    setTodoError(parts, null);
    const result = await task();
    busy = false;
    if (closed) return;
    setTodoBusy(parts, false);
    if (!result.ok) {
      setTodoError(parts, result.message);
      return;
    }
    await reload();
  }

  /** 提交新增：空正文直接回到输入框，非法时间不提交。 */
  const submitAdd = (): void => {
    const text = parts.input.value.trim();
    if (text === '') {
      parts.input.focus();
      return;
    }
    const dueText = parts.due.value.trim();
    const dueAt = dueText === '' ? null : parseDateTimeLocal(dueText);
    if (dueText !== '' && dueAt === null) {
      setTodoError(parts, '这个时间看不懂，重新选一个吧');
      return;
    }
    void mutate(async () => {
      const result = await addTodo(text, dueAt, baseUrl);
      if (result.ok) {
        parts.input.value = '';
        parts.due.value = '';
      }
      return result;
    });
  };

  const onDocPointerDown = (event: MouseEvent): void => {
    if (closed) return;
    const target = event.target as Node | null;
    if (target === null) return;
    if (parts.root.contains(target)) return;
    // 点宠物本体不关：让 pet 的单击逻辑决定「收起」（否则会先关再被 click 打开）。
    if (options.anchorEl?.contains(target)) return;
    close();
  };

  const onDocKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };

  parts.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAdd();
  });
  parts.closeButton.addEventListener('click', close);
  parts.empty.textContent = '加载中…';
  parts.empty.hidden = false;

  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  window.addEventListener('resize', place);

  // 先入文档再量尺寸：不在文档里时 offsetWidth 恒为 0，面板会贴到左上角。
  document.body.appendChild(parts.root);
  mount = { el: parts.root, close };
  active = mount;
  place();
  // 锚点缺失时 place 已经收摊：定时器与取数都不再启动。
  if (!closed) {
    followTimer = window.setInterval(place, FOLLOW_MS);
    // 不自动聚焦输入框：单击宠物通常只是想摸摸它，抢走 DSH 输入框的焦点比少一次点击更烦。
    void reload();
  }
  return mount;
}
