/**
 * 动画链的两个判定结果与「播完之后做什么」的纯决策。
 *
 * 只回答「这一段播完了该进哪条分支」，不碰 DOM、不读时钟、不上报回执——
 * 回执与停顿门禁由动画链处理，React 状态由组件按结果改。
 * @module dsh-pet/src/client/pet/animation/cues
 */
import { isEventAnim, nextWorkStatusAnim, poolIncludes } from '../../../shared/pickers.ts';
import type { Animations } from '../../../shared/types.ts';

/** 播完之后该做什么。 */
export type EndedCue =
  | { kind: 'ignore' }
  | { kind: 'work-rotate'; anim: string }
  | { kind: 'work-replay' }
  | { kind: 'event-done' }
  | { kind: 'turn' }
  | { kind: 'interaction-done' }
  | { kind: 'random' };

/** 冻结状态翻转。 */
export type FreezeCue = { kind: 'frozen' } | { kind: 'resumed' };

/** 播完判定的输入。 */
export interface EndedInput {
  /** 该宠物的动画池。 */
  animations: Animations;
  /** 刚播完的动画名。 */
  current: string;
  /** 当前工作状态；`undefined` 表示还没收到过。 */
  workState: string | null | undefined;
}

/** 工作状态是否处在「非终态」：终态（success / error）与空闲都不续播档位动画。 */
const isWorkActive = (state: string | null | undefined): boolean =>
  state !== null && state !== undefined && state !== 'success' && state !== 'error';

/**
 * 决定播完之后进哪条分支。
 *
 * @param input - 动画池、刚播完的动画与当前工作状态。
 * @returns 分支判定；拖拽中与冻结由调用方在更前面拦掉。
 */
export function decideEndedCue(input: EndedInput): EndedCue {
  const { animations, current, workState } = input;
  const isEvent = isEventAnim(animations.events, current);
  if (isEvent && isWorkActive(workState)) {
    // 多候选档位播完轮换到下一候选，长时间状态不单段重复。
    const nextWork = nextWorkStatusAnim(animations.events?.workStatus ?? [], current);
    if (nextWork !== null) return { kind: 'work-rotate', anim: nextWork };
    // 单候选档位意外 ended 时续播同一段。
    if (poolIncludes(animations.events?.workStatus ?? [], current)) return { kind: 'work-replay' };
  }
  if (isEvent) return { kind: 'event-done' };
  if (animations.turn.includes(current)) return { kind: 'turn' };
  if (
    animations.drag.includes(current) ||
    animations.clicks.includes(current) ||
    (animations.dizzy ?? []).includes(current)
  ) {
    return { kind: 'interaction-done' };
  }
  return { kind: 'random' };
}
