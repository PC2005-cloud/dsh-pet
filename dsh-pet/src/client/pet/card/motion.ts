/**
 * 一张宠物卡的运动装配：包围盒、几何、自主走位、抛掷飞行、位置跟随与碰撞站场。
 * 不负责指针与菜单：拖拽驱动经迟绑槽回读，避免与运动驱动形成构造期环。
 * 三套驱动都只建一次，rAF 句柄与世代号在驱动内部，跨渲染存活。
 * @module dsh-pet/src/client/pet/card/motion
 */
import { createFlight, type Flight, type FlightMetrics } from '../motion/flight.ts';
import { createPositionFollow, type PositionFollow } from '../motion/position-follow.ts';
import { createSquashDriver, type SquashDriver } from '../motion/squash.ts';
import { createWalk, type Walk } from '../motion/walk.ts';
import { boxToRatio, centerToBox, clampPetBox, type BoxPoint } from '../motion/geometry.ts';
import { landingSquash, throwVelocity } from '../../../shared/physics.ts';
import type { CardLive } from './live.ts';
import type { CardStateApi } from './state.ts';
import type { MovesConfig } from '../../../shared/types.ts';
import type { PetCollisionSlot } from '../../../shared/physics.ts';
import type { RuntimePet } from '../types.ts';
import type * as ReactNS from 'react';

/** 注入的 react 能力。 */
export interface CardMotionRuntime {
  /** 副作用；碰撞站场注册与注销。 */
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  /** 引用；三套驱动只造一次。 */
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
}

/** 运动装配的输入。 */
export interface CardMotionInput {
  /** 卡状态：自定义位置、朝向与动画名的最新值。 */
  card: CardStateApi;
  /** 成品配置的最新值。 */
  cfgRef: ReactNS.MutableRefObject<RuntimePet>;
  /** 宠物间碰撞站场。 */
  arena: ReactNS.MutableRefObject<{ slots: Record<string, PetCollisionSlot> }>;
  /** 装配根迟绑槽。 */
  live: ReactNS.MutableRefObject<CardLive>;
  /** 当帧几何（配置尺寸推出来）。 */
  metrics: FlightMetrics;
  /** 该宠物的走位池。 */
  moves: MovesConfig;
  /** 本宠物 id：碰撞槽键与飞行排除自己都用它。 */
  petId: string;
  /** 宠物根节点。 */
  root: () => HTMLDivElement | null;
  /** 落位后提交归一化中心，交给 React 重排。 */
  setCustomPos: CardStateApi['actions']['setCustomPos'];
  /** 换成走路动作并播一次。 */
  setOnce: (on: boolean) => void;
  /** 换成指定动画。 */
  setAnim: (anim: string) => void;
}

/** 运动装配的产物：其它模块按需取用，不缓存整份。 */
export interface CardMotion {
  /** 当帧几何。 */
  metrics: () => FlightMetrics;
  /** 当前宠物中心的视口坐标。 */
  center: () => { x: number; y: number };
  /** 当前包围盒位置。 */
  box: () => { x: number; y: number } | null;
  /** 写回包围盒位置。 */
  setBox: (box: { x: number; y: number }) => void;
  /** 原地放下：约束身体命中区并同步实时位置与视图。 */
  place: (box: BoxPoint) => void;
  /** 停走位与位置跟随。 */
  stopMove: () => void;
  /** 从给定左上角与初速起飞。 */
  startThrow: (px: number, py: number, vx: number, vy: number) => void;
  /** 抛掷指令：角度（度）与力度倍率。 */
  applyThrow: (angleDeg: number, power: number) => void;
  /** 被别的宠物撞到：从落点以新初速抛出。 */
  onPetHit: (vx: number, vy: number) => void;
  /** 自主走位。 */
  walk: Walk;
  /** 抛掷飞行。 */
  flight: Flight;
  /** 位置跟随。 */
  posFollow: PositionFollow;
  /** Q 弹挤压。 */
  squash: SquashDriver;
}

/**
 * 造运动装配的 hook。
 *
 * @param rt - 注入的 react 能力。
 * @returns 接收装配输入的 hook，返回本卡的运动驱动面。
 */
