/**
 * 宠物互撞结算：每帧把自己和站场里撞上的那一只做一次弹性分离。
 *
 * 不负责积分、重力与 DOM 写入，只回答「结算之后我该在哪、速度多少」。
 * 不变量：速度一次算定、双方都写绝对速度，绝不按增量叠加——重叠会持续好几帧，
 * 叠加会让同一对碰撞每帧重复注入动量，速度按帧指数增长。
 * @module dsh-pet/src/client/pet/motion/pet-collision
 */
import {
  bodyPixelBox,
  collidePet,
  overlapPush,
  rectsOverlap,
  type PetCollisionSlot,
  type ThrowState,
} from '../../../shared/physics.ts';

/** 结算需要的当帧几何。 */
export interface CollisionMetrics {
  /** 宠物宽度（px，质量 ∝ size²）。 */
  size: number;
  /** 舞台脚底垫高：身体框按它上移。 */
  bottomPad: number;
}

/** 结算依赖。 */
export interface PetCollisionDeps {
  /** 碰撞站场。 */
  arena(): { slots: Record<string, PetCollisionSlot> };
  /** 本宠物的站场槽键：跳过自己。 */
  slotKey: string;
  /** 撞到别的宠物：入参是法向相对速度（px/s），供触觉反馈换算强度。 */
  onPetImpact(speed: number): void;
}

/** 结算函数：入参是本帧积分后的状态，返回结算后的状态。 */
export type PetCollisionResolver = (state: ThrowState, metrics: CollisionMetrics) => ThrowState;

/**
 * 把重叠推开：{@link overlapPush} 给的是「各让一半」，这里取整段——
 * 对方若也在跑，它下一帧会从自己那侧再推一次，两边各推一次正好分开。
 *
 * @param state - 当前状态。
 * @param push - 半程位移；`null` = 没有重叠。
 * @returns 推开后的状态（速度不动）。
 */
const separate = (state: ThrowState, push: { dx: number; dy: number } | null): ThrowState =>
  push === null ? state : { ...state, x: state.x + push.dx * 2, y: state.y + push.dy * 2 };

/**
 * 造互撞结算器。
 *
 * @param deps - 站场、自身 id 与撞击回调。
 * @returns 一帧最多结算一对的结算函数；没撞上时原样返回入参。
 */
export function createPetCollision(deps: PetCollisionDeps): PetCollisionResolver {
  return (state, metrics) => {
    const slots = deps.arena().slots;
    const myBody = bodyPixelBox({ x: state.x, y: state.y, size: metrics.size, bottomPad: metrics.bottomPad });
    for (const slotId of Object.keys(slots)) {
      if (slotId === deps.slotKey) continue;
      const slot = slots[slotId];
      const otherBox = slot.getBox();
      if (!otherBox) continue;
      const otherBody = bodyPixelBox({ x: otherBox.x, y: otherBox.y, size: slot.size, bottomPad: slot.bottomPad });
      if (!rectsOverlap(myBody, otherBody)) continue;
      const separated = separate(state, overlapPush(myBody, otherBody));
      const vel = slot.getVel();
      const hit = collidePet(
        { x: state.x, y: state.y, vx: state.vx, vy: state.vy, size: metrics.size },
        { x: otherBox.x, y: otherBox.y, vx: vel.vx, vy: vel.vy, size: slot.size },
      );
      // 正在分离（重叠之后的那几帧）只推位置、不改速度，否则同一对碰撞会被反复注入动量。
      if (hit === null) return separated;
      deps.onPetImpact(hit.impactSpeed);
      slot.applyVelocity(hit.hvx, hit.hvy);
      return { ...separated, vx: hit.fvx, vy: hit.fvy };
    }
    return state;
  };
}
