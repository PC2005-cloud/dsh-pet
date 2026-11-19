/**
 * Q 弹挤压：前台视频贴地压扁再回弹。曲线在 `shared/physics`（`squashScale`），本模块只管 rAF 与 token。
 * 同一时刻只跑一条：新的一次会取消上一条，并用世代号丢掉迟到的帧，避免两次挤压互相抢 `transform`。
 * 尊重系统的「减少动效」：命中时不挤压，但界面照常。
 * @module dsh-pet/src/client/pet/motion/squash
 */
import { petTransform, SQ_DURATION_MS, SQ_SQUASH, squashScale } from '../../../shared/physics.ts';

/** 挤压驱动：一个宠物一个实例。 */
export interface SquashDriver {
  /** 挤压一次；`depth` 缺省为共享常量（落地冲击会按落速给更深的值）。 */
  start: (el: HTMLVideoElement, depth?: number) => void;
  /** 立刻复位并放弃进行中的一次。 */
  stop: () => void;
  /** 是否正在挤压（飞行倾斜若与 squash 抢 transform，进行中只更新 ref）。 */
  isActive: () => boolean;
}

/**
 * 造挤压驱动。
 *
 * @param o - 取值函数：`facing` 给朝向；`tiltDeg` 给当前飞行倾斜（缺省 0）。
 * @returns 可反复调用的挤压驱动。
 */
export function createSquashDriver(o: {
  facing: () => 'left' | 'right';
  tiltDeg?: () => number;
}): SquashDriver {
  /** 进行中的 rAF；`null` = 没有挤压在跑。 */
  let frame: number | null = null;
  /** 世代号：每次开始或停止都 +1，迟到的帧据此自弃。 */
  let token = 0;

  const stop = (): void => {
    token += 1;
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };

  const start = (el: HTMLVideoElement, depth: number = SQ_SQUASH): void => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    token += 1;
    const current = token;
    if (frame !== null) cancelAnimationFrame(frame);
    const origin = el.style.transformOrigin;
    el.style.transformOrigin = 'bottom';
    const t0 = performance.now();
    const step = (): void => {
      if (token !== current) return;
      const u = Math.min((performance.now() - t0) / SQ_DURATION_MS, 1);
      const scale = squashScale(u, depth);
      el.style.transform = petTransform({
        facing: o.facing(),
        tiltDeg: o.tiltDeg?.() ?? 0,
        scaleY: scale,
      });
      if (u < 1) {
        frame = requestAnimationFrame(step);
        return;
      }
      frame = null;
      el.style.transformOrigin = origin;
      // 恢复朝向 + 当前倾斜（落地路径 tilt 已是 0；若中途被打断以 getter 为准）。
      el.style.transform = petTransform({ facing: o.facing(), tiltDeg: o.tiltDeg?.() ?? 0 });
    };
    frame = requestAnimationFrame(step);
  };

  return { start, stop, isActive: () => frame !== null };
}
