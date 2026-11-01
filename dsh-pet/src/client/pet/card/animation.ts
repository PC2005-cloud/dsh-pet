/**
 * 一张宠物卡的动画链装配：构造 OwnAnimation、跟随状态换源，并登记挂载期的只读服务。
 * 不负责运动与浮层：走位、拖拽、挤压经装配根的迟绑槽取值，本模块只决定「何时读」。
 * 卸载顺序固定：摘监听 → 注销 pose/progress → dispose 动画链 → 停三套运动。
 * @module dsh-pet/src/client/pet/card/animation
 */
import { createOwnAnimation, type OwnAnimation, type OwnAnimationDeps } from '../animation/animation.ts';
import { registerPose } from '../../pose.ts';
import { playActionSound } from '../../../shared/action-sound.ts';
import { ROUTE_PATH } from '../../../shared/constants.ts';
import { registerProgress } from '../../progress.ts';
import { boxToRatio, centerToBox, clampReachableBox, derivePetMetrics } from '../motion/geometry.ts';
import type { CardLive } from './live.ts';
import type { CardStateApi } from './state.ts';
import type { RuntimePet } from '../types.ts';
import type { LockState } from '../../../shared/state.ts';
import type { WorkStatusSnapshot } from '../../../shared/work-status.ts';
import type * as ReactNS from 'react';

