/**
 * 气泡单槽：余额、说话、工作状态三种气泡的显隐、停留计时与优先级选择。
 * 不负责何时点亮与动画联动：tick 判定、抽动画、打日志都在 PetCard；也不负责外观，哑组件在 client/bubble.ts。
 * 依赖注入的 react 与两个气泡组件；三个停留计时器都归本模块清理。
 * 不变量：同一时刻只渲染一个气泡，优先级依次为终态任务、说话、余额、非终态任务。
 * @module dsh-pet/src/client/pet/card/bubble-slots
 */
import { balancePageCount as balancePageCountOf, type BalanceState } from '../../../shared/balance/index.ts';
import {
  BUBBLE_HOLD_IDLE,
  reduceBubbleHold,
  type BubbleHoldEvent,
  type BubbleHoldState,
} from '../../../shared/bubble-hold.ts';
import { subscribeVoiceState, subscribeVoiceUtterance, type VoiceState } from '../../../shared/voice.ts';
import { BUBBLE_DURATION_MS } from '../timings.ts';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 当前该挂哪个气泡；`none` 表示哪个条件都不成立。 */
export type BubbleSlot = 'todo' | 'work-terminal' | 'whisper' | 'balance' | 'work' | 'none';

/** 优先级判定的输入：全部是渲染期的既成事实，判定本身不产生副作用。 */
export interface BubbleSlotInput {
  /** 待办面板是否打开；打开时独占槽位，其余气泡一律让位。 */
  todoOn: boolean;
  /** 工作状态是否为终态（success / error）。 */
  workTerminal: boolean;
  /** 工作气泡是否点亮。 */
  workOn: boolean;
  /** 工作气泡文本。 */
  workText: string | null;
  /** 配置是否启用工作状态联动。 */
  workStatusEnabled: boolean;
  /** 说话气泡是否点亮。 */
  whisperOn: boolean;
  /** 说话气泡文本。 */
  whisperText: string | null;
  /** 余额气泡是否点亮。 */
  balanceOn: boolean;
  /** 余额数据是否已拉到；null 表示尚未拉到。 */
  balanceAvailable: boolean;
  /** 配置是否启用余额。 */
  balanceEnabled: boolean;
  /** 本次余额是否手动请求；手动请求不受开关门控。 */
  balanceManual: boolean;
}

/**
 * 决定当前挂哪个气泡。
 *
 * 终态任务只活 10s，所以不让位；非终态常驻，让位 10s 没有损失。
 *
 * @param input - 三种气泡的显隐与开关。
 * @returns 命中的槽位；都不成立时为 `none`。
 */
export function decideBubbleSlot(input: BubbleSlotInput): BubbleSlot {
  // 面板是用户主动打开的窗口：它占槽时其余气泡一律让位，关掉后按原规则恢复。
  if (input.todoOn) return 'todo';
  if (input.workTerminal && input.workOn && input.workText && input.workStatusEnabled) return 'work-terminal';
  if (input.whisperOn && input.whisperText) return 'whisper';
  if (input.balanceOn && input.balanceAvailable && (input.balanceEnabled || input.balanceManual)) return 'balance';
  if (input.workOn && input.workText && input.workStatusEnabled) return 'work';
  return 'none';
}

/**
 * 余额气泡的可翻页数。
 *
 * 页数规则归 shared（与每页内容同源），这里只补一个「还没有结果」的兜底。
 *
 * @param balance - 最近一次余额结果；`null` 表示这一拍还没有数据。
 * @returns 页数，至少 1。
 */
export function balancePageCount(balance: BalanceState | null): number {
  return balance ? balancePageCountOf(balance) : 1;
}

/** 余额气泡组件；props 与 `client/bubble.ts` 的 BalanceBubble 一致。 */
export type BalanceBubbleComponent = (props: {
  state: BalanceState;
  on: boolean;
  index: number;
  onCycle: () => void;
}) => ReactNode;

/** 说话气泡组件；配图二选一，props 与 `client/bubble.ts` 的 WhisperBubble 一致。 */
export type WhisperBubbleComponent = (props: {
  text: string;
  image?: string;
  url?: string;
  assetRoot?: string;
  on: boolean;
}) => ReactNode;

/** 注入的 react 能力。 */
export interface BubbleSlotsRuntime {
  /** 创建元素。 */
  h: typeof jsx;
  /** 状态。 */
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  /** 引用。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
  /** 副作用；用于卸载时清计时器。 */
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
}

/** 待办面板气泡组件；props 与 `client/todo-bubble.ts` 的 TodoBubble 一致。 */
export type TodoBubbleComponent = (props: { on: boolean; onClose: () => void }) => ReactNode;

/** 三种气泡组件。 */
export interface BubbleComponents {
  /** 余额气泡。 */
  balanceBubble: BalanceBubbleComponent;
  /** 待办面板气泡。 */
  todoBubble: TodoBubbleComponent;
  /** 说话气泡。 */
  whisperBubble: WhisperBubbleComponent;
}

