/**
 * 抛掷飞行：重力积分、边缘反弹、落地摩擦与宠物互撞，飞行中只改 DOM 位置，落定后才提交归一化中心。
 * 不负责起点与初速（拖拽松手、抛掷指令、被撞起飞各自决定），也不负责落地挤压的动画本身。
 * 依赖注入的取值函数；rAF 句柄与运动状态由本模块持有，跨渲染存活。
 * 不变量：每帧先积分、再结算互撞、最后写 DOM；互撞只写结算后的绝对速度，落定那一帧才调 commitFinal。
 * @module dsh-pet/src/client/pet/motion/flight
 */
import {
  flightTiltDeg,
  smoothTiltDeg,
  throwBounds,
  type GravityVector,
  type PetCollisionSlot,
  type ThrowState,
} from '../../../shared/physics.ts';
import { integrateFlight } from './flight-integrate.ts';
import { createPetCollision, type PetCollisionResolver } from './pet-collision.ts';
import type { BoxPoint, Center, Viewport } from './geometry.ts';
import type { PhysicsParams } from '../../../shared/types.ts';

/** 飞行需要的当帧几何（px）。 */
export interface FlightMetrics {
  /** 宠物宽度。 */
  size: number;
  /** 盒半宽。 */
  halfW: number;
  /** 盒半高。 */
  halfH: number;
  /** 身体相对视频盒左右各留的透明边。 */
  sideAllow: number;
  /** 舞台脚底垫高：互撞用的身体框按它上移。 */
  bottomPad: number;
}

/** 本帧撞击：撞的是哪条边（或宠物）与撞前速度。 */
export interface FlightImpact {
  /** 撞击对象；`pet` = 撞到另一只宠物。 */
  kind: 'left' | 'right' | 'ceiling' | 'floor' | 'pet';
  /** 撞击前的法向速度绝对值（px/s）。 */
  speed: number;
}

/** 飞行驱动的依赖：全部用取值函数，避免捕获渲染期的快照。 */
export interface FlightDeps {
  /** 宠物根节点；`null` 表示还没挂载。 */
  root(): HTMLDivElement | null;
  /** 当帧几何。 */
  metrics(): FlightMetrics;
  /** 当前视口尺寸。 */
  viewport(): Viewport;
  /** 该宠物的物理参数。 */
  physics(): PhysicsParams;
  /** 宠物间碰撞站场。 */
  arena(): { slots: Record<string, PetCollisionSlot> };
  /** 本宠物 id：碰撞时用来跳过自己。 */
  petId: string;
  /** 当前包围盒位置。 */
  box(): BoxPoint | null;
  /** 写回包围盒位置（每帧调用）。 */
  setBox(box: BoxPoint): void;
  /** 每帧写回归一化中心：刷新或重渲染时按它重排位置，不能用 React 状态（会慢一拍）。 */
  commitLive(center: Center): void;
  /** 落定后提交归一化中心，交给 React 收尾。 */
  commitFinal(center: Center): void;
  /** 落地挤压：入参是本帧落地前的竖直速度（冲击速度）。 */
  onLanding(impactVy: number): void;
  /** 本帧发生撞击（撞边或撞宠）：触觉反馈用；一帧最多回调一次，取本帧最重的那次。 */
  onImpact?(impact: FlightImpact): void;
  /** 体感模式下的重力向量；缺省用 physics.gravity 竖直向下。只在常驻模式里读。 */
  gravity?(): GravityVector;
  /** 飞行身体倾斜角（°）每帧回调；停飞时会再调一次 0。缺省 = 不倾斜。 */
  onTilt?(tiltDeg: number): void;
}

