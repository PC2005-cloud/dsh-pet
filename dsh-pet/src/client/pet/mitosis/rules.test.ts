/**
 * 有丝分裂的纯判定（src/client/pet/mitosis/rules.ts）的契约测试。
 *
 * 钉住四件事：连点窗口够 5 次才算一次分裂、翻倍生但绝不越上限、
 * 分身那套物理只动「会不会落地」相关的几项、本体在非碰撞模式下参数逐项不变。
 * 随机全部来自注入的 rand，时间全部显式传入，所以断言可以逐位相等。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLONE_AIR_DRAG,
  CLONE_RESTITUTION,
  MITOSIS_CAP,
  MITOSIS_TAP_TIMES,
  MITOSIS_TAP_WINDOW_MS,
  badgeOf,
  clonePhysics,
  cloneWeightsOf,
  instanceKeyOf,
  mainPhysics,
  nextTap,
  planSplit,
  readMode,
  spawnSpot,
  trimClones,
  type TapWindow,
} from './rules.ts';
import { DEFAULT_PHYSICS } from '../../../shared/physics/constants.ts';
import type { Weights } from '../../../shared/types.ts';

/** 空窗口：与「这只宠物还没被点过」同一表示。 */
const NONE: TapWindow | null = null;

/** 成品配置里常见的一份权重。 */
const WEIGHTS: Weights = { idle: 10, turn: 5, move: 2 };

