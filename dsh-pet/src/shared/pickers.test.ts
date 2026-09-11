/**
 * pickers 事件档位逻辑单元测试 —— 钉住「数组槽位 = 档内随机 + 避免连续重复」与
 * 「成员判断必须穿透数组槽位」（直接 includes 会漏掉嵌套候选）两套语义。
 *
 * 跑法：node --experimental-strip-types --test src/shared/pickers.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isEventAnim, pickSlot, poolIncludes, slotIncludes } from './pickers.ts';

describe('pickSlot —— 事件档位取值', () => {
  test('字符串槽位原样返回（原行为不变），exclude 不影响字符串', () => {
    assert.equal(pickSlot('工作思考'), '工作思考');
    assert.equal(pickSlot('工作思考', '工作思考'), '工作思考');
  });

  test('数组槽位档内随机抽 1', () => {
    const saved = Math.random;
    try {
      Math.random = () => 0.1;
      assert.equal(pickSlot(['A', 'B']), 'A');
      Math.random = () => 0.9;
      assert.equal(pickSlot(['A', 'B']), 'B');
    } finally {
      Math.random = saved;
    }
  });

  test('exclude 优先避开：排除后池非空时不抽被排除项', () => {
    const saved = Math.random;
    try {
      // 排除 'B' 后只剩 ['C']：无论随机数多大都只能抽到 'C'
      Math.random = () => 0.999;
      assert.equal(pickSlot(['B', 'C'], 'B'), 'C');
    } finally {
      Math.random = saved;
    }
  });

  test('单候选 + 排除自己：退回原数组，宁可重复也不返回 undefined', () => {
    const saved = Math.random;
    try {
      Math.random = () => 0.0;
      assert.equal(pickSlot(['Solo'], 'Solo'), 'Solo');
    } finally {
      Math.random = saved;
    }
  });
});

describe('成员判断 —— 数组槽位成员也要命中', () => {
  // 与 config.jsonc 同构：balance / whisper / workStatus，其中部分档位是候选数组
  const events = {
    balance: ['余额-钱袋满溢', ['余额-金袋叮当', '余额-金袋叮当2']],
    workStatus: [['工作思考', '开始工作'], '认真工作'],
  };

  test('slotIncludes：字符串按名比，数组查成员', () => {
    assert.equal(slotIncludes('认真工作', '认真工作'), true);
    assert.equal(slotIncludes('认真工作', '开始工作'), false);
    assert.equal(slotIncludes(['工作思考', '开始工作'], '开始工作'), true);
    assert.equal(slotIncludes(['工作思考', '开始工作'], '认真工作'), false);
  });

  test('poolIncludes：档位数组（含嵌套候选）命中', () => {
    assert.equal(poolIncludes(events.workStatus, '工作思考'), true);
    assert.equal(poolIncludes(events.workStatus, '开始工作'), true);
    assert.equal(poolIncludes(events.workStatus, '认真工作'), true);
    assert.equal(poolIncludes(events.workStatus, '余额-钱袋满溢'), false);
  });

  test('isEventAnim：整个 events 段（含嵌套候选）命中；未定义返回 false', () => {
    assert.equal(isEventAnim(events, '余额-钱袋满溢'), true);
    assert.equal(isEventAnim(events, '余额-金袋叮当2'), true);
    assert.equal(isEventAnim(events, '开始工作'), true);
    assert.equal(isEventAnim(events, '不存在'), false);
    assert.equal(isEventAnim(undefined, '开始工作'), false);
  });
});