/**
 * 指针拖拽的装配：把当帧能力束成 DragCard，再交给驱动长期持有。
 * 依赖 motion 的运动面与迟绑槽里的动画流、锁与提示——它们创建得更晚，只在回调里读。
 * 只建一次：驱动自带指针状态机与捕获，重建会让按下中的手势丢失。
 * @module dsh-pet/src/client/pet/card/drag
 */
import { createDrag, type Drag, type DragCard } from '../motion/drag.ts';
import { boxToRatio, clampReachableBox } from '../motion/geometry.ts';
import { playClickSound } from '../click-sound.ts';
import type { CardLive } from './live.ts';
import type { CardMotion } from './motion.ts';
import type { CardStateApi } from './state.ts';
import type { RuntimePet } from '../types.ts';
import type * as ReactNS from 'react';

/** 注入的 react 能力。 */
export interface CardDragRuntime {
  /** 副作用；卸载时摘掉驱动的鼠标松开兜底监听。 */
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  /** 引用；拖拽驱动只造一次。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}

/** 拖拽装配的输入。 */
export interface CardDragInput {
  /** 卡状态：动画名与几何的最新值。 */
  card: CardStateApi;
  /** 成品配置的最新值。 */
  cfgRef: ReactNS.MutableRefObject<RuntimePet>;
  /** 装配根迟绑槽。 */
  live: ReactNS.MutableRefObject<CardLive>;
  /** 运动面：飞行、走位、包围盒都经它。 */
  motion: CardMotion;
  /** 宠物根节点。 */
  root: () => HTMLDivElement | null;
  /** 舞台节点：提示与命中的定位基准。 */
  stage: () => HTMLDivElement | null;
  /** 等新首帧就位后再压 Q 弹。 */
  pendingSquash: ReactNS.MutableRefObject<boolean>;
  /** 归一化中心写入口。 */
  setCustomPos: CardStateApi['actions']['setCustomPos'];
  /** 换源播一次。 */
  setOnce: (on: boolean) => void;
  /** 换成指定动画。 */
  setAnim: (anim: string) => void;
  /** 递增换源序号，强制重播。 */
  bumpSeq: () => void;
  /** 拖拽态。 */
  setDragging: (on: boolean) => void;
  /** 悬浮提示显隐。 */
  setTipOn: (on: boolean) => void;
}

/**
 * 造拖拽装配的 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收装配输入的 hook，返回本卡的拖拽驱动。
 */
export function createCardDrag(rt: CardDragRuntime) {
  const { useRef, useEffect } = rt;

  return function useCardDrag(input: CardDragInput): Drag {
    const { bumpSeq, card, cfgRef, live, motion, pendingSquash, root, setAnim, setCustomPos, setDragging } = input;
    const { setOnce, setTipOn, stage } = input;

    // 拖拽驱动每次事件取的当帧能力：逐渲染重建，驱动长期持有这个 getter。
    const dragCard = (): DragCard => {
      const metrics = motion.metrics();
      return {
        petId: cfgRef.current.id,
        size: metrics.size,
        halfW: metrics.halfW,
        halfH: metrics.halfH,
        bottomPad: metrics.bottomPad,
        physics: cfgRef.current.physics,
        // 睡着时不给拖拽动画：可以拖、位置跟手，但保持睡姿（空池 = 驱动退化为只拖不换源）
        dragAnims: (live.current.flow?.sleeping() ?? false) ? [] : cfgRef.current.animations.drag,
        clickAnims: cfgRef.current.animations.clicks,
        // 松手同理：睡着时不给回 idle 的动画，否则拖一下就把睡姿换掉了
        idleAnims: (live.current.flow?.sleeping() ?? false) ? [] : cfgRef.current.animations.idle,
        currentAnim: card.animRef.current,
        setOnce: (on) => setOnce(on),
        playAnim: (name) => setAnim(name),
        bumpSeq: () => bumpSeq(),
        markSquash: () => {
          pendingSquash.current = true;
        },
        setDragging,
        resumeWork: () => live.current.flow?.resumeWorkStatusAnim() ?? false,
        stopAutonomy: () => motion.stopMove(),
        stopFlight: () => motion.flight.stop(),
        startFlight: motion.startThrow,
        isFrozen: () => live.current.ownAnim.isFrozen(),
        releaseLock: () => live.current.releaseLock(),
        grabVelocity: () => (motion.flight.isFlying() ? motion.flight.velocity() : null),
        playClickSound: () => playClickSound(),
        tipOn: () => live.current.tipOn(),
        placeTip: (x, y) => live.current.placeTip(x, y),
        setTipOn,
        stage,
        root,
        box: () => motion.box(),
        setBox: (box) => motion.setBox(box),
        commitPlace: (box) => {
          const metrics = motion.metrics();
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          const half = { w: metrics.halfW, h: metrics.halfH };
          const reached = clampReachableBox(box, viewport, metrics);
          // 拖拽期间 follow 直接改 DOM；夹取后的比例可能与上次渲染相同，React 会跳过 style 写入。
          const rootEl = root();
          if (rootEl) {
            rootEl.style.left = reached.x + 'px';
            rootEl.style.top = reached.y + 'px';
            rootEl.style.right = 'auto';
            rootEl.style.bottom = 'auto';
          }
          motion.setBox(reached);
          setCustomPos(boxToRatio(reached, viewport, half));
        },
      };
    };

    const dragRef = useRef<Drag | null>(null);
    dragRef.current ??= createDrag(dragCard);
    const drag = dragRef.current;
    // 卸载即摘掉 window 上的鼠标松开兜底：驱动活得比卡片久，不摘会打到已卸掉的节点。
    useEffect(() => () => drag.dispose(), [drag]);
    live.current.drag = drag;
    return drag;
  };
}