/** 飞行驱动：一个宠物一个实例。 */
export interface Flight {
  /**
   * 从给定左上角与初速起飞（抛掷模式：重力恒竖直向下，贴地低速即落定）。
   *
   * @param px - 包围盒左边缘（px）。
   * @param py - 包围盒上边缘（px）。
   * @param vx - 水平初速（px/s）。
   * @param vy - 竖直初速（px/s）。
   */
  start(px: number, py: number, vx: number, vy: number): void;
  /** 体感常驻模式：从当前位置起步、初速为零，重力逐帧取 {@link FlightDeps.gravity}；已在常驻时无副作用。 */
  startHeld(): void;
  /**
   * 改写当前速度：碰撞结算给的是绝对速度，不是增量。
   *
   * @param vx - 水平速度（px/s）。
   * @param vy - 竖直速度（px/s）。
   */
  setVelocity(vx: number, vy: number): void;
  /**
   * 叠加一个冲量（摇一摇）；没在跑时忽略——起不起飞、以什么模式起飞由调用方决定。
   *
   * @param dvx - 横向冲量（px/s）。
   * @param dvy - 纵向冲量（px/s）。
   */
  impulse(dvx: number, dvy: number): void;
  /** 停飞：取消在跑的帧并清空运动状态。 */
  stop(): void;
  /** 是否在跑（抛掷与常驻都算）。 */
  isFlying(): boolean;
  /** 是否处于体感常驻模式。 */
  isHeld(): boolean;
  /** 最近一帧的速度；没在跑时为 0。 */
  velocity(): { vx: number; vy: number };
}

/** 常驻模式的速度上限（px/s）：传感器重力会持续加速，留一个硬天花板兜底。 */
const MAX_HELD_SPEED = 6000;

/**
 * 造飞行驱动。
 *
 * @param deps - 取几何、写位置与落地回调。
 * @returns 可反复调用的驱动。
 */
