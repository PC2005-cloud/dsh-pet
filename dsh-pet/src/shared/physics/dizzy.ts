/**
 * 落地晕眩判定：抛掷落定后是否播 animations.dizzy。
 *
 * 只做纯阈值；温柔放下不走抛掷，不会进这里。旧配置缺键时取默认。
 * @module dsh-pet/src/shared/physics/dizzy
 */
import { type PhysicsParams } from '../types.ts';
import { DEFAULT_PHYSICS, DIZZY_IMPACT_SPEED } from './constants.ts';

/** 从 PhysicsParams 取晕眩冲击阈值（旧配置缺键 → 默认）。 */
export const dizzyImpactSpeed = (physics: PhysicsParams = DEFAULT_PHYSICS): number => {
  const n = Number(physics.dizzyImpactSpeed);
  return Number.isFinite(n) && n >= 0 ? n : DIZZY_IMPACT_SPEED;
};

/** 落地冲击是否达到晕眩阈值。 */
export const shouldDizzy = (impactSpeed: number, physics: PhysicsParams = DEFAULT_PHYSICS): boolean =>
  Math.abs(impactSpeed) >= dizzyImpactSpeed(physics);