/** 注入的 react 能力。 */
export interface CardAnimationRuntime {
  /** 副作用。 */
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  /** 引用；动画链只造一次。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}

/** 动画链装配的输入；全部是取值函数或稳定引用。 */
export interface CardAnimationInput {
  /** 卡状态：动画名、序号与朝向都从它取。 */
  card: CardStateApi;
  /** 成品配置的最新值。 */
  cfgRef: ReactNS.MutableRefObject<RuntimePet>;
  /** 工作状态的最新值：播完判定要读，回调晚于状态更新。 */
  workStatusRef: ReactNS.MutableRefObject<WorkStatusSnapshot | null>;
  /** 装配根迟绑槽。 */
  live: ReactNS.MutableRefObject<CardLive>;
  /** 新首帧就位后是否补一次 Q 弹（点击互动置位）。 */
  pendingSquash: ReactNS.MutableRefObject<boolean>;
  /** 双缓冲的前台元素。 */
  videoA: () => HTMLVideoElement | null;
  /** 双缓冲的后台元素。 */
  videoB: () => HTMLVideoElement | null;
  /** 点播回执：真实播放结果只有浏览器侧知道。 */
  report: OwnAnimationDeps['report'];
  /** 挂载瞬间的锁叶子：只用于决定动画链初始是否冻结。 */
  lock?: LockState;
  /** 消费掉点播编号，避免 effect 再跑一趟。 */
  setCuePlayback: (id: string | null) => void;
  /** 本宠物 id：挂载期注册只读服务用它。 */
  petId: string;
}

/**
 * 造动画链接配的 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收装配输入的 hook，返回本卡的动画链实例。
 */
export function createCardAnimation(rt: CardAnimationRuntime) {
  const { useEffect, useRef } = rt;

  return function useCardAnimation(input: CardAnimationInput): OwnAnimation {
    const { card, cfgRef, live, pendingSquash, petId, workStatusRef } = input;

    // 动画链只造一次（放进 ref）：它持有 A/B 槽位、世代号与 blob，跨渲染重建会把这些状态清空。
    const ownAnimRef = useRef<OwnAnimation | null>(null);
    ownAnimRef.current ??= createOwnAnimation({
      videoA: input.videoA,
      videoB: input.videoB,
      cfg: () => cfgRef.current,
      currentAnim: () => card.animRef.current,
      workStatus: () => workStatusRef.current,
      facing: () => card.facingRef.current,
      report: input.report,
      clearCuePlayback: () => input.setCuePlayback(null),
      onFrontReady: (el) => {
        // 点击 Q 弹要等新动画就位后才压，压的是新首帧。
        if (pendingSquash.current) {
          pendingSquash.current = false;
          live.current.squash.start(el);
        }
        if (live.current.walk.hasPending()) live.current.walk.start(el);
      },
      onStarted: (anim) => playActionSound(ROUTE_PATH, cfgRef.current.actionSounds, anim),
      onEnded: (cue) => live.current.flow?.applyEndedCue(cue),
      isDragging: () => live.current.drag.isActive(),
      initiallyFrozen: input.lock?.locked === true && input.lock.expiresAt > Date.now(),
    });
    const ownAnim = ownAnimRef.current;
    live.current.ownAnim = ownAnim;

    const { anim, cuePlayback, once, seq } = card.state;

    // 状态驱动播放。
    useEffect(() => {
      ownAnim.switchTo(anim, once, cuePlayback);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由 anim/once/seq/cuePlayback 的换源身份决定；ownAnim 是稳定引用，补它没有意义
    }, [anim, once, seq, cuePlayback]);

    useEffect(() => {
      // 槽对象身份稳定（useRef 一次），字段每渲染就地更新；捕获一份给清理用，避免读 .current。
      const services = live.current;
      // 视口变化要按新尺寸重算根节点位置，否则改窗口大小后宠物停在旧比例上；
      // 重算后再压一次可见下限，缩窗把宠物挤到视口外时能自愈。
      const onResize = () =>
        card.actions.setCustomPos((prev) => {
          if (!prev) return prev;
          // 读 cfgRef 而不是闭包里的 card.state：本效果只注册一次，渲染期快照是初始尺寸。
          const { size } = cfgRef.current;
          const { halfW, halfH, bottomPad } = derivePetMetrics(size);
          const viewport = { width: window.innerWidth, height: window.innerHeight };
          const half = { w: halfW, h: halfH };
          const box = centerToBox(prev, viewport, half);
          // 必须返回新对象：视口变了就得重渲染，返回同一引用 React 会跳过，位置不会重算。
          return { ...boxToRatio(clampReachableBox(box, viewport, { size, bottomPad }), viewport, half) };
        });
      window.addEventListener('resize', onResize);
      // 把本页这只宠物的实时位置与朝向注册给只读服务 petApi7340（见 ../pose）；
      // 消费者按需读闭包，拖拽、抛掷中途也能拿到当前值，不是快照。
      const unregisterPose = registerPose(petId, () => {
        const center = live.current.center();
        return {
          x: center.x / window.innerWidth,
          y: center.y / window.innerHeight,
          facing: card.facingRef.current,
        };
      });
      // 播放进度走同一个 Cordis 入口（见 ../progress）；读前台 video，A/B 切换期间读 back 会跳。
      const unregisterProgress = registerProgress(petId, () => {
        const el = ownAnim.frontVideo();
        const playbackId = ownAnim.playingPlayback();
        const anim = card.animRef.current;
        if (el === null) {
          // 首帧还没挂上元素，给可解析的零值，别让调用方拿到 undefined。
          return { playbackId, anim, currentTime: 0, duration: 0, paused: true, buffering: false };
        }
        // duration 在元数据就绪前是 NaN，统一成 0。
        const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        return {
          playbackId,
          anim,
          currentTime: el.currentTime,
          duration,
          paused: el.paused,
          buffering: el.readyState < 3 || el.seeking,
        };
      });
      return () => {
        window.removeEventListener('resize', onResize);
        unregisterPose(); // 卸载即摘除：静默失效比读到陈旧值安全。
        unregisterProgress();
        ownAnim.dispose(); // 中断在途素材请求并释放 blob，之后本实例不可复用。
        services.stopMove();
        services.drag.stopFollow();
        services.flight.stop();
        services.squash.stop();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载/卸载各跑一次：闭包读的是 refs 与稳定 props
    }, []);

    return ownAnim;
  };
}
