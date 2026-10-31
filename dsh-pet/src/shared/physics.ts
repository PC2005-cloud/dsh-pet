/**
 * 拖拽抛掷物理的公开出口：常量、弹簧、挤压、抛掷与碰撞。
 *
 * 只做再导出，不含逻辑；子模块按变化原因分居 ./physics/。
 * 必须始终成立：浏览器半侧与桌面 Helper 消费同一份实现，手感不得分叉。
 * @module dsh-pet/src/shared/physics
 */
export {
  ACCEL_GAIN_MAX,
  ACCEL_REF,
  DEAD_ZONE_SPEED,
  DEFAULT_PHYSICS,
  DEFAULT_THROW_POWER,
  GRAVITY,
  GROUND_FRICTION,
  MAX_STEP_DT,
  MAX_THROW_SPEED,
  MIN_SPAN_MS,
  PEAK_WEIGHT,
  PET_BOUNCE_E,
  RELEASE_STALE_MS,
  RELEASE_WINDOW_MS,
  RESTITUTION,
  REST_NORMAL,
  REST_NORMAL_EPS,
  REST_TANGENT,
  SEG_MIN_DT_MS,
  SLINGSHOT_REF_RATIO,
  SPRING_C,
  SPRING_K,
  SQ_DURATION_MS,
  SQ_HARD_SPEED,
  SQ_MAX_SQUASH,
  SQ_SOFT_SPEED,
  SQ_SQUASH,
  SUBSTEP_MAX,
  SUBSTEP_PX,
  THROW_SPEED_ANCHOR,
  TRAIL_KEEP_MS,
} from './physics/constants.ts';
export { landingSquash, squashScale } from './physics/squash.ts';
export {
  screenOfBox,
  throwBounds,
  throwBoundsIn,
  throwSpace,
  throwStep,
  throwStepRegion,
  throwSubsteps,
} from './physics/throw.ts';
export type { DragSample, GravityVector, ThrowBounds, ThrowSpace, ThrowState } from './physics/throw.ts';
export type { ContactEdge } from './physics/contact.ts';
export {
  estimateReleaseVelocity,
  pullAngle,
  slingshotPower,
  slingshotRefDist,
  slingshotVelocity,
  throwVelocity,
  trimTrail,
} from './physics/release.ts';
export { softClampSpeed, springStep } from './physics/spring.ts';
export { bodyPixelBox, collidePet, overlapPush, rectsOverlap } from './physics/collide.ts';
export type { PetCollider, PetCollisionSlot } from './physics/collide.ts';
