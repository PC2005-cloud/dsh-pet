/**
 * 飞行身体倾斜：按速度方向算目标角，指数平滑追赶，再拼进视频 transform。
 *
 * 只做纯计算；DOM 由浏览器 / 桌面两端各自写。旧配置缺键时取本文件默认值，不整段作废。
 * @module dsh-pet/src/shared/physics/tilt
 */
import { type PhysicsParams } from '../types.ts';
import { DEFAULT_PHYSICS, FLIGHT_TILT_MAX_DEG, FLIGHT_TILT_REF_SPEED } from './constants.ts';

export { FLIGHT_TILT_MAX_DEG, FLIGHT_TILT_REF_SPEED } from './constants.ts';

/** 飞行中追倾斜目标的响应（Hz）：越大跟手越紧；反弹改向时靠它抹平跳变。 */
export const FLIGHT_TILT_FOLLOW_HZ = 14;

/** 落地 / 回正时追 0° 的响应（Hz）：比飞行略快，与落地 Q 弹（~220ms）重叠完成。 */
export const FLIGHT_TILT_RECOVER_HZ = 22;

/** 从 PhysicsParams 取飞行倾斜参数（旧配置缺键 → 默认）。 */
export const flightTiltParams = (
  physics: PhysicsParams = DEFAULT_PHYSICS,
): { maxDeg: number; refSpeed: number } => {
  const maxDeg = Number(physics.flightTiltMaxDeg);
  const refSpeed = Number(physics.flightTiltRefSpeed);
  return {
    maxDeg: Number.isFinite(maxDeg) && maxDeg >= 0 ? maxDeg : FLIGHT_TILT_MAX_DEG,
    refSpeed: Number.isFinite(refSpeed) && refSpeed > 0 ? refSpeed : FLIGHT_TILT_REF_SPEED,
  };
};

/**
 * 飞行中身体倾斜角（°，CSS rotate 顺时针为正）。
 * 目标姿态 = 「头朝速度方向」（相对直立的旋转 = heading + 90°），再按 |v|/ref 缩放到 ±maxDeg。
 * 静止 / 零参 → 0。
 */
export const flightTiltDeg = (vx: number, vy: number, physics: PhysicsParams = DEFAULT_PHYSICS): number => {
  const { maxDeg, refSpeed } = flightTiltParams(physics);
  if (maxDeg <= 0) return 0;
  const speed = Math.hypot(vx, vy);
  if (!(speed > 0)) return 0;
  let targetDeg = (Math.atan2(vy, vx) * 180) / Math.PI + 90;
  while (targetDeg > 180) targetDeg -= 360;
  while (targetDeg < -180) targetDeg += 360;
  const limit = maxDeg * Math.min(1, speed / refSpeed);
  return Math.max(-limit, Math.min(limit, targetDeg));
};

/**
 * 倾斜角指数平滑：每帧把 current 推向 target，避免落地硬切 0° 的卡顿感。
 * `recovering`（目标为直立）用更快的 Hz。dt 单位秒。
 */
export const smoothTiltDeg = (
  current: number,
  target: number,
  dt: number,
  recovering = target === 0 && current !== 0,
): number => {
  const hz = recovering ? FLIGHT_TILT_RECOVER_HZ : FLIGHT_TILT_FOLLOW_HZ;
  const a = 1 - Math.exp(-hz * Math.max(0, dt));
  const next = current + (target - current) * a;
  // 已贴目标则钉死，避免浮点尾巴拖着「永远差一点」。
  return Math.abs(next - target) < 0.05 ? target : next;
};

/**
 * 宠物视频 transform 拼装：rotate（屏坐标倾斜）→ scaleX（朝向）→ scaleY（Q 弹）。
 * CSS 右到左应用，故 rotate 写在最前 = 最后施加 = 倾斜在屏幕空间，不受镜像翻转。
 */
export const petTransform = (opts: {
  facing: 'left' | 'right';
  tiltDeg?: number;
  /** 传入即写入（含 1）：挤压逐帧需要；省略则不写 scaleY。 */
  scaleY?: number;
}): string => {
  const parts: string[] = [];
  const tilt = opts.tiltDeg ?? 0;
  if (tilt) parts.push('rotate(' + tilt + 'deg)');
  if (opts.facing === 'right') parts.push('scaleX(-1)');
  if (opts.scaleY !== undefined) parts.push('scaleY(' + opts.scaleY + ')');
  return parts.join(' ');
};
