/**
 * 说话气泡的收起时机：合成期间挂起计时，播完再留一小段尾巴。
 * 纯状态机：只给出「下一次该等多少毫秒」，计时器与渲染由两端各自持有。
 * 不决定这一句该不该念——那是 {@link module:dsh-pet/src/shared/voice} 的门禁。
 * @module dsh-pet/src/shared/bubble-hold
 */

/** 播完（或失败）后再留这么久，让人看完最后一个字（ms）。 */
export const BUBBLE_HOLD_TAIL_MS = 1_500;

/**
 * 一句播报最多把气泡挂多久（ms）。
 *
 * 口径是「合成超时 + 截断后可念的最长语音 + 尾巴」再留余量：超过它说明语音那条线
 * 已经断了，气泡不能跟着一起挂死。
 */
export const BUBBLE_HOLD_MAX_MS = 50_000;

/** 收起计划的事件；`seq` 是播报序号，用来丢弃迟到的「上一句播完了」。 */
export type BubbleHoldEvent =
  | { readonly kind: 'show'; readonly durationMs: number }
  | { readonly kind: 'hold'; readonly seq: number }
  | { readonly kind: 'release'; readonly seq: number }
  | { readonly kind: 'hide' }
  | { readonly kind: 'clear' };

/** 气泡的计时状态；`delayMs` 为 null 表示不设自动收起，等下一个事件。 */
export interface BubbleHoldState {
  readonly on: boolean;
  /** 正在等的播报序号；null = 没在等语音。 */
  readonly holdSeq: number | null;
  /** 下一次自动收起还要等多久（ms）；null = 不设计时器。 */
  readonly delayMs: number | null;
}

/** 收起状态的初值；两端都从这里开始。 */
export const BUBBLE_HOLD_IDLE: BubbleHoldState = { on: false, delayMs: null, holdSeq: null };

/**
 * 推进一步。
 *
 * 气泡没点亮时 `hold` 与 `release` 一律忽略：那说明这一句没有气泡可挂
 * （`duration: 0` 或已经被清空），让它们点亮气泡会凭空多出一个泡。
 *
 * @param state - 当前状态。
 * @param event - 这一次发生了什么。
 * @returns 新状态；无事发生时返回同一引用，调用方据此跳过重排计时器。
 */
export function reduceBubbleHold(state: BubbleHoldState, event: BubbleHoldEvent): BubbleHoldState {
  if (event.kind === 'show') return { delayMs: Math.max(0, event.durationMs), holdSeq: null, on: true };
  if (event.kind === 'clear') return BUBBLE_HOLD_IDLE;
  if (event.kind === 'hide') return state.on ? BUBBLE_HOLD_IDLE : state;
  if (!state.on) return state;
  if (event.kind === 'hold') {
    if (state.holdSeq === event.seq) return state; // 同一句重复通知：不重置上限
    return { delayMs: BUBBLE_HOLD_MAX_MS, holdSeq: event.seq, on: true };
  }
  // release 只认当前这句：上一句迟到的收尾不能把这一句的等待提前结束。
  if (state.holdSeq !== event.seq) return state;
  return { delayMs: BUBBLE_HOLD_TAIL_MS, holdSeq: null, on: true };
}
