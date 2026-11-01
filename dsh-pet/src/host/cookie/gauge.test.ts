/**
 * cookie 换算与文案的单元测试 —— 钉住 71/72 这道坎与百分比夹取。
 *
 * 这些数字是整件事的意义所在：每条 228 字节、上限 16384 字节、第 72 条就 431。
 * 换算错一位，气泡就会在还能开 30 次的时候说「快了」，或者在已经打不开时说「没事」。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BYTES_PER_COOKIE, DANGER_COUNT, MAX_HEADER_BYTES, WARN_COUNT, cookieBubbleText, gaugeOf } from './gauge.ts';

describe('gaugeOf —— 条数换算成占用与档位', () => {
  test('0 条 → 0 字节 0%，余量是临界条数本身', () => {
    assert.deepEqual(gaugeOf(0), {
      count: 0,
      bytes: 0,
      percent: 0,
      remainingLaunches: DANGER_COUNT,
      level: 'ok',
    });
  });

  test('36 条 → 刚好 50%，档位转 warn', () => {
    const gauge = gaugeOf(WARN_COUNT);
    assert.equal(gauge.bytes, 36 * BYTES_PER_COOKIE);
    assert.equal(gauge.percent, 50);
    assert.equal(gauge.level, 'warn');
    assert.equal(gauge.remainingLaunches, DANGER_COUNT - WARN_COUNT);
  });

  test('71 条 → 危险但还没顶满，余量为 0', () => {
    const gauge = gaugeOf(DANGER_COUNT);
    assert.equal(gauge.level, 'danger');
    assert.equal(gauge.remainingLaunches, 0);
    assert.ok(gauge.percent < 100, '71 条 × 228 字节仍略低于 16384，百分比不该被夹到 100');
  });

  test('72 条 → 百分比夹在 100，不会出现 101%', () => {
    const gauge = gaugeOf(DANGER_COUNT + 1);
    assert.equal(gauge.percent, 100);
    assert.equal(gauge.remainingLaunches, 0);
  });

  test('远超上限（库里被灌满）→ 仍是 100%，余量不为负', () => {
    const gauge = gaugeOf(9999);
    assert.equal(gauge.percent, 100);
    assert.equal(gauge.remainingLaunches, 0);
  });

  test('NaN / 负数 / 小数 → 按 0 或下取整，不把坏数据传下去', () => {
    assert.equal(gaugeOf(Number.NaN).count, 0);
    assert.equal(gaugeOf(-3).count, 0);
    assert.equal(gaugeOf(12.9).count, 12);
  });

  test('上限常量与条数常量互相自洽：71 条不进 431，72 条才进', () => {
    assert.ok((DANGER_COUNT + 1) * BYTES_PER_COOKIE > MAX_HEADER_BYTES);
  });
});

describe('cookieBubbleText —— 三种档位各自给一句话', () => {
  test('ok 档：报条数、百分比与还能开几次', () => {
    const text = cookieBubbleText(gaugeOf(12));
    assert.match(text, /12 条/);
    assert.match(text, /还能再开 59 次/);
  });

  test('warn 档：提醒清理，但不说「打不开」', () => {
    const text = cookieBubbleText(gaugeOf(WARN_COUNT));
    assert.match(text, /记得清一下/);
    assert.ok(!text.includes('打不开'));
  });

  test('danger 档（71 条）：说「到了边缘、再启动一次就可能打不开」，不给安全次数', () => {
    const text = cookieBubbleText(gaugeOf(DANGER_COUNT));
    assert.match(text, /已经到边缘/);
    assert.ok(!text.includes('还能再开'), 'danger 档不该再给「还能再开 N 次」的数字');
  });

  test('danger 档（已超过 71 条）：说「超过上限」，不出现「再开 0 次」', () => {
    const text = cookieBubbleText(gaugeOf(DANGER_COUNT + 5));
    assert.match(text, /超过上限/);
    assert.ok(!text.includes('再开 0 次'));
  });
});
