/**
 * 一张宠物卡的运动装配：包围盒、几何、自主走位、抛掷飞行、位置跟随与碰撞站场。
 * 不负责指针与菜单：拖拽驱动经迟绑槽回读，避免与运动驱动形成构造期环。
 * 三套驱动都只建一次，rAF 句柄与世代号在驱动内部，跨渲染存活。
 * @module dsh-pet/src/client/pet/card/motion
 */
import { createFlight, type Flight, type FlightMetrics } from '../motion/flight.ts';
import { createHaptics, type Haptics } from '../haptics.ts';
import { canReadMotionSensors, shakeImpulse, subscribeShake, subscribeTilt, tiltGravity } from '../device-tilt.ts';
import { createPositionFollow, type PositionFollow } from '../motion/position-follow.ts';
import { createSquashDriver, type SquashDriver } from '../motion/squash.ts';
import { createWalk, type Walk } from '../motion/walk.ts';
import { landingSquash, petTransform, throwVelocity } from '../../../shared/physics.ts';
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
  /** 停走位与位置跟随。 */
  stopMove: () => void;
  /** 从给定左上角与初速起飞。 */
  startThrow: (px: number, py: number, vx: number, vy: number) => void;
  /** 抛掷指令：角度（度）与力度倍率。 */
  applyThrow: (angleDeg: number, power: number) => void;
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

    // 飞行倾斜角（°）：抛掷 rAF 每帧写入；stop / 落定清零。squash / 换源读它拼 transform。
    const tiltDegRef = useRef(0);
    // Q 弹挤压：rAF 句柄与世代号在驱动内部，镜像按当前朝向复原，并叠飞行倾斜。
    const squashRef = useRef<SquashDriver | null>(null);
    squashRef.current ??= createSquashDriver({
      facing: () => card.facingRef.current,
      tiltDeg: () => tiltDegRef.current,
    });
    const squash = squashRef.current;
    /** 把倾斜写到前台视频；squash 进行中只更新 ref，下一帧 squash 会读到。 */
    const applyTilt = (deg: number): void => {
      tiltDegRef.current = deg;
      live.current.tiltDeg = deg;
      if (squash.isActive()) return;
      const frontEl = live.current.ownAnim?.frontVideo?.();
      if (!frontEl) return;
      frontEl.style.transform = petTransform({ facing: card.facingRef.current, tiltDeg: deg });
    };

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
    /** 触觉反馈：每张卡一个，冷却状态跟着卡片走；开关实时读配置。 */
    const hapticsRef = useRef<Haptics | null>(null);
    hapticsRef.current ??= createHaptics({ enabled: () => cfgRef.current.physics?.hapticEnabled !== false });
    const haptics = hapticsRef.current;
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
      onImpact: (impact) => {
        haptics.hit(impact.kind, impact.speed);
      },
      onTilt: applyTilt,
      // 只在常驻（倾斜）模式被读：倾斜没开或还没有采样时退回竖直重力，行为与关掉体感一致。
      gravity: () => {
        const physics = cfgRef.current.physics;
        const gravity = physics?.gravity ?? 0;
        if (physics?.tiltGravity !== true) return { gx: 0, gy: gravity };
        const sample = tiltSampleRef.current;
        const baseline = tiltBaselineRef.current;
        if (sample === null || baseline === null) return { gx: 0, gy: gravity };
        return tiltGravity(sample, baseline, gravity);
      },
    });
    const flight = flightRef.current;

    /** 体感：采样与中性姿态；关掉倾斜时两个都清空，下次再开重新标定。 */
    const tiltSampleRef = useRef<{ beta: number; gamma: number } | null>(null);
    const tiltBaselineRef = useRef<{ beta: number; gamma: number } | null>(null);

    /** 从给定左上角与初速起飞；先停弹簧跟随与走位，免得两套运动同时改位置。 */
    const startThrow = (px: number, py: number, vx: number, vy: number): void => {
      live.current.drag.stopFollow();
      stopMove();
      flight.start(px, py, vx, vy);
    };

    /**
     * 把速度落到这只宠物身上：在跑就按给定口径处理，没跑就从落点起飞。
     *
     * 没跑时一律起抛掷而不是起常驻——常驻只在倾斜开关开着时由姿态采样拉起，
     * 否则重力非零时会留下一个永远停不下来的常驻循环。
     *
     * @param vx - 水平速度或冲量（px/s）。
     * @param vy - 竖直速度或冲量（px/s）。
     * @param mode - `set` = 结算后的绝对速度（碰撞）；`add` = 叠加冲量（摇一摇）。
     */
    const applyVelocity = (vx: number, vy: number, mode: 'set' | 'add'): void => {
      if (flight.isFlying()) {
        if (mode === 'set') flight.setVelocity(vx, vy);
        else flight.impulse(vx, vy);
        return;
      }
      const at = boxRef.current ?? root()?.getBoundingClientRect() ?? null;
      if (at === null) return;
      startThrow(at.x, at.y, vx, vy);
    };
    /** 最新的 applyVelocity 引用，供碰撞槽与传感器回调转发，避免陈旧闭包。 */
    const applyVelocityRef = useRef<(vx: number, vy: number, mode: 'set' | 'add') => void>(() => {});
    applyVelocityRef.current = applyVelocity;

    // 传感器订阅只建一次：两个开关与物理参数每次回调现读，避免重订阅。
    useEffect(() => {
      if (!canReadMotionSensors()) return;
      const offTilt = subscribeTilt((sample) => {
        if (cfgRef.current.physics?.tiltGravity !== true) {
          tiltSampleRef.current = null;
          tiltBaselineRef.current = null;
          // 关掉开关时立刻收手：常驻模式若还在跑，会继续按朝下的重力往下掉。
          // 只停常驻——无条件 stop 会把正在飞的抛掷一起按掉，而传感器采样是持续不断的。
          if (flight.isHeld()) flight.stop();
          return;
        }
        if (tiltBaselineRef.current === null) tiltBaselineRef.current = sample;
        tiltSampleRef.current = sample;
        if (live.current.drag.isActive() || flight.isFlying()) return;
        // 只有真的倾斜了才起步：平放时每帧都起/停会长跑一个停不下来的空循环。
        const gravity = cfgRef.current.physics?.gravity ?? 0;
        const vector = tiltGravity(sample, tiltBaselineRef.current, gravity);
        if (vector.gx === 0 && vector.gy === 0) return;
        // 起步前先让走位与跟随松手：两套驱动同时写 left/top 会抖，互撞读的盒子也会被写乱。
        stopMove();
        flight.startHeld();
      });
      const offShake = subscribeShake((ax, ay, az) => {
        const physics = cfgRef.current.physics;
        if (physics?.shakeThrow !== true) return;
        if (live.current.drag.isActive()) return;
        const impulse = shakeImpulse(ax, ay, az, physics.throwPower ?? 1);
        if (impulse !== null) applyVelocityRef.current(impulse.vx, impulse.vy, 'add');
      });
      return () => {
        offTilt();
        offShake();
        flight.stop();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 订阅只建一次；开关、物理参数与驱动实例都经 ref 现读
    }, []);

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

    // 碰撞站场注册：getVel 取最新速度，applyVelocity 经 ref 转发，避免陈旧闭包。
    const { size, bottomPad } = metrics;
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
        applyVelocity: (vx, vy) => applyVelocityRef.current(vx, vy, 'set'),
      };
      return () => {
        delete arenaSlots[petId];
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 依赖由碰撞注册身份 petId/size/bottomPad/arena 决定：applyVelocity 只经 applyVelocityRef 转发、不捕获渲染期状态；补上它会让碰撞槽每渲染注销重注册
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
      posFollow,
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
