/**
 * 时间戳格式化：今天只给时间，更早补日期，跨年补年份。
 *
 * 时间全部由参数注入，不依赖真实时钟。
 *
 * 跑法：node --experimental-strip-types --test src/client/chat/stamp.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { formatStamp } from './stamp.ts';
import type { ChatTranslate } from './runtime.ts';
import { zh } from './locales/zh.ts';

/** 中文桩：日期模板从字典取，参数按 `{name}` 规则替换。 */
const t = ((key: string, params?: Record<string, unknown>) => {
  const text = (zh as Record<string, string>)[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_match: string, name: string) => String(params?.[name] ?? ''));
}) as unknown as ChatTranslate;

/** 用本地时间构造时间戳，避免时区把「几点」算歪。 */
const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number =>
  new Date(year, month - 1, day, hour, minute, second).getTime();

describe('formatStamp —— 消息时间展示', () => {
  const NOW = at(2026, 10, 28, 8, 27, 0);

  test('今天 → 只给时分秒', () => {
    assert.equal(formatStamp(at(2026, 10, 28, 8, 26, 46), NOW, t), '08:26:46');
  });

  test('昨天 → 前缀「昨天」', () => {
    assert.equal(formatStamp(at(2026, 10, 27, 23, 5, 9), NOW, t), '昨天 23:05:09');
  });

  test('同年更早 → 补月日', () => {
    assert.equal(formatStamp(at(2026, 3, 1, 9, 0, 0), NOW, t), '3月1日 09:00:00');
  });

  test('跨年 → 补年份', () => {
    assert.equal(formatStamp(at(2025, 12, 31, 23, 59, 0), NOW, t), '2025年12月31日 23:59:00');
  });

  test('没有时间（0 / 非法）→ 空串', () => {
    assert.equal(formatStamp(0, NOW, t), '');
    assert.equal(formatStamp(Number.NaN, NOW, t), '');
  });
});
