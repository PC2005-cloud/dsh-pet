/**
 * 待办面板的内容与生命周期：取数、提交、删除、忙碌态，以及「点面板外收起」的意图转发。
 * 不负责定位与显隐：面板是气泡槽的一个槽位，位置与谁显示都由槽位决定。
 * 依赖 ./api 的 HTTP、./render 的骨架与 ./styles 的样式；清理只摘自己的节点与监听，不碰容器。
 * @module dsh-pet/src/shared/todo/panel
 */
import { TODOS_PATH, addTodo, loadTodos, patchTodo, removeTodo, type TodoResult } from './api.ts';
import { parseDateTimeLocal } from './format.ts';
import { createTodoPanelParts, renderTodoList, setTodoBusy, setTodoError, type TodoListHandlers } from './render.ts';
import { injectTodoCss } from './styles.ts';
import { chromeText } from '../../locale/chrome.ts';
import { getHostLocale } from '../../locale/current.ts';
import type { TodoItem } from './types.ts';

/** 面板挂载参数。 */
export interface TodoPanelOptions {
  /** 接口基址；桌面端可传绝对地址，缺省走同源前缀。 */
  baseUrl?: string;
  /** 点面板外面时调用；显隐由槽位决定，面板不自己收。 */
  onClose?: () => void;
  /** 这次按下的落点是否该让面板留着；两端各判各的命中层，面板不认识它们的类名。 */
  keepOpenOn?: (target: EventTarget | null) => boolean;
}

/** 面板句柄。 */
export interface TodoPanel {
  /** 面板根元素；调用方负责塞进自己的容器。 */
  el: HTMLElement;
  /** 关闭并清理（幂等）。 */
  dispose: () => void;
}

/**
 * 建一个待办面板并开始取数。
 *
 * @param options - 接口基址与关闭回调。
 * @returns 面板根元素与清理函数。
 */
export function createTodoPanel(options: TodoPanelOptions = {}): TodoPanel {
  injectTodoCss();
  const parts = createTodoPanelParts();
  const baseUrl = options.baseUrl ?? TODOS_PATH;
  let disposed = false;
  let busy = false;
  let todos: TodoItem[] = [];

  // 三个函数互相引用（列表回调 → 修改 → 重拉 → 渲染）：mutate / reload 用函数声明提升，
  // 回调里引用它们不会在构造期求值，也就不存在初始化顺序问题。
  const handlers: TodoListHandlers = {
    onToggle: (todo, done) => void mutate(() => patchTodo(todo.id, { done }, baseUrl)),
    onDelete: (todo) => void mutate(() => removeTodo(todo.id, baseUrl)),
  };

  /** 重新拉整张清单：修改一律以宿主返回为准，不在本地猜结果。 */
  async function reload(): Promise<void> {
    const result = await loadTodos(baseUrl);
    if (disposed) return;
    if (!result.ok) {
      setTodoError(parts, result.message);
      // 加载失败时别让空态一直停在「加载中…」。
      parts.empty.textContent = chromeText(getHostLocale(), 'todo.loading');
      parts.empty.hidden = false;
      return;
    }
    todos = result.value;
    setTodoError(parts, null);
    renderTodoList(parts, todos, handlers, Date.now());
  }

  /** 串行执行一次修改：请求在途时禁止再次提交，成功后统一重拉。 */
  async function mutate(task: () => Promise<TodoResult<unknown>>): Promise<void> {
    if (disposed || busy) return;
    busy = true;
    setTodoBusy(parts, true);
    setTodoError(parts, null);
    const result = await task();
    busy = false;
    if (disposed) return;
    setTodoBusy(parts, false);
    if (!result.ok) {
      setTodoError(parts, result.message);
      return;
    }
    await reload();
  }

  /** 提交新增：空正文直接回到输入框。 */
  const submitAdd = (): void => {
    const text = parts.input.value.trim();
    if (text === '') {
      parts.input.focus();
      return;
    }
    // 选择器只会给出 `YYYY-MM-DDTHH:mm` 或空串，解析不出来按无期限处理，不拦提交。
    const dueText = parts.duePicker.value();
    const dueAt = dueText === '' ? null : parseDateTimeLocal(dueText);
    // 先收起日历：错误行在清单那一侧，日历开着时会被折叠区藏起来，报错就看不见了。
    parts.duePicker.close();
    // 过去的时刻建出来就是逾期，提醒一上线就会喊，等于让用户先错一次再改。
    if (dueAt !== null && dueAt < Date.now()) {
      setTodoError(parts, chromeText(getHostLocale(), 'todo.past'));
      return;
    }
    void mutate(async () => {
      const result = await addTodo(text, dueAt, baseUrl);
      if (result.ok) {
        parts.input.value = '';
        parts.duePicker.reset();
      }
      return result;
    });
  };

  parts.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAdd();
  });
  // 点面板外面就收起：面板没有标题栏也没有关闭按钮，收起意图只能靠「点别处」表达。
  // 用 mousedown 而不是 click，并走捕获阶段：拖拽宠物时 pointerdown 会先截走事件，
  // 监听 click 会漏掉「按住拖走」的那一下；捕获阶段保证在页面任何处理之前先判一次。
  // 不写 instanceof Node：shared-core 会被桌面端 lint 当成无 DOM 全局的脚本检查。
  const onDocMouseDown = (event: MouseEvent): void => {
    if (disposed) return;
    const target = event.target as Node | null;
    if (target !== null && parts.root.contains(target)) return;
    // 点宠物本体不算「点别处」：拖它走是常见需求，而拖拽的起点就是这一下。
    if (options.keepOpenOn?.(event.target) === true) return;
    options.onClose?.();
  };
  document.addEventListener('mousedown', onDocMouseDown, true);
  parts.closeButton.addEventListener('click', () => options.onClose?.());
  parts.empty.textContent = chromeText(getHostLocale(), 'todo.loadingShort');
  parts.empty.hidden = false;
  // 不自动聚焦输入框：面板挂在宠物头顶，抢走 DSH 输入框的焦点比少一次点击更烦。
  void reload();

  return {
    el: parts.root,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // 监听必须摘：不摘的话面板关掉后它还会在每次点击时被判一次，等于永久挂着一个死回调。
      document.removeEventListener('mousedown', onDocMouseDown, true);
      parts.duePicker.dispose();
      parts.root.remove();
    },
  };
}