export function createCardMotion(rt: CardMotionRuntime) {
  const { useEffect, useRef } = rt;

  return function useCardMotion(input: CardMotionInput): CardMotion {
    const { arena, card, cfgRef, live, metrics, moves, petId, root, setAnim, setOnce, setCustomPos } = input;

    /** 当帧走位参数：走位驱动长期持有，每渲染就地更新，避免把尺寸与动画池闭包进旧实例。 */
    const motionRef = useRef<FlightMetrics>(metrics);
    motionRef.current = metrics;
    const movesRef = useRef<MovesConfig>(moves);
    movesRef.current = moves;

    /** 包围盒：与拖拽、飞行共享，谁动谁写回。 */
    const boxRef = useRef<{ x: number; y: number } | null>(null);
    const layout = () => ({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      half: { w: motionRef.current.halfW, h: motionRef.current.halfH },
    });
    const layoutRef = useRef(layout());

    const place = (box: BoxPoint): void => {
      const currentLayout = layout();
      const { viewport, half } = currentLayout;
      if (viewport.width <= 0 || viewport.height <= 0) return;
      const placed = clampPetBox(box, viewport, motionRef.current.size);
      const center = boxToRatio(placed, viewport, half);
      layoutRef.current = currentLayout;
      boxRef.current = placed;
      card.customPosRef.current = center;
      const rootEl = root();
      if (rootEl) {
        rootEl.style.left = placed.x + 'px';
        rootEl.style.top = placed.y + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
      }
      setCustomPos(center);
    };

    // Q 弹挤压：rAF 句柄与世代号在驱动内部，镜像按当前朝向复原。
    const squashRef = useRef<SquashDriver | null>(null);
    squashRef.current ??= createSquashDriver({ facing: () => card.facingRef.current });
    const squash = squashRef.current;

    /** 当前宠物中心的视口 X 坐标。 */
    const currentCenterX = (): number => {
      const cp = card.customPosRef.current;
      if (cp) return cp.rx * window.innerWidth;
      const rootEl = root();
      if (rootEl) return rootEl.getBoundingClientRect().left + motionRef.current.halfW;
      return window.innerWidth - 24 - motionRef.current.halfW;
    };
    /** 当前宠物中心的视口 Y 坐标。 */
    const currentCenterY = (): number => {
      const cp = card.customPosRef.current;
      if (cp) return cp.ry * window.innerHeight;
      const rootEl = root();
      if (rootEl) return rootEl.getBoundingClientRect().top + motionRef.current.halfH;
      return window.innerHeight - 20 - motionRef.current.halfH;
    };

    const walkRef = useRef<Walk | null>(null);
    walkRef.current ??= createWalk({
      root,
      center: () => ({ x: currentCenterX(), y: currentCenterY() }),
      metrics: () => motionRef.current,
      moves: () => movesRef.current,
      facing: () => card.facingRef.current,
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      isFlying: () => flightRef.current?.isFlying() ?? false,
      play: (name) => {
        setOnce(true);
        setAnim(name);
      },
      setBox: (box) => {
        boxRef.current = box;
      },
      commit: setCustomPos,
    });
    const walk = walkRef.current;

    /** 停止自主走位与位置跟随。 */
    const stopMove = (): void => {
      walkRef.current?.stop();
      // 位置跟随的弹簧也是自主移动，停走路时必须一并停掉，否则两套运动同时改 DOM 位置。
      posFollowRef.current?.stop();
    };

    const flightRef = useRef<Flight | null>(null);
    flightRef.current ??= createFlight({
      root,
      metrics: () => motionRef.current,
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      physics: () => cfgRef.current.physics,
      arena: () => arena.current,
      petId,
      box: () => boxRef.current,
      setBox: (box) => {
        boxRef.current = box;
      },
      commitLive: (center) => {
        card.customPosRef.current = center;
      },
      commitFinal: setCustomPos,
      onLanding: (impactVy) => {
        // 落地 Q 弹压的是新首帧：等前台视频就位后再压。
        const frontEl = live.current.ownAnim.frontVideo();
        if (frontEl) live.current.squash.start(frontEl, landingSquash(impactVy));
      },
    });
    const flight = flightRef.current;

    /** 从给定左上角与初速起飞；先停弹簧跟随与走位，免得两套运动同时改位置。 */
    const startThrow = (px: number, py: number, vx: number, vy: number): void => {
      live.current.drag.stopFollow();
      stopMove();
      flight.start(px, py, vx, vy);
    };
    /** 最新的 startThrow 引用，供碰撞回调转发，避免陈旧闭包。 */
    const startThrowLatestRef = useRef<(px: number, py: number, vx: number, vy: number) => void>(() => {});
    startThrowLatestRef.current = startThrow;

    const posFollowRef = useRef<PositionFollow | null>(null);
    posFollowRef.current ??= createPositionFollow({
      root,
      box: () => boxRef.current,
      setBox: (box) => {
        boxRef.current = box;
      },
      commit: setCustomPos,
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      half: () => ({ w: motionRef.current.halfW, h: motionRef.current.halfH }),
      spring: () => cfgRef.current.physics.throwPower,
      isDragging: () => live.current.drag.isActive(),
      takeOver: () => {
        flightRef.current?.stop();
        walkRef.current?.stop();
        posFollowRef.current?.stop();
      },
    });
    const posFollow = posFollowRef.current;

    // 位置与抛掷指令：seq 变化即执行，复用既有运动路径，不新写运动学。
    /** 执行抛掷指令：角度（度，0 为正右，逆时针为正）与力度倍率换算成初速度，交给 startThrow。
     *  下游物理全部复用，不设死区。
     */
    const applyThrow = (angleDeg: number, power: number): void => {
      if (live.current.drag.isActive()) return; // 用户交互优先。
      const { vx, vy } = throwVelocity(angleDeg, power);
      const box = boxRef.current ?? {
        x: currentCenterX() - motionRef.current.halfW,
        y: currentCenterY() - motionRef.current.halfH,
      };
      startThrow(box.x, box.y, vx, vy);
    };
    /** 被撞回调：停当前动作，从落点以新初速抛出去。 */
    const onPetHit = (vx: number, vy: number): void => {
      stopMove();
      live.current.drag.stopFollow();
      flight.stop();
      const bx = boxRef.current;
      let sx = 0;
      let sy = 0;
      if (bx) {
        sx = bx.x;
        sy = bx.y;
      } else {
        const r = root()?.getBoundingClientRect();
        if (r) {
          sx = r.left;
          sy = r.top;
        }
      }
      startThrowLatestRef.current(sx, sy, vx, vy);
    };

    const { size, bottomPad } = metrics;
    useEffect(() => {
      const reflow = (): void => {
        const currentLayout = layout();
        if (currentLayout.viewport.width <= 0 || currentLayout.viewport.height <= 0) return;
        const previousLayout = layoutRef.current;
        layoutRef.current = currentLayout;
        let center = card.customPosRef.current;
        const box = boxRef.current;
        // 走位与位置跟随只在收尾提交中心；途中从旧布局的实时盒恢复比例。
        // 回到角落后 React 会清空内联 left，此时忽略上一次运动遗留的盒。
        if (box && (center || root()?.style.left)) {
          center = boxToRatio(box, previousLayout.viewport, previousLayout.half);
        }
        if (!center || live.current.drag.isActive()) return;
        // 运动驱动持有起跑时的边界，先停旧帧，避免下一帧写回旧视口外。
        stopMove();
        flight.stop();
        place(centerToBox(center, currentLayout.viewport, currentLayout.half));
      };
      reflow();
      window.addEventListener('resize', reflow);
      return () => window.removeEventListener('resize', reflow);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 尺寸变化重排；其余输入经 refs 或稳定 setter 读取，resize 每次读取最新视口
    }, [size]);

    // 碰撞站场注册：getVel 取最新抛掷状态，onHit 经 ref 转发，避免陈旧闭包。
    useEffect(() => {
      const arenaSlots = arena.current.slots;
      arenaSlots[petId] = {
        size,
        bottomPad,
        getBox: () => {
          if (boxRef.current) return boxRef.current;
          const r = root()?.getBoundingClientRect();
          return r ? { x: r.left, y: r.top } : null;
        },
        getVel: () => flight.velocity(),
        onHit: onPetHit,
      };
      return () => {
        delete arenaSlots[petId];
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由碰撞注册身份 petId/size/bottomPad/arena 决定：onPetHit 只经 startThrowLatestRef 转发、不捕获渲染期状态；补 onPetHit（每渲染重建）会让碰撞槽每渲染注销重注册
    }, [petId, size, bottomPad, arena]);

    const center = (): { x: number; y: number } => ({ x: currentCenterX(), y: currentCenterY() });

    live.current.walk = walk;
    live.current.flight = flight;
    live.current.posFollow = posFollow;
    live.current.squash = squash;
    live.current.center = center;
    live.current.stopMove = stopMove;

    return {
      applyThrow,
      box: () => boxRef.current,
      center,
      flight,
      metrics: () => motionRef.current,
      onPetHit,
      posFollow,
      place,
      setBox: (box) => {
        boxRef.current = box;
      },
      squash,
      startThrow,
      stopMove,
      walk,
    };
  };
}
