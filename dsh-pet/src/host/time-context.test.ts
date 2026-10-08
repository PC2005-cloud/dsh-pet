/**
 * 时间背景单元测试 —— 钉住注入 system 末尾的那一行文字：
 *  - 时段划分：0–23 点逐时映射（凌晨 0-4 / 清晨 5-6 / 早上 7-8 / 上午 9-10 / 中午 11-12 /
 *    下午 13-16 / 傍晚 17-18 / 晚上 19-22 / 深夜 23），含分钟边界不越档（04:59 仍凌晨、05:00 进清晨）；
 *  - 工作日 / 周末：周六周日 = 周末，与余额低谷判定同一口径；
 *  - 整行格式：不补零的月日 + 补零的时分 + 星期 + 时段 + 工作日或周末 + 引导语；
 *  - 非法 Date → 空串（调用方据此整行不加，绝不产出「NaN年NaN月」）。
 *
 * 本模块零依赖（不 import @deepseek-ai/dsh-llm），故能在 node:test 里直接跑；
 * 日期一律用 `new Date(y, m, d, h, min)` 的**本地时间**构造，与实现读本地字段同一口径，
 * 因此断言不随运行机器的时区变化。
 *
 * 跑法：node --experimental-strip-types --test src/host/time-context.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dayKindOf, timeContextOf, timeSlotOf, type TimeSlot } from './time-context.ts';

/** 0–23 点逐时期望时段（改划分口径时必须同步这里，否则测试红） */
const EXPECTED_BY_HOUR: TimeSlot[] = [
  '凌晨',
  '凌晨',
  '凌晨',
  '凌晨',
  '凌晨',
  '清晨',
  '清晨',
  '早上',
  '早上',
  '上午',
  '上午',
  '中午',
  '中午',
  '下午',
  '下午',
  '下午',
  '下午',
  '傍晚',
  '傍晚',
  '晚上',
  '晚上',
  '晚上',
  '晚上',
  '深夜',
];

describe('timeSlotOf —— 小时 → 时段', () => {
  test('0–23 点逐时映射（钉死全部档位边界）', () => {
    const actual = Array.from({ length: 24 }, (_, h) => timeSlotOf(h));
    assert.deepEqual(actual, EXPECTED_BY_HOUR);
  });

  test('越界 / NaN → 凌晨兜底（不抛错，提示词路径不能因时间格式失败）', () => {
    assert.equal(timeSlotOf(-1), '凌晨');
    assert.equal(timeSlotOf(24), '深夜');
    assert.equal(timeSlotOf(Number.NaN), '凌晨');
  });
});

describe('dayKindOf —— 星期 → 工作日 / 周末', () => {
  test('周六（6）/ 周日（0）= 周末，周一至周五 = 工作日', () => {
    assert.equal(dayKindOf(0), '周末');
    assert.equal(dayKindOf(6), '周末');
    for (const day of [1, 2, 3, 4, 5]) {
      assert.equal(dayKindOf(day), '工作日');
    }
  });
});

describe('timeContextOf —— 注入 system 的那一行', () => {
  test('工作日晚上的完整一行（含引导语）', () => {
    assert.equal(
      timeContextOf(new Date(2026, 1, 17, 21, 14)),
      '【时间背景】2026年2月17日 星期二 21:14（晚上·工作日）。说话时可以自然带上当下时间的感觉，但不必刻意报时。',
    );
  });

  test('时分补零、月日不补零', () => {
    assert.equal(
      timeContextOf(new Date(2026, 0, 5, 9, 7)),
      '【时间背景】2026年1月5日 星期一 09:07（上午·工作日）。说话时可以自然带上当下时间的感觉，但不必刻意报时。',
    );
  });

  test('周六算周末', () => {
    assert.equal(
      timeContextOf(new Date(2026, 1, 21, 23, 59)),
      '【时间背景】2026年2月21日 星期六 23:59（深夜·周末）。说话时可以自然带上当下时间的感觉，但不必刻意报时。',
    );
  });

  test('周日算周末、整点分钟补零', () => {
    assert.equal(
      timeContextOf(new Date(2026, 1, 22, 5, 0)),
      '【时间背景】2026年2月22日 星期日 05:00（清晨·周末）。说话时可以自然带上当下时间的感觉，但不必刻意报时。',
    );
  });

  test('分钟边界不越档：04:59 仍是凌晨、05:00 已进清晨', () => {
    assert.ok(timeContextOf(new Date(2026, 1, 17, 4, 59)).includes('（凌晨·工作日）'));
    assert.ok(timeContextOf(new Date(2026, 1, 17, 5, 0)).includes('（清晨·工作日）'));
  });

  test('分钟边界不越档：22:59 仍是晚上、23:00 已进深夜', () => {
    assert.ok(timeContextOf(new Date(2026, 1, 17, 22, 59)).includes('（晚上·工作日）'));
    assert.ok(timeContextOf(new Date(2026, 1, 17, 23, 0)).includes('（深夜·工作日）'));
  });

  test('非法 Date → 空串（整行不加，不产出 NaN 乱码）', () => {
    assert.equal(timeContextOf(new Date('not a date')), '');
  });
});