/** 每次渲染由 PetCard 提供的视图输入。 */
export interface BubbleSlotsInput {
  /** 最近一次余额结果。 */
  balance: BalanceState | null;
  /** 配置是否启用余额。 */
  balanceEnabled: boolean;
  /** 本次余额是否手动请求。 */
  balanceManual: boolean;
  /** 配置是否启用工作状态联动。 */
  workStatusEnabled: boolean;
  /** 工作状态是否处于终态。 */
  workTerminal: boolean;
  /** 说话气泡配图的素材根。 */
  assetRoot?: string;
}

/** 气泡单槽对外的读写面。 */
export interface BubbleSlots {
  /** 点亮余额气泡并回到第一页，重置停留计时。 */
  showBalance(): void;
  /** 点余额气泡翻页，并重置停留计时。 */
  cycleBalance(): void;
  /** 点亮说话气泡；duration 为 0 时不改动当前气泡，undefined 用默认时长。 */
  showWhisper(text: string, parts: { image?: string; url?: string }, duration?: number): void;
  /** 收起说话气泡；不碰动画与另两种气泡。 */
  clearWhisper(): void;
  /** 更新工作气泡文本，显隐不动。 */
  updateWorkText(text: string | null): void;
  /** 点亮工作气泡；terminal 决定 10s 后自动收起，非终态常驻。 */
  lightWork(terminal: boolean): void;
  /** 收起工作气泡但保留文本。 */
  hideWork(): void;
  /** 回空闲：收起工作气泡并清文本。 */
  resetWork(): void;
  /** 打开待办面板：它独占槽位，其余气泡让位。 */
  showTodo(): void;
  /** 收起待办面板，按原优先级恢复其余气泡。 */
  hideTodo(): void;
  /** 开关待办面板：已开则收起，供快捷键使用。 */
  toggleTodo(): void;
  /** 按优先级渲染当前该挂的气泡；无气泡时为 null。 */
  node(): ReactNode;
}

/**
 * 制造气泡单槽的 hook，每个 PetCard 调一次。
 *
 * @param rt - 注入的 react 能力。
 * @param components - 余额与说话气泡组件。
 * @returns 接收视图输入的 hook；钩子内部的状态与计时器随卡片卸载一并清理。
 */
