/**
 * 对话输入框「回车发送」的判据：只有真按回车、且输入法没在管这个键时才发。
 * 桌面端与浏览器端共用；组合态由 compositionstart / compositionend 转进来，本模块不碰 DOM、不读时钟。
 * @module dsh-pet/src/shared/chat/enter
 */

/** 组合结束后仍算「上屏那一下」的静默窗（ms）：Safari 会先 compositionend 再派发 keydown。 */
export const COMPOSITION_SETTLE_MS = 80;

/** 判定要读的键盘字段；原生 KeyboardEvent 与测试里的普通对象都能直接传。 */
export interface EnterKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  /** 组合中按下的键：Chromium 与 Safari 标 true。 */
  readonly isComposing?: boolean;
  /** 输入法吞键时的老标志（Windows）。 */
  readonly keyCode?: number;
  /** 长按产生的自动重复。 */
  readonly repeat?: boolean;
}

/** 一个输入框的输入法组合态；持有方负责把两个组合事件转进来。 */
export interface CompositionWatch {
  /** compositionstart：进入组合。 */
  readonly start: () => void;
  /** compositionend：记下结束时刻。 */
  readonly end: (at: number) => void;
  /** 此刻是否正在组合。 */
  readonly isComposing: () => boolean;
  /** 是否刚结束组合、还在静默窗内。 */
  readonly endedWithin: (now: number) => boolean;
}

/**
 * 一次回车该怎么处理。
 *
 * `swallow` 与 `ignore` 都不发送，差别在拦不拦默认行为：前者是「这个回车没用了」（长按重复、
 * 上屏那一下），拦下来才不会被当成换行；后者是「这个键另有主人」（组合中、Shift+回车）。
 */
export type EnterAction = 'send' | 'swallow' | 'ignore';

/**
 * 造一个空组合态。
 *
 * @returns 供 `compositionstart` / `compositionend` 与 {@link decideEnter} 共用的句柄。
 */
export function createCompositionWatch(): CompositionWatch {
  let composing = false;
  // 用 -Infinity 当「从未结束过」：任何时刻的静默窗判定都为假，不必额外分支
  let endedAt = Number.NEGATIVE_INFINITY;
  return {
    start: () => {
      composing = true;
    },
    end: (at) => {
      composing = false;
      endedAt = at;
    },
    isComposing: () => composing,
    endedWithin: (now) => now - endedAt < COMPOSITION_SETTLE_MS,
  };
}

/**
 * 这一次回车归谁。
 *
 * @param event - 键盘事件里与输入法相关的字段。
 * @param watch - 这个输入框的组合态。
 * @param now - 当前时刻（ms），必须与 {@link CompositionWatch.end} 用同一时钟。
 * @returns `send` 发送；`swallow` 拦下默认行为但不发；`ignore` 不干预（输入法或换行自己处理）。
 */
export function decideEnter(event: EnterKeyEvent, watch: CompositionWatch, now: number): EnterAction {
  if (event.key !== 'Enter' || event.shiftKey) return 'ignore';
  // 组合中的回车归输入法：此时 preventDefault 可能打断上屏，连拦都不拦
  if (event.isComposing === true || event.keyCode === 229 || watch.isComposing()) return 'ignore';
  // 长按产生的重复回车：既不该发送，也不该每一下插一个换行
  if (event.repeat === true) return 'swallow';
  // 刚上屏那一下：组合已经提交，拦下默认行为只是别留下一个空行
  if (watch.endedWithin(now)) return 'swallow';
  return 'send';
}
