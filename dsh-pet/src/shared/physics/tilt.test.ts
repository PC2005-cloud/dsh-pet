/**
 * 飞行倾斜纯函数单测：目标角、平滑回正、transform 拼装。
 * @module dsh-pet/src/shared/physics/tilt.test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PHYSICS,
  FLIGHT_TILT_MAX_DEG,
  flightTiltDeg,
  petTransform,
  smoothTiltDeg,
} from '../physics.ts';

describe('flightTiltDeg —— 飞行身体倾斜', () => {
  test('静止 → 0', () => {
    assert.equal(flightTiltDeg(0, 0), 0);
  });

  test('全速向右 → 吃满 +maxDeg', () => {
    const tilt = flightTiltDeg(5000, 0, DEFAULT_PHYSICS);
    assert.ok(tilt > 0, '向右飞应顺时针倾斜');
    assert.ok(Math.abs(tilt - FLIGHT_TILT_MAX_DEG) < 1e-6, `应吃满上限，得到 ${tilt}`);
  });

  test('全速向左 → 吃满 −maxDeg', () => {
    const tilt = flightTiltDeg(-5000, 0, DEFAULT_PHYSICS);
    assert.ok(tilt < 0, '向左飞应逆时针倾斜');
    assert.ok(Math.abs(tilt + FLIGHT_TILT_MAX_DEG) < 1e-6, `应吃满负上限，得到 ${tilt}`);
  });

  test('半速向右 → 约为 maxDeg 的一半', () => {
    const ref = DEFAULT_PHYSICS.flightTiltRefSpeed!;
    const tilt = flightTiltDeg(ref / 2, 0, DEFAULT_PHYSICS);
    assert.ok(Math.abs(tilt - FLIGHT_TILT_MAX_DEG / 2) < 1e-6, `得到 ${tilt}`);
  });

  test('旧配置缺键仍可用默认', () => {
    const legacy = {
      gravity: 1400,
      restitution: 0.78,
      groundFriction: 2.5,
      ceilingBounce: true,
      throwPower: 1,
      petCollision: true,
    };
    const tilt = flightTiltDeg(5000, 0, legacy);
    assert.ok(Math.abs(tilt - FLIGHT_TILT_MAX_DEG) < 1e-6);
  });
});

describe('smoothTiltDeg —— 落地回正不硬切', () => {
  test('朝 0 平滑：一步不等于硬切，多步逼近', () => {
    const mid = smoothTiltDeg(60, 0, 1 / 60);
    assert.ok(mid < 60 && mid > 0, `应得中间值，得到 ${mid}`);
    let cur = 60;
    for (let i = 0; i < 90; i++) cur = smoothTiltDeg(cur, 0, 1 / 60);
    assert.equal(cur, 0, '约 1.5s 内应钉到 0');
  });

  test('已贴目标 → 原样返回', () => {
    assert.equal(smoothTiltDeg(0, 0, 1 / 60), 0);
    assert.equal(smoothTiltDeg(12, 12, 1 / 60), 12);
  });
});

describe('petTransform —— 倾斜 / 朝向 / Q 弹拼装', () => {
  test('仅朝右 → scaleX(-1)', () => {
    assert.equal(petTransform({ facing: 'right' }), 'scaleX(-1)');
  });

  test('倾斜 + 朝右 + Q 弹：rotate 在前', () => {
    assert.equal(
      petTransform({ facing: 'right', tiltDeg: 30, scaleY: 0.7 }),
      'rotate(30deg) scaleX(-1) scaleY(0.7)',
    );
  });

  test('显式 scaleY=1 仍写入（挤压首帧）', () => {
    assert.equal(petTransform({ facing: 'left', scaleY: 1 }), 'scaleY(1)');
  });

  test('零倾斜且省略 scaleY → 空串（朝左）', () => {
    assert.equal(petTransform({ facing: 'left', tiltDeg: 0 }), '');
  });
});
