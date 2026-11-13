/**
 * 周期收窄的单元测试：非法值回落兜底、超大值夹到上限。
 *
 * 上限这条是回归防线：超过 2^31-1 ms 的延时会被 setTimeout 当成 1 ms，
 * 于是「周期设得太大」反而变成每秒一次。
 *
 * 跑法：node --experimental-strip-types --test src/host/plugin/period.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_PERIOD_SEC, clampPeriodSec } from './period.ts';

describe('clampPeriodSec —— 周期收窄', () => {
  test('合法值原样返回：正数秒数不被改动', () => {
    assert.equal(clampPeriodSec(300, 60), 300);
    assert.equal(clampPeriodSec('1800', 60), 1800, '配置里是字符串也要认');
  });

  test('非法值回落兜底：非数字、0、负数都算非法', () => {
    assert.equal(clampPeriodSec(undefined, 60), 60);
    assert.equal(clampPeriodSec('abc', 60), 60);
    assert.equal(clampPeriodSec(0, 60), 60, '0 不是「停用」，按非法回落');
    assert.equal(clampPeriodSec(-5, 60), 60);
    assert.equal(clampPeriodSec(Number.NaN, 60), 60);
    assert.equal(clampPeriodSec(Number.POSITIVE_INFINITY, 60), 60);
  });

  test('超大值夹到上限：30 天不会溢出成 1 ms', () => {
    assert.equal(clampPeriodSec(2_592_000, 60), MAX_PERIOD_SEC);
    assert.equal(clampPeriodSec(MAX_PERIOD_SEC, 60), MAX_PERIOD_SEC, '正好等于上限时不动');
    assert.equal(clampPeriodSec(MAX_PERIOD_SEC + 1, 60), MAX_PERIOD_SEC);
  });

  test('上限本身不溢出：折算成毫秒仍在 setTimeout 的范围内', () => {
    assert.ok(MAX_PERIOD_SEC * 1000 <= 2_147_483_647);
    assert.ok((MAX_PERIOD_SEC + 1) * 1000 > 2_147_483_647, '上限应当贴着边界，不能留太多余量');
  });
});
