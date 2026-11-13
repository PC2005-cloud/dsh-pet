/**
 * 宠物互撞结算（src/client/pet/motion/pet-collision.ts）的契约：一次算定绝对速度、
 * 分离帧只推位置不注入速度、没重叠时原样返回。
 * 用假站场驱动，不碰 rAF 与 DOM。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createPetCollision, type CollisionMetrics } from './pet-collision.ts';
import type { PetCollisionSlot, ThrowState } from '../../../shared/physics.ts';

const metrics: CollisionMetrics = { size: 200, bottomPad: 0 };

/** 造一个站场槽位：只记位置、速度与被写入的结算速度。 */
function makeSlot(at: { x: number; y: number }, vel = { vx: 0, vy: 0 }) {
  const applied: Array<{ vx: number; vy: number }> = [];
  const slot: PetCollisionSlot = {
    size: metrics.size,
    bottomPad: metrics.bottomPad,
    getBox: () => at,
    getVel: () => vel,
    applyVelocity: (vx, vy) => applied.push({ vx, vy }),
  };
  return { applied, slot };
}

/** 造结算器，同时记录撞击速度。 */
function makeResolver(slots: Record<string, PetCollisionSlot>) {
  const impacts: number[] = [];
  const resolve = createPetCollision({
    arena: () => ({ slots }),
    slotKey: 'me',
    onPetImpact: (speed) => impacts.push(speed),
  });
  return { impacts, resolve };
}

describe('createPetCollision —— 一次算定绝对速度', () => {
  test('迎面撞上：速度只换一次，对方拿到的是结算值而不是增量', () => {
    const other = makeSlot({ x: 410, y: 100 }, { vx: -200, vy: 0 });
    const { impacts, resolve } = makeResolver({ other: other.slot });
    const state: ThrowState = { x: 400, y: 100, vx: 800, vy: 0 };

    const out = resolve(state, metrics);

    assert.equal(other.applied.length, 1, '一帧只结算一次');
    // 等质量、e = 0.995，法向 = +x：对方终值 797.5，若按增量叠加会得到 597.5。
    assert.ok(Math.abs(other.applied[0].vx - 797.5) < 0.01, `应写绝对速度：${other.applied[0].vx}`);
    assert.ok(Math.abs(out.vx - -197.5) < 0.01, `自身终值应换向：${out.vx}`);
    assert.equal(impacts.length, 1, '撞一次报一次');
  });

  test('正在分离但仍重叠：只推位置，不写速度也不报撞击', () => {
    const other = makeSlot({ x: 410, y: 100 }, { vx: 100, vy: 0 });
    const { impacts, resolve } = makeResolver({ other: other.slot });

    const out = resolve({ x: 400, y: 100, vx: -100, vy: 0 }, metrics);

    assert.equal(other.applied.length, 0, '分离帧不能再注入速度');
    assert.equal(impacts.length, 0);
    assert.ok(out.x < 400, `应把自己推开：${out.x}`);
    assert.equal(out.vx, -100, '速度不动');
  });

  test('没重叠：原样返回同一份状态', () => {
    const other = makeSlot({ x: 1200, y: 100 });
    const { resolve } = makeResolver({ other: other.slot });
    const state: ThrowState = { x: 400, y: 100, vx: 800, vy: 0 };

    assert.equal(resolve(state, metrics), state);
    assert.equal(other.applied.length, 0);
  });

  test('站场里只有自己：原样返回同一份状态', () => {
    const self = makeSlot({ x: 400, y: 100 });
    const { resolve } = makeResolver({ me: self.slot });
    const state: ThrowState = { x: 400, y: 100, vx: 800, vy: 0 };

    assert.equal(resolve(state, metrics), state);
    assert.equal(self.applied.length, 0);
  });
});
