/**
 * 抛体单步的边界撞击上报与四向接触：钉住「撞哪条边」「撞前速度」以及墙 / 顶也带摩擦。
 *
 * hit 只服务触觉与强度换算；contacts 与 atRest 决定何时停帧。
 * 新用例统一关掉重力或取整数值，避免浮点噪声干扰断言。
 *
 * 跑法：node --experimental-strip-types --test src/shared/physics/throw.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { throwBounds, throwStep } from './throw.ts';
import { DEFAULT_PHYSICS } from './constants.ts';

/** 800×600 视口、100px 宽的宠物：maxX = 700，maxY = 600 - 56.25。 */
const BOUNDS = throwBounds({ W: 800, H: 600, size: 100, sideAllow: 0 });

/** 无重力：只验接触求解本身，不让重力增量混进期望值。 */
const NO_GRAVITY = { gx: 0, gy: 0 };

/** 浮点近似断言：逐位相等会把 0.78 的二进制误差变成假红。 */
const near = (actual: number, expected: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}（期望 ${expected}，实际 ${actual}）`);
};

describe('throwStep —— hit 上报', () => {
  test('没撞边：hit 为 null', () => {
    const res = throwStep({ x: 300, y: 300, vx: 0, vy: 0 }, 1 / 60, BOUNDS, DEFAULT_PHYSICS);
    assert.equal(res.hit, null);
  });

  test('撞左墙：edge=left，speed = 撞击前的水平速度', () => {
    const res = throwStep({ x: 1, y: 100, vx: -500, vy: 0 }, 0.01, BOUNDS, DEFAULT_PHYSICS);
    assert.deepEqual(res.hit, { edge: 'left', speed: 500 });
  });

  test('撞右墙：edge=right', () => {
    const res = throwStep({ x: 699, y: 100, vx: 500, vy: 0 }, 0.01, BOUNDS, DEFAULT_PHYSICS);
    assert.deepEqual(res.hit, { edge: 'right', speed: 500 });
  });

  test('落地：edge=floor，speed 是撞地前的竖直速度（含本步重力）', () => {
    const res = throwStep({ x: 100, y: 540, vx: 0, vy: 600 }, 0.02, BOUNDS, DEFAULT_PHYSICS);
    assert.equal(res.hit?.edge, 'floor');
    assert.ok((res.hit?.speed ?? 0) > 600, `应含重力增量，实际 ${res.hit?.speed}`);
  });

  test('撞顶：ceilingBounce 开启时上报 ceiling（速度已含本步重力）', () => {
    const res = throwStep({ x: 100, y: 1, vx: 0, vy: -500 }, 0.01, BOUNDS, DEFAULT_PHYSICS);
    // 先积分重力再判边界：-500 + 1400×0.01 = -486
    assert.deepEqual(res.hit, { edge: 'ceiling', speed: 486 });
  });

  test('撞顶：ceilingBounce 关闭时无边界，不上报', () => {
    const physics = { ...DEFAULT_PHYSICS, ceilingBounce: false };
    const res = throwStep({ x: 100, y: 1, vx: 0, vy: -500 }, 0.01, BOUNDS, physics);
    assert.equal(res.hit, null);
  });

  test('角落同时撞两条边：取速度更大的那条', () => {
    const res = throwStep({ x: 1, y: 540, vx: -5000, vy: 600 }, 0.01, BOUNDS, DEFAULT_PHYSICS);
    assert.equal(res.hit?.edge, 'left');
    assert.equal(res.hit?.speed, 5000);
  });
});

describe('throwStep —— 四向摩擦与贴面静止', () => {
  test('撞左墙：竖直速度按切向摩擦衰减', () => {
    const res = throwStep({ x: 1, y: 100, vx: -500, vy: 300 }, 0.01, BOUNDS, DEFAULT_PHYSICS, NO_GRAVITY);
    near(res.vx, 390, '水平速度应只按恢复系数反弹');
    near(res.vy, 292.5, '竖直速度应按摩擦衰减');
  });

  test('撞天花板：水平速度按切向摩擦衰减', () => {
    const res = throwStep({ x: 100, y: 1, vx: 300, vy: -500 }, 0.01, BOUNDS, DEFAULT_PHYSICS, NO_GRAVITY);
    near(res.vx, 292.5, '水平速度应按摩擦衰减');
    near(res.vy, 390, '竖直速度应只按恢复系数反弹');
  });

  test('重力朝上贴天花板：法向归零后 atRest 成立', () => {
    const res = throwStep({ x: 100, y: 0, vx: 0, vy: 0 }, 1 / 60, BOUNDS, DEFAULT_PHYSICS, { gx: 0, gy: -1400 });
    assert.deepEqual(res.contacts, ['ceiling']);
    assert.equal(res.atRest, true);
  });

  test('贴墙但沿墙仍有速度：atRest 不成立', () => {
    const res = throwStep({ x: 0, y: 100, vx: -500, vy: 300 }, 0.01, BOUNDS, DEFAULT_PHYSICS, NO_GRAVITY);
    assert.deepEqual(res.contacts, ['left']);
    assert.equal(res.atRest, false);
  });

  test('角落同时接触两面：contacts 保留全部接触边', () => {
    const res = throwStep({ x: 1, y: 540, vx: -5000, vy: 600 }, 0.01, BOUNDS, DEFAULT_PHYSICS, NO_GRAVITY);
    assert.deepEqual(res.contacts, ['left', 'floor']);
  });

  test('贴地低速：atRest 与改动前的落地静止一致', () => {
    const res = throwStep({ x: 300, y: 543.75, vx: 10, vy: 0 }, 1 / 60, BOUNDS, DEFAULT_PHYSICS);
    assert.deepEqual(res.contacts, ['floor']);
    assert.equal(res.atRest, true);
  });
});
