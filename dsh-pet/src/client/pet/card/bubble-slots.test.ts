/**
 * 气泡单槽的纯函数契约（src/client/pet/card/bubble-slots.ts）：优先级判定与余额页数。
 *
 * 只覆盖无状态部分；显隐与停留计时需要真实渲染，由手动验收。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { BalanceState } from '../../../shared/balance/index.ts';
import { balancePageCount, decideBubbleSlot, type BubbleSlotInput } from './bubble-slots.ts';

/** 一份全部关闭的输入，逐项覆盖出目标场景。 */
function input(overrides: Partial<BubbleSlotInput> = {}): BubbleSlotInput {
  return {
    workTerminal: false,
    workOn: false,
    workText: null,
    workStatusEnabled: true,
    whisperOn: false,
    whisperText: null,
    balanceOn: false,
    balanceAvailable: true,
    balanceEnabled: true,
    balanceManual: false,
    envOn: false,
    envAvailable: true,
    todoOn: false,
    ...overrides,
  };
}

const windowsState: BalanceState = { provider: 'test', shape: 'windows', ok: true };
const customState = (pages: number): BalanceState => ({
  provider: 'test',
  shape: 'custom',
  ok: true,
  custom: { views: Array.from({ length: pages }, () => ({ tag: 'div', text: '页' })) },
});
const failedState: BalanceState = { provider: 'test', ok: false, reason: 'fetch-error' };

describe('decideBubbleSlot —— 环境气泡的位置', () => {
  test('环境排在余额之后：两者都点亮时由余额占槽', () => {
    assert.equal(decideBubbleSlot(input({ balanceOn: true, envOn: true })), 'balance');
  });

  test('环境压过非终态工作气泡', () => {
    assert.equal(decideBubbleSlot(input({ envOn: true, workOn: true, workText: '干活中' })), 'env');
  });

  test('还没有环境数据：环境槽位不成立', () => {
    assert.equal(decideBubbleSlot(input({ envOn: true, envAvailable: false })), 'none');
  });

  test('说话压过环境（用户正看着一句回复时不切换）', () => {
    assert.equal(decideBubbleSlot(input({ envOn: true, whisperOn: true, whisperText: '嗨' })), 'whisper');
  });
});

describe('decideBubbleSlot —— 同一时刻只挂一个气泡', () => {
  test('都没有点亮：返回 none', () => {
    assert.equal(decideBubbleSlot(input()), 'none');
  });

  test('终态任务压过说话与余额：只活 10s，不让位', () => {
    const slot = decideBubbleSlot(
      input({
        workTerminal: true,
        workOn: true,
        workText: '跑完了',
        whisperOn: true,
        whisperText: '在',
        balanceOn: true,
      }),
    );
    assert.equal(slot, 'work-terminal');
  });

  test('说话压过余额与非终态任务：优先级第二', () => {
    const slot = decideBubbleSlot(
      input({ whisperOn: true, whisperText: '在', balanceOn: true, workOn: true, workText: '干活中' }),
    );
    assert.equal(slot, 'whisper');
  });

  test('余额压过非终态任务：常驻任务让位 10s 没有损失', () => {
    const slot = decideBubbleSlot(input({ balanceOn: true, workOn: true, workText: '干活中' }));
    assert.equal(slot, 'balance');
  });

  test('只剩非终态任务：常驻显示', () => {
    assert.equal(decideBubbleSlot(input({ workOn: true, workText: '干活中' })), 'work');
  });

  test('关闭工作状态联动：任务气泡不占槽位', () => {
    assert.equal(decideBubbleSlot(input({ workOn: true, workText: '干活中', workStatusEnabled: false })), 'none');
  });

  test('余额数据未拉到：不挂余额气泡', () => {
    assert.equal(decideBubbleSlot(input({ balanceOn: true, balanceAvailable: false })), 'none');
  });

  test('关闭余额且非手动请求：不挂余额气泡；手动请求照常挂', () => {
    assert.equal(decideBubbleSlot(input({ balanceOn: true, balanceEnabled: false })), 'none');
    assert.equal(decideBubbleSlot(input({ balanceOn: true, balanceEnabled: false, balanceManual: true })), 'balance');
  });

  test('待办面板压过一切：用户主动打开的窗口不让位', () => {
    const slot = decideBubbleSlot(
      input({
        todoOn: true,
        workTerminal: true,
        workOn: true,
        workText: '跑完了',
        whisperOn: true,
        whisperText: '在',
        balanceOn: true,
      }),
    );
    assert.equal(slot, 'todo');
  });
});

describe('balancePageCount —— 余额气泡可翻页数', () => {
  test('没有数据或拉取失败：一页', () => {
    assert.equal(balancePageCount(null), 1);
    assert.equal(balancePageCount(failedState), 1);
  });

  test('windows：收起与展开两页', () => {
    assert.equal(balancePageCount(windowsState), 2);
  });

  test('windows 带区间用量：多一页（收起 / 窗口明细 / 用量）', () => {
    assert.equal(
      balancePageCount({
        ...windowsState,
        usage: { totalTokens: 95967948, inputTokens: 95489675, outputTokens: 478273, requests: 745, spentUsd: 1.6 },
      }),
      3,
    );
  });

  test('custom：页数取第三方视图数', () => {
    assert.equal(balancePageCount(customState(3)), 3);
  });

  test('custom 只有一页：仍按一页算，不出现空翻页', () => {
    assert.equal(balancePageCount(customState(1)), 1);
  });

  test('内置单页形态：一页', () => {
    assert.equal(balancePageCount({ provider: 'test', shape: 'money', ok: true }), 1);
  });
});
