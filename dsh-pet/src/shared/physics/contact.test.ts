/**
 * 接触面求解：钉住四面共用同一套法向 / 切向公式，以及贴住阈值与摩擦方向。
 *
 * 数值都取手算可验的整数：dt = 0.5s、摩擦 1/s ⇒ 切向恰好衰减一半；恢复系数 0.5 ⇒ 法向也减半。
 *
 * 跑法：node --experimental-strip-types --test src/shared/physics/contact.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTACT_NORMALS, isRestingOnContacts, resolveContact } from './contact.ts';
import { DEFAULT_PHYSICS } from './constants.ts';

/** 恢复与摩擦都取半量：出射值正好是入射值的一半，便于手算断言。 */
const PHYSICS = { ...DEFAULT_PHYSICS, restitution: 0.5, groundFriction: 1 };

describe('CONTACT_NORMALS —— 法向朝向离开接触面的一侧', () => {
  test('四面法向：左 (+x)、右 (−x)、天花板 (+y)、地面 (−y)', () => {
    assert.deepEqual(CONTACT_NORMALS.left, { nx: 1, ny: 0 });
    assert.deepEqual(CONTACT_NORMALS.right, { nx: -1, ny: 0 });
    assert.deepEqual(CONTACT_NORMALS.ceiling, { nx: 0, ny: 1 });
    assert.deepEqual(CONTACT_NORMALS.floor, { nx: 0, ny: -1 });
  });
});

describe('resolveContact —— 法向反弹、切向摩擦', () => {
  test('落地：法向按恢复系数反弹，水平速度按摩擦衰减', () => {
    const out = resolveContact({ vx: 60, vy: 200 }, 'floor', PHYSICS, 0.5);
    assert.equal(out.vx, 30);
    assert.equal(out.vy, -100);
    assert.equal(out.normalSpeed, 100);
    assert.equal(out.tangentSpeed, 30);
  });

  test('撞左墙：竖直速度按摩擦衰减，水平速度按恢复系数反弹', () => {
    const out = resolveContact({ vx: -200, vy: 60 }, 'left', PHYSICS, 0.5);
    assert.equal(out.vx, 100);
    assert.equal(out.vy, 30);
  });

  test('撞右墙：法向反向，切向保持原符号', () => {
    const out = resolveContact({ vx: 200, vy: 60 }, 'right', PHYSICS, 0.5);
    assert.equal(out.vx, -100);
    assert.equal(out.vy, 30);
  });

  test('撞天花板：水平速度按摩擦衰减，竖直速度弹回向下', () => {
    const out = resolveContact({ vx: 60, vy: -200 }, 'ceiling', PHYSICS, 0.5);
    assert.equal(out.vx, 30);
    assert.equal(out.vy, 100);
  });

  test('法向速度低于贴住阈值：法向归零而不是反弹', () => {
    const out = resolveContact({ vx: 0, vy: 30 }, 'floor', PHYSICS, 0.5);
    assert.equal(out.normalSpeed, 0);
    assert.equal(out.vy, 0);
  });

  test('摩擦为 0：切向速度原样保留', () => {
    const out = resolveContact({ vx: 60, vy: 200 }, 'floor', { ...PHYSICS, groundFriction: 0 }, 0.5);
    assert.equal(out.vx, 60);
  });
});

describe('isRestingOnContacts —— 全部接触面贴住才算静止', () => {
  test('没有接触：false', () => {
    assert.equal(isRestingOnContacts([], { vx: 0, vy: 0 }), false);
  });

  test('贴地且切向低速：true', () => {
    assert.equal(isRestingOnContacts(['floor'], { vx: 10, vy: 0 }), true);
  });

  test('贴墙但沿墙仍有速度：false', () => {
    assert.equal(isRestingOnContacts(['left'], { vx: 0, vy: 30 }), false);
  });

  test('贴地但切向超过静止阈值：false', () => {
    assert.equal(isRestingOnContacts(['floor'], { vx: 20, vy: 0 }), false);
  });

  test('角落两个接触面：任一法向未贴住就不算静止', () => {
    assert.equal(isRestingOnContacts(['floor', 'left'], { vx: 10, vy: 0 }), false);
    assert.equal(isRestingOnContacts(['floor', 'left'], { vx: 0.5, vy: 0 }), true);
  });
});
