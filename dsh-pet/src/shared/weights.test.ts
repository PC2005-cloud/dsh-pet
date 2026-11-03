/**
 * 动作频率权重（src/shared/weights.ts）的契约测试。
 *
 * 三条契约：
 *   1. 随机动作 = 100 − 三项之和，且不会为负；
 *   2. 改一项时另两项不动，超上限的输入被夹住；
 *   3. 坏配置（缺字段、非数字、负数）解析为 undefined，表单保留现值。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { actionPercent, parseWeights, withWeight } from './weights.ts';

describe('actionPercent —— 随机动作占比', () => {
  test('默认 10/5/5：随机动作 80', () => {
    assert.equal(actionPercent({ idle: 10, turn: 5, move: 5 }), 80);
  });

  test('不合法的合计超过 100：按 0 处理，不返回负数', () => {
    assert.equal(actionPercent({ idle: 120, turn: 5, move: 5 }), 0);
  });

  test('三项占满 100：随机动作 0', () => {
    assert.equal(actionPercent({ idle: 90, turn: 5, move: 5 }), 0);
  });
});

describe('withWeight —— 改一项，其余不动', () => {
  test('提高待机：夹到 100 − 转向 − 移动', () => {
    assert.deepEqual(withWeight({ idle: 10, turn: 5, move: 5 }, 'idle', 95), { idle: 90, turn: 5, move: 5 });
  });

  test('小数取整、负数夹到 0', () => {
    assert.deepEqual(withWeight({ idle: 10, turn: 5, move: 5 }, 'turn', 7.6), { idle: 10, turn: 8, move: 5 });
    assert.deepEqual(withWeight({ idle: 10, turn: 5, move: 5 }, 'move', -3), { idle: 10, turn: 5, move: 0 });
  });

  test('非数字按 0 处理', () => {
    assert.deepEqual(withWeight({ idle: 10, turn: 5, move: 5 }, 'idle', Number.NaN), { idle: 0, turn: 5, move: 5 });
  });

  test('合计已经超过 100（手写坏配置）：夹到 0，不产出负数', () => {
    assert.deepEqual(withWeight({ idle: 100, turn: 10, move: 0 }, 'move', 5), { idle: 100, turn: 10, move: 0 });
  });

  test('不修改入参', () => {
    const weights = { idle: 10, turn: 5, move: 5 };
    withWeight(weights, 'idle', 30);
    assert.deepEqual(weights, { idle: 10, turn: 5, move: 5 });
  });
});

describe('parseWeights —— 成品配置 → 权重', () => {
  test('三个非负数原样带出', () => {
    assert.deepEqual(parseWeights({ idle: 30, turn: 5, move: 5 }), { idle: 30, turn: 5, move: 5 });
  });

  test('缺字段 / 非数字 / 负数 / 非对象：一律 undefined', () => {
    assert.equal(parseWeights({ idle: 30, turn: 5 }), undefined);
    assert.equal(parseWeights({ idle: 'x', turn: 5, move: 5 }), undefined);
    assert.equal(parseWeights({ idle: -1, turn: 5, move: 5 }), undefined);
    assert.equal(parseWeights(null), undefined);
    assert.equal(parseWeights([]), undefined);
  });
});
