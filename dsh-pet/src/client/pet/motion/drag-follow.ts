/**
 * 拖拽跟随：默认包围盒过阻尼追赶指针目标，抹平指针事件的高频抖动；配置关掉弹簧时改为刚性贴住目标。
 * 不负责指针状态与松手结算：目标由拖拽模块每帧更新，这里只管把盒子追过去。
 * 依赖 shared/physics 的弹簧步进；帧句柄与速度由本模块持有，stop 之后可重新瞄准。
 * 不变量：同一时刻最多一条跟随在跑；瞄准与停走都会让迟到的帧自弃；DOM 只由本模块的帧写入。
 * @module dsh-pet/src/client/pet/motion/drag-follow
 */
import { springStep } from '../../../shared/physics.ts';
import type { BoxPoint } from './geometry.ts';

/** 跟随驱动每次起跑取的当帧能力：起跑时取一次快照，一次拖拽内盒与弹簧参数不变。 */
export interface DragFollowDeps {
  /** 当帧能力快照。 */
  card(): {
    /** 当前包围盒位置。 */
    box(): BoxPoint | null;
    /** 写回包围盒位置（每帧调用）。 */
    setBox(box: BoxPoint): void;
    /** 该宠物的物理参数，只取弹簧刚度与是否弹簧跟手。 */
    physics: { throwPower: number; dragSpring?: boolean };
  };
}

/** 弹簧跟随驱动：一个宠物一个实例。 */
export interface DragFollow {
  /** 设定这一拍的目标（包围盒左上角）。 */
  aim(target: BoxPoint): void;
  /** 起跑；已经在跑时立即返回。 */
  start(rootEl: HTMLDivElement): void;
  /** 停跟随并清掉目标与残余速度。 */
  stop(): void;
}

/**
 * 造跟随驱动。
 *
 * @param deps - 读写包围盒与取弹簧刚度。
 * @returns 可反复瞄准的驱动。
 */
export function createDragFollow(deps: DragFollowDeps): DragFollow {
  /** 在跑的 rAF；`null` = 没在追。 */
  let frame: number | null = null;
  /** 世代号：起跑或停下 +1，迟到的帧据此自弃。 */
  let token = 0;
  /** 追赶目标；`null` = 没有目标。 */
  let target: BoxPoint | null = null;
  /** 上一帧的速度（px/s），跨帧累积出过阻尼手感。 */
  let velocity = { vx: 0, vy: 0 };
  /** 上一帧的时刻（ms）。 */
  let last = 0;

  const stop = (): void => {
    token++;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    target = null;
    velocity = { vx: 0, vy: 0 };
  };

  const aim = (next: BoxPoint): void => {
    target = next;
  };

  const start = (rootEl: HTMLDivElement): void => {
    if (frame !== null) return;
    const current = deps.card();
    const spring = current.physics.throwPower;
    // 缺键按弹簧跟手：旧配置与手写配置没有这个键时行为保持原样。
    const springFollow = current.physics.dragSpring !== false;
    const own = ++token;
    last = performance.now();
    const step = (): void => {
      if (token !== own) return;
      const goal = target;
      if (!goal) {
        frame = null;
        return;
      }
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const box = current.box() ?? { x: 0, y: 0 };
      let x = goal.x;
      let y = goal.y;
      // 刚性模式不起弹簧：目标即位置。仍走同一条 rAF，不另开 pointermove 里的第二个 DOM 写入者。
      if (springFollow) {
        velocity.vx = springStep(velocity.vx, box.x, goal.x, dt, spring);
        velocity.vy = springStep(velocity.vy, box.y, goal.y, dt, spring);
        x = box.x + velocity.vx * dt;
        y = box.y + velocity.vy * dt;
      }
      current.setBox({ x, y });
      rootEl.style.left = x + 'px';
      rootEl.style.top = y + 'px';
      rootEl.style.right = 'auto';
      rootEl.style.bottom = 'auto';
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  return { aim, start, stop };
}