export function createFlight(deps: FlightDeps): Flight {
  /** 在跑的 rAF；`null` = 没在跑。 */
  let frame: number | null = null;
  /** 世代号：起飞或停飞 +1，迟到的帧据此自弃。 */
  let token = 0;
  /** 最近一帧的状态；`null` = 没在跑。帧间它与帧内的 `current` 是同一个对象，改速度就是改下一刻的输入。 */
  let state: ThrowState | null = null;

  /** 是否体感常驻模式：重力逐帧由 {@link FlightDeps.gravity} 提供，落定改用静默计时。 */
  let held = false;
  /** 常驻模式的静默时长（ms）：重力为零且速度低时累计，到点停帧。 */
  let quietMs = 0;

  /** 互撞结算：规则在 pet-collision，这里只把撞击转成触觉回调。 */
  const resolveCollisions: PetCollisionResolver = createPetCollision({
    arena: deps.arena,
    petId: deps.petId,
    onPetImpact: (speed) => deps.onImpact?.({ kind: 'pet', speed }),
  });

  const stop = (): void => {
    token++;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    state = null;
    held = false;
    quietMs = 0;
    deps.onTilt?.(0);
  };

  const start = (px: number, py: number, vx: number, vy: number): void => {
    held = false;
    run(px, py, vx, vy);
  };

  /** 体感常驻模式：没有初速，重力逐帧由 {@link FlightDeps.gravity} 提供；已在常驻时无副作用。 */
  const startHeld = (): void => {
    if (frame !== null && held) return;
    const el = deps.root();
    const box = deps.box() ?? (el ? { x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().top } : null);
    if (box === null) return;
    held = true;
    run(box.x, box.y, 0, 0);
  };

  /**
   * 改写当前速度：碰撞结算给的是绝对速度，不是增量。
   *
   * @param vx - 水平速度（px/s）。
   * @param vy - 竖直速度（px/s）。
   */
  const setVelocity = (vx: number, vy: number): void => {
    if (state === null) return;
    state.vx = vx;
    state.vy = vy;
  };

  /**
   * 叠加一个冲量（摇一摇）：只在已经在跑时有效——没在跑时由调用方按抛掷起飞。
   *
   * @param dvx - 横向冲量（px/s）。
   * @param dvy - 纵向冲量（px/s）。
   */
  const impulse = (dvx: number, dvy: number): void => {
    if (state === null) return;
    state.vx += dvx;
    state.vy += dvy;
  };

  const run = (px: number, py: number, vx: number, vy: number): void => {
    const metrics = deps.metrics();
    const viewport = deps.viewport();
    const physics = deps.physics();
    const bounds = throwBounds({
      W: viewport.width,
      H: viewport.height,
      size: metrics.size,
      sideAllow: metrics.sideAllow,
    });
    const own = ++token;
    quietMs = 0;
    let current: ThrowState = { x: px, y: py, vx, vy };
    let last = performance.now();
    let prevGrounded = false; // 落地挤压只在空中到地面的转换帧触发一次。
    let tiltDeg = 0; // 本趟飞行的身体倾斜角；落定 / stop 清零。
    const rootEl = deps.root();

    /** 写回本帧位置：DOM、包围盒与归一化中心（后者供重渲染时按它重排）。 */
    const commitPose = (at: ThrowState): Center => {
      if (rootEl) {
        rootEl.style.left = at.x + 'px';
        rootEl.style.top = at.y + 'px';
        rootEl.style.right = 'auto';
        rootEl.style.bottom = 'auto';
      }
      deps.setBox({ x: at.x, y: at.y });
      const center = { rx: (at.x + metrics.halfW) / viewport.width, ry: (at.y + metrics.halfH) / viewport.height };
      deps.commitLive(center);
      return center;
    };

    const step = (): void => {
      if (token !== own) return;
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const fallingVy = current.vy; // 本帧积分前的竖直速度，即落地冲击速度。
      const gravity = held ? deps.gravity?.() : undefined;
      const res = integrateFlight(current, dt, bounds, physics, gravity);
      if (res.hit !== null) deps.onImpact?.({ kind: res.hit.edge, speed: res.hit.speed });
      const integrated: ThrowState = { x: res.x, y: res.y, vx: res.vx, vy: res.vy };
      current = integrated;
      if (physics.petCollision) current = resolveCollisions(current, metrics);
      // 被撞过就不在当帧判落定：积分结果已经代表不了当前位置了。
      const disturbed = current !== integrated;
      if (held) {
        const speed = Math.hypot(current.vx, current.vy);
        if (speed > MAX_HELD_SPEED) {
          const k = MAX_HELD_SPEED / speed;
          current = { ...current, vx: current.vx * k, vy: current.vy * k };
        }
      }
      state = current;
      const center = commitPose(current);
      // 落地挤压：只在空中到地面的转换帧触发，力度随冲击速度。
      const grounded = current.y >= bounds.maxY - 1;
      if (res.bounced && grounded && !prevGrounded) deps.onLanding(fallingVy);
      // 倾斜：飞行追速度方向；抛掷落地后目标 0°，指数平滑回正（避免硬切卡顿）。
      {
        const target = !held && grounded ? 0 : flightTiltDeg(current.vx, current.vy, physics);
        tiltDeg = smoothTiltDeg(tiltDeg, target, dt);
        deps.onTilt?.(tiltDeg);
      }
      prevGrounded = grounded;
      if (held) {
        // 常驻模式没有固定地面：重力为零且速度低就累计静默，到点停帧。
        const g = gravity ?? { gx: 0, gy: physics.gravity };
        const isStill = Math.hypot(g.gx, g.gy) < 1 && Math.hypot(current.vx, current.vy) < 20;
        quietMs = isStill ? quietMs + dt * 1000 : 0;
        if (quietMs >= 300) {
          deps.commitFinal(center);
          stop();
          return;
        }
      } else if (res.atRest && !disturbed) {
        deps.commitFinal(center);
        stop();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  return {
    impulse,
    isFlying: () => frame !== null,
    isHeld: () => held,
    setVelocity,
    start,
    startHeld,
    stop,
    velocity: () => (frame !== null && state !== null ? { vx: state.vx, vy: state.vy } : { vx: 0, vy: 0 }),
  };
}
