/**
 * 待办展示格式化的单元测试：到期说法、相对剩余、紧迫度与 `datetime-local` 互转。
 *
 * 全部用本地时间构造用例（`new Date(y, m, d, h, min)`），因此换时区跑也稳定。
 * 跑法：node --experimental-strip-types --test src/shared/todo/format.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dueLabel,
  formatDateTimeLocal,
  metaLabel,
  parseDateTimeLocal,
  remainingLabel,
  spanText,
  todoUrgency,
} from './format.ts';
import type { TodoItem } from './types.ts';

/** 基准时刻：2026-10-29（周四）09:30 本地时间。 */
const NOW = new Date(2026, 9, 29, 9, 30).getTime();

/** 造一条待办：只覆盖格式化关心的字段。 */
function todo(overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'todo-1',
    text: '交周报',
    dueAt: null,
    done: false,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

describe('spanText —— 时长写成人话', () => {
  test('分钟 / 小时 / 天，最小一分钟', () => {
    assert.equal(spanText(0), '1分钟');
    assert.equal(spanText(25 * 60 * 1000), '25分钟');
    assert.equal(spanText(2 * 60 * 60 * 1000), '2小时');
    assert.equal(spanText(3 * 24 * 60 * 60 * 1000), '3天');
  });
});

describe('dueLabel —— 绝对说法', () => {
  test('无期限', () => {
    assert.equal(dueLabel(null, NOW), '无期限');
  });

  test('今天 / 明天 / 后天 / 本周内 / 更远', () => {
    assert.equal(dueLabel(new Date(2026, 9, 29, 18, 0).getTime(), NOW), '今天 18:00');
    assert.equal(dueLabel(new Date(2026, 9, 30, 9, 0).getTime(), NOW), '明天 09:00');
    assert.equal(dueLabel(new Date(2026, 9, 31, 8, 5).getTime(), NOW), '后天 08:05');
    // 2026-11-02 是周一（与 10-29 周四同一周之后）
    assert.equal(dueLabel(new Date(2026, 10, 2, 8, 0).getTime(), NOW), '周一 08:00');
    assert.equal(dueLabel(new Date(2026, 10, 8, 8, 0).getTime(), NOW), '11月8日 08:00');
  });
});

describe('remainingLabel —— 相对说法', () => {
  test('未到期 / 已逾期 / 无期限', () => {
    assert.equal(remainingLabel(NOW + 90 * 60 * 1000, NOW), '还剩2小时');
    assert.equal(remainingLabel(NOW - 2 * 60 * 60 * 1000, NOW), '已逾期2小时');
    assert.equal(remainingLabel(null, NOW), '');
  });
});

describe('todoUrgency —— 紧迫度', () => {
  test('无期限 / 逾期 / 6 小时内 / 24 小时内 / 更远', () => {
    assert.equal(todoUrgency(null, NOW), 'undated');
    assert.equal(todoUrgency(NOW - 1, NOW), 'overdue');
    assert.equal(todoUrgency(NOW + 5 * 60 * 60 * 1000, NOW), 'soon');
    assert.equal(todoUrgency(NOW + 20 * 60 * 60 * 1000, NOW), 'today');
    assert.equal(todoUrgency(NOW + 3 * 24 * 60 * 60 * 1000, NOW), 'later');
  });
});

describe('metaLabel —— 列表副标题', () => {
  test('未完成：绝对 + 相对；逾期只留相对', () => {
    const dueAt = new Date(2026, 9, 29, 17, 30).getTime();
    assert.equal(metaLabel(todo({ dueAt }), NOW), '今天 17:30 · 还剩8小时');
    assert.equal(metaLabel(todo({ dueAt: NOW - 2 * 60 * 60 * 1000 }), NOW), '已逾期2小时');
    assert.equal(metaLabel(todo(), NOW), '无期限');
  });

  test('已完成：划线状态下的说法', () => {
    const dueAt = new Date(2026, 9, 29, 17, 30).getTime();
    assert.equal(metaLabel(todo({ dueAt, done: true }), NOW), '已完成 · 今天 17:30');
    assert.equal(metaLabel(todo({ done: true }), NOW), '已完成');
  });
});

describe('datetime-local 互转', () => {
  test('格式化补零，分钟精度', () => {
    assert.equal(formatDateTimeLocal(new Date(2026, 9, 29, 9, 5).getTime()), '2026-10-29T09:05');
  });

  test('解析回同一时刻；带秒也能读', () => {
    const ms = new Date(2026, 9, 29, 9, 5).getTime();
    assert.equal(parseDateTimeLocal('2026-10-29T09:05'), ms);
    assert.equal(parseDateTimeLocal('2026-10-29T09:05:30'), ms);
  });

  test('空串 / 非法格式 / 不存在的日期 → null', () => {
    assert.equal(parseDateTimeLocal(''), null);
    assert.equal(parseDateTimeLocal('明天'), null);
    assert.equal(parseDateTimeLocal('2026-02-30T09:00'), null);
    assert.equal(parseDateTimeLocal('2026-13-01T09:00'), null);
  });
});