export function createBubbleSlots(rt: BubbleSlotsRuntime, components: BubbleComponents) {
  const { h, useState, useRef, useEffect } = rt;
  const BalanceBubble = components.balanceBubble;
  const TodoBubble = components.todoBubble;
  const WhisperBubble = components.whisperBubble;

  return function useBubbleSlots(input: BubbleSlotsInput): BubbleSlots {
    // 余额气泡：显隐与展开页。
    const [balanceOn, setBalanceOn] = useState(false);
    const [balancePage, setBalancePage] = useState(0);
    const balanceTimerRef = useRef<number | null>(null);
    // 说话气泡：显隐、文本与配图（池内名与完整地址二选一）。收起时机在 bubbleHoldRef：
    // 语音合成期间挂起计时，播完再留一小段尾巴（见 shared/bubble-hold）。
    const [whisperOn, setWhisperOn] = useState(false);
    const [whisperText, setWhisperText] = useState<string | null>(null);
    const [whisperImage, setWhisperImage] = useState<string | undefined>(undefined);
    const [whisperUrl, setWhisperUrl] = useState<string | undefined>(undefined);
    const whisperHoldRef = useRef<BubbleHoldState>(BUBBLE_HOLD_IDLE);
    const whisperTextRef = useRef<string | null>(null);
    const whisperTimerRef = useRef<number | null>(null);
    // 待办面板：独占槽位，没有停留计时，显隐只由用户开关。
    const [todoOn, setTodoOn] = useState(false);
    // 工作状态气泡：显隐与文本。
    const [workOn, setWorkOn] = useState(false);
    const [workText, setWorkText] = useState<string | null>(null);
    const workTimerRef = useRef<number | null>(null);
    // 语音播报状态：只在手动触发的那一句上有值，气泡据此显示转圈 / 喇叭
    const [voiceState, setVoiceState] = useState<VoiceState>('idle');

    // 订阅是模块级单例：卸载时必须退订，否则旧卡片会被后续状态推送重渲染
    useEffect(() => subscribeVoiceState(setVoiceState), []);

    // 卸载后不再 setState：三个计时器都在这里清。
    useEffect(
      () => () => {
        if (balanceTimerRef.current !== null) window.clearTimeout(balanceTimerRef.current);
        if (whisperTimerRef.current !== null) window.clearTimeout(whisperTimerRef.current);
        if (workTimerRef.current !== null) window.clearTimeout(workTimerRef.current);
      },
      [],
    );

    /** 重置余额气泡的停留计时；重复触发先清旧定时器，否则旧的会提前收起。 */
    const armBalanceTimeout = () => {
      if (balanceTimerRef.current !== null) window.clearTimeout(balanceTimerRef.current);
      balanceTimerRef.current = window.setTimeout(() => setBalanceOn(false), BUBBLE_DURATION_MS);
    };

    const showBalance = () => {
      setBalancePage(0); // 新一轮查询从第一页开始。
      setBalanceOn(true);
      armBalanceTimeout();
    };

    const cycleBalance = () => {
      const pages = balancePageCount(input.balance);
      setBalancePage((page) => (page + 1) % pages);
      // 重新计时：第 8 秒点开才剩 2 秒，看不清下一页。
      armBalanceTimeout();
    };

    /** 推进说话气泡的收起计划，并按新计划重排计时器。 */
    const applyWhisperHold = (event: BubbleHoldEvent): void => {
      const next = reduceBubbleHold(whisperHoldRef.current, event);
      if (next === whisperHoldRef.current) return; // 同引用 = 无事发生，别白白重排计时器
      whisperHoldRef.current = next;
      setWhisperOn(next.on);
      if (whisperTimerRef.current !== null) window.clearTimeout(whisperTimerRef.current);
      whisperTimerRef.current = null;
      if (next.delayMs === null) return;
      whisperTimerRef.current = window.setTimeout(() => {
        whisperTimerRef.current = null;
        applyWhisperHold({ kind: 'hide' });
      }, next.delayMs);
    };

    // 语音报开始/结束时推进收起计划：合成慢的时候气泡得挂住，播完再收。
    // 只认文本相同的那一句——同一页面上的其他宠物共用这份模块单例状态。
    useEffect(
      () =>
        subscribeVoiceUtterance((event) => {
          if (event.text !== whisperTextRef.current) return;
          applyWhisperHold({ kind: event.kind === 'start' ? 'hold' : 'release', seq: event.seq });
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 订阅只建一次：收起计划全部经 ref 现读，重订阅只会漏事件
      [],
    );

    const showWhisper = (text: string, parts: { image?: string; url?: string }, duration?: number) => {
      if (duration === 0) return; // 只联动动画、不改气泡时走这里。
      setWhisperText(text);
      whisperTextRef.current = text;
      setWhisperImage(parts.image);
      setWhisperUrl(parts.url);
      applyWhisperHold({ durationMs: duration ?? BUBBLE_DURATION_MS, kind: 'show' });
    };

    const clearWhisper = () => {
      whisperTextRef.current = null;
      setWhisperText(null);
      setWhisperImage(undefined);
      applyWhisperHold({ kind: 'clear' });
    };

    const lightWork = (terminal: boolean) => {
      setWorkOn(true);
      if (workTimerRef.current !== null) window.clearTimeout(workTimerRef.current);
      // 非终态常驻，不设自动收起。
      workTimerRef.current = terminal ? window.setTimeout(() => setWorkOn(false), BUBBLE_DURATION_MS) : null;
    };

    const hideWork = () => {
      if (workTimerRef.current !== null) window.clearTimeout(workTimerRef.current);
      workTimerRef.current = null;
      setWorkOn(false);
    };

    const resetWork = () => {
      hideWork();
      setWorkText(null);
    };

    const showTodo = (): void => setTodoOn(true);
    const hideTodo = (): void => setTodoOn(false);
    const toggleTodo = (): void => setTodoOn((on) => !on);

    const node = (): ReactNode => {
      const slot = decideBubbleSlot({
        todoOn,
        workTerminal: input.workTerminal,
        workOn,
        workText,
        workStatusEnabled: input.workStatusEnabled,
        whisperOn,
        whisperText,
        balanceOn,
        balanceAvailable: input.balance !== null,
        balanceEnabled: input.balanceEnabled,
        balanceManual: input.balanceManual,
      });
      if (slot === 'todo') return h(TodoBubble, { on: todoOn, onClose: hideTodo });
      if (slot === 'balance') {
        return input.balance === null
          ? null
          : h(BalanceBubble, { state: input.balance, on: balanceOn, index: balancePage, onCycle: cycleBalance });
      }
      if (slot === 'whisper') {
        return whisperText === null
          ? null
          : h(WhisperBubble, {
              text: whisperText,
              image: whisperImage,
              url: whisperUrl,
              assetRoot: input.assetRoot,
              on: whisperOn,
              voiceState,
            });
      }
      // 终态与非终态共用同一个组件，差别只在停留时长与优先级。
      if (slot === 'work' || slot === 'work-terminal') {
        return workText === null ? null : h(WhisperBubble, { text: workText, on: workOn });
      }
      return null;
    };

    return {
      clearWhisper,
      cycleBalance,
      hideTodo,
      hideWork,
      lightWork,
      node,
      resetWork,
      showBalance,
      showTodo,
      showWhisper,
      toggleTodo,
      updateWorkText: setWorkText,
    };
  };
}
