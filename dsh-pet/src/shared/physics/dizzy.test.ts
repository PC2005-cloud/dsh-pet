/**
 * 落地晕眩阈值单测。
 * @module dsh-pet/src/shared/physics/dizzy.test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DIZZY_IMPACT_SPEED, shouldDizzy } from '../physics.ts';

describe('shouldDizzy —— 落地晕眩阈值', () => {
  test('低于阈值 → false；达到/超过 → true', () => {
    assert.equal(shouldDizzy(DIZZY_IMPACT_SPEED - 1), false);
    assert.equal(shouldDizzy(DIZZY_IMPACT_SPEED), true);
    assert.equal(shouldDizzy(DIZZY_IMPACT_SPEED + 500), true);
  });

  test('旧配置缺键仍用默认', () => {
    const legacy = {
      gravity: 1400,
      restitution: 0.78,
      groundFriction: 2.5,
      ceilingBounce: true,
      throwPower: 1,
      petCollision: true,
    };
    assert.equal(shouldDizzy(DIZZY_IMPACT_SPEED, legacy), true);
    assert.equal(shouldDizzy(DIZZY_IMPACT_SPEED - 1, legacy), false);
  });
});