/** 浮点近似断言：出生区右/下边界是两步加乘的结果，逐位相等会假红。 */
const near = (actual: number, expected: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}（期望 ${expected}，实际 ${actual}）`);
};

describe('nextTap —— 连点窗口', () => {
  test('第 1 次点击：窗口从这一刻起算，不分裂', () => {
    const { tap, split } = nextTap(NONE, 1000);
    assert.equal(split, false);
    assert.deepEqual(tap, { startMs: 1000, count: 1 });
  });

  test('窗口内点满 4 次：还不分裂，但起点仍是第一次', () => {
    let tap = nextTap(NONE, 0).tap;
    for (let i = 1; i < MITOSIS_TAP_TIMES - 1; i++) {
      const step = nextTap(tap, i * 100);
      assert.equal(step.split, false, `第 ${i + 1} 次不该分裂`);
      tap = step.tap;
    }
    assert.equal(tap.count, MITOSIS_TAP_TIMES - 1);
    assert.equal(tap.startMs, 0, '窗口起点不该被后续点击推后');
  });

  test('第 5 次：报一次分裂并把窗口清零', () => {
    const tap = { startMs: 0, count: MITOSIS_TAP_TIMES - 1 };
    const { tap: next, split } = nextTap(tap, 500);
    assert.equal(split, true);
    assert.deepEqual(next, { startMs: 500, count: 0 }, '结算后重新起算，连点第六下不会白吃');
  });

  test('间隔超过窗口：这次当第 1 次，不分裂', () => {
    const tap = { startMs: 0, count: MITOSIS_TAP_TIMES - 1 };
    const { tap: next, split } = nextTap(tap, MITOSIS_TAP_WINDOW_MS + 1);
    assert.equal(split, false);
    assert.deepEqual(next, { startMs: MITOSIS_TAP_WINDOW_MS + 1, count: 1 });
  });

  test('恰好压在窗口边界：仍算连着（判定用「超出」而非「达到」）', () => {
    const tap = { startMs: 0, count: MITOSIS_TAP_TIMES - 1 };
    assert.equal(nextTap(tap, MITOSIS_TAP_WINDOW_MS).split, true);
  });
});

describe('planSplit / trimClones —— 上限', () => {
  test('翻倍：现有总数 1/2/3/4 只时，分别新增 1/2/3/4 只', () => {
    assert.equal(planSplit(1, 64), 1);
    assert.equal(planSplit(2, 64), 2);
    assert.equal(planSplit(3, 64), 3);
    assert.equal(planSplit(4, 64), 4);
  });

  test('差一点到顶：只补差额，绝不越界', () => {
    assert.equal(planSplit(40, 64), 24);
    assert.equal(planSplit(63, 64), 1);
  });

  test('已到上限：生 0 只', () => {
    assert.equal(planSplit(64, 64), 0);
    assert.equal(planSplit(100, 64), 0);
  });

  test('两种模式的上限：普通 64、碰撞 32（含本体）', () => {
    assert.deepEqual(MITOSIS_CAP, { normal: 64, collide: 32 });
  });

  test('切模式收分身：留最前面的 cap-1 只（本体占一格）', () => {
    assert.deepEqual(trimClones([1, 2, 3, 4], 3), [1, 2]);
    assert.deepEqual(trimClones([1, 2], 3), [1, 2]);
    assert.deepEqual(trimClones([1, 2], 1), [], '上限收到只剩本体时分身全清');
  });

  test('不需要收敛也返回新数组：调用方可以直接 setState', () => {
    const list = [1, 2];
    const out = trimClones(list, 64);
    assert.notEqual(out, list);
    assert.deepEqual(out, list);
  });
});

describe('cloneWeightsOf —— 分身要多动', () => {
  test('压低 idle、抬高 turn 与 move', () => {
    assert.deepEqual(cloneWeightsOf(WEIGHTS), { idle: 4, turn: 7, move: 5 });
  });

  test('本体几乎不动时仍有下限：不会整群钉死', () => {
    assert.deepEqual(cloneWeightsOf({ idle: 10, turn: 0, move: 0 }), { idle: 4, turn: 2, move: 3 });
  });
});

describe('clonePhysics / mainPhysics —— 物理按角色分叉', () => {
  test('分身：不落地、高弹、无摩擦、顶部也反弹', () => {
    const out = clonePhysics(DEFAULT_PHYSICS, 'normal');
    assert.equal(out.gravity, 0);
    assert.equal(out.restitution, CLONE_RESTITUTION);
    assert.equal(out.groundFriction, 0);
    assert.equal(out.ceilingBounce, true);
  });

  test('普通模式：带空气阻力，互撞沿用本体配置', () => {
    assert.equal(clonePhysics(DEFAULT_PHYSICS, 'normal').airDrag, CLONE_AIR_DRAG);
    assert.equal(clonePhysics(DEFAULT_PHYSICS, 'normal').petCollision, DEFAULT_PHYSICS.petCollision);
    assert.equal(clonePhysics({ ...DEFAULT_PHYSICS, petCollision: false }, 'normal').petCollision, false);
  });

  test('碰撞模式：强制互撞且去掉阻力（阻力会让它们撞着撞着全停半空）', () => {
    const out = clonePhysics({ ...DEFAULT_PHYSICS, petCollision: false }, 'collide');
    assert.equal(out.petCollision, true);
    assert.equal(out.airDrag, 0);
  });

  test('不改入参：本体的那份配置仍是配置', () => {
    const before = { ...DEFAULT_PHYSICS };
    clonePhysics(DEFAULT_PHYSICS, 'collide');
    assert.deepEqual(DEFAULT_PHYSICS, before);
  });

  test('本体：普通模式原样返回同一个对象，碰撞模式只打开互撞', () => {
    assert.equal(mainPhysics(DEFAULT_PHYSICS, 'normal'), DEFAULT_PHYSICS);
    const collide = mainPhysics(DEFAULT_PHYSICS, 'collide');
    assert.equal(collide.petCollision, true);
    assert.equal(collide.gravity, DEFAULT_PHYSICS.gravity, '本体仍有重力，不会飘走');
    assert.equal(collide.airDrag, undefined);
  });
});

describe('出生点与身份键', () => {
  test('rand=0 / rand=1：出生区取到两个对角', () => {
    assert.deepEqual(
      spawnSpot(() => 0),
      { rx: 0.06, ry: 0.06 },
    );
    const far = spawnSpot(() => 1);
    near(far.rx, 0.84, '右上');
    near(far.ry, 0.74, '右下');
  });

  test('出生区整体落在视口内：不会一出生就贴在边上', () => {
    for (const r of [0, 0.5, 0.999]) {
      const { rx, ry } = spawnSpot(() => r);
      assert.ok(rx > 0 && rx < 1 && ry > 0 && ry < 1, `rand=${r} 时越界：${rx},${ry}`);
    }
  });

  test('身份键带本体 id 与序号；本体 1 号位是分身 2', () => {
    assert.equal(instanceKeyOf('p1', 3), 'p1~m3');
    assert.equal(badgeOf(0), 1);
    assert.equal(badgeOf(3), 4);
  });

  test('模式读取：脏值与缺失都回普通', () => {
    assert.equal(readMode(null), 'normal');
    assert.equal(readMode('collide'), 'collide');
    assert.equal(readMode('billiard'), 'normal');
  });
});
