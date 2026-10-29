/**
 * 待办提醒策略的单元测试 —— 钉住三件事：
 *   ① 「越临近到期提醒越密」：档位表按距到期时长取间隔，逾期后逐步降频并最终停止；
 *   ② 下一次提醒 = 上次提醒（没提醒过取创建时刻）+ 当前档位间隔，改期限后靠清空 lastRemindedAt 重排；
 *   ③ 一拍只挑最急的一条，同一拍并列时按到期先后。
 *
 * 跑法：node --experimental-strip-types --test src/host/todo/policy.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextReminderAt,
  pickReminder,
  reminderIntervalMs,
  reminderText,
  spanText,
  truncateTodoText,
} from './policy.ts';
import type { TodoRecord } from './types.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 造一条待办：只覆盖本文件关心的字段。 */
function todo(overrides: Partial<TodoRecord> = {}): TodoRecord {
  return {
    id: 'todo-1',
    text: '交周报',
    dueAt: 1_000_000,
    done: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    lastRemindedAt: null,
    ...overrides,
  };
}

describe('reminderIntervalMs —— 到期越近间隔越短', () => {
  test('远期（超过 7 天）完全不提醒', () => {
    assert.equal(reminderIntervalMs(8 * DAY), Number.POSITIVE_INFINITY);
    assert.equal(reminderIntervalMs(7 * DAY + 1), Number.POSITIVE_INFINITY);
  });

  test('7 天到 1 天之间：24 小时 → 12 小时', () => {
    assert.equal(reminderIntervalMs(7 * DAY), DAY);
    assert.equal(reminderIntervalMs(3 * DAY), DAY);
    assert.equal(reminderIntervalMs(3 * DAY - 1), 12 * HOUR);
    assert.equal(reminderIntervalMs(DAY), 12 * HOUR);
  });

  test('1 天内：4 小时 → 1 小时 → 20 分钟 → 5 分钟', () => {
    assert.equal(reminderIntervalMs(DAY - 1), 4 * HOUR);
    assert.equal(reminderIntervalMs(6 * HOUR), 4 * HOUR);
    assert.equal(reminderIntervalMs(6 * HOUR - 1), HOUR);
    assert.equal(reminderIntervalMs(HOUR), HOUR);
    assert.equal(reminderIntervalMs(HOUR - 1), 20 * MINUTE);
    assert.equal(reminderIntervalMs(15 * MINUTE), 20 * MINUTE);
    assert.equal(reminderIntervalMs(15 * MINUTE - 1), 5 * MINUTE);
    assert.equal(reminderIntervalMs(1), 5 * MINUTE);
  });

  test('逾期：1 天内 30 分钟，一周内 6 小时，再久停止', () => {
    assert.equal(reminderIntervalMs(0), 30 * MINUTE);
    assert.equal(reminderIntervalMs(-1), 30 * MINUTE);
    assert.equal(reminderIntervalMs(-DAY), 6 * HOUR);
    assert.equal(reminderIntervalMs(-7 * DAY + 1), 6 * HOUR);
    assert.equal(reminderIntervalMs(-7 * DAY), Number.POSITIVE_INFINITY);
  });
});

describe('nextReminderAt —— 排期', () => {
  test('已完成 / 无期限 → null', () => {
    assert.equal(nextReminderAt(todo({ done: true }), 0), null);
    assert.equal(nextReminderAt(todo({ dueAt: null }), 0), null);
  });

  test('从未提醒：按创建那一刻的剩余量排第一次（不是按当前剩余）', () => {
    const dueAt = 10 * HOUR;
    // 创建时距到期约 10 小时 → 4 小时档 → 第一次排在创建后 4 小时
    const at = nextReminderAt(todo({ createdAt: 1000, dueAt }), dueAt - 5 * HOUR);
    assert.equal(at, 1000 + 4 * HOUR);
  });

  test('提醒过：从上次提醒时刻重新计间隔', () => {
    const dueAt = 10 * HOUR;
    const lastRemindedAt = dueAt - 4 * HOUR;
    const at = nextReminderAt(todo({ createdAt: 0, dueAt, lastRemindedAt }), dueAt - 3 * HOUR);
    assert.equal(at, lastRemindedAt + HOUR);
  });

  test('剩余时间短于档位间隔 → 取剩余时间（不会晚于到期）', () => {
    const dueAt = 2 * MINUTE;
    assert.equal(nextReminderAt(todo({ createdAt: 0, dueAt }), 0), dueAt);
    assert.equal(nextReminderAt(todo({ createdAt: 0, dueAt: 16 * MINUTE }), 0), 16 * MINUTE);
    // 到期不到一个档位：第一次就排在到期那一刻
    assert.equal(nextReminderAt(todo({ createdAt: 0, dueAt: 60 * 1000 }), 0), 60 * 1000);
  });

  test('创建时已逾期 → 第一次立刻到点', () => {
    const createdAt = 1000;
    const dueAt = 0;
    const at = nextReminderAt(todo({ createdAt, dueAt }), createdAt);
    assert.equal(at, createdAt);
  });

  test('远期事项进入 7 天窗口后：下一次巡检就补上', () => {
    const dueAt = 30 * DAY;
    const now = dueAt - 6 * DAY;
    const at = nextReminderAt(todo({ createdAt: 0, dueAt }), now);
    assert.ok(at !== null && at <= now, '进入提醒窗口后应立即补一次');
  });

  test('逾期但从没提醒过 → 立刻到点（巡检错过首次提醒也不推迟到 30 分钟后）', () => {
    const dueAt = 74 * 1000;
    const at = nextReminderAt(todo({ createdAt: 0, dueAt }), dueAt + 16 * 1000);
    assert.ok(at !== null && at <= dueAt + 16 * 1000, '逾期的未提醒事项必须已经到点');
  });

  test('逾期且提醒过 → 按逾期档位继续（30 分钟）', () => {
    const dueAt = 1000;
    const last = dueAt + 1000;
    assert.equal(nextReminderAt(todo({ createdAt: 0, dueAt, lastRemindedAt: last }), dueAt + 2000), last + 30 * MINUTE);
  });

  test('已过提醒阶段 → null', () => {
    assert.equal(nextReminderAt(todo({ dueAt: 1000 }), 1000 - 8 * DAY), null);
  });
});

describe('pickReminder —— 一拍只挑最急的一条', () => {
  test('只挑已经到点的，对未来待办不动手', () => {
    const now = 100 * HOUR;
    // 两条都创建于两小时前：距到期 5 小时/2 小时，档位都是 1 小时，所以都已到点。
    const later = todo({ id: 'later', dueAt: now + 5 * HOUR, createdAt: now - 2 * HOUR });
    const due = todo({ id: 'due', dueAt: now + 2 * HOUR, createdAt: now - 2 * HOUR });
    const picked = pickReminder([later, due], now);
    assert.equal(picked?.todo.id, 'due');
  });

  test('并列时按到期先后（更急的优先）', () => {
    const now = 100 * HOUR;
    // 两条都在一小时前提醒过，距到期分别为 2 小时 / 1.5 小时，档位同为 1 小时 → 下次时刻都是 now。
    const a = todo({ id: 'a', dueAt: now + 2 * HOUR, createdAt: now - HOUR, lastRemindedAt: now - HOUR });
    const b = todo({ id: 'b', dueAt: now + 1.5 * HOUR, createdAt: now - HOUR, lastRemindedAt: now - HOUR });
    const picked = pickReminder([a, b], now);
    assert.equal(picked?.todo.id, 'b');
  });

  test('没有到点的 → null', () => {
    const now = 100 * HOUR;
    assert.equal(pickReminder([todo({ dueAt: now + DAY, createdAt: now })], now), null);
  });
});

describe('spanText / truncateTodoText / reminderText', () => {
  test('时长写成人话，最小单位是 1 分钟', () => {
    assert.equal(spanText(0), '1分钟');
    assert.equal(spanText(25 * MINUTE), '25分钟');
    assert.equal(spanText(2 * HOUR), '2小时');
    assert.equal(spanText(3 * DAY), '3天');
  });

  test('正文按码点截断并补省略号', () => {
    assert.equal(truncateTodoText('交周报', 10), '交周报');
    assert.equal(truncateTodoText('一二三四五', 3), '一二三…');
  });

  test('未到期与逾期两种说法', () => {
    const dueAt = 10 * HOUR;
    assert.equal(reminderText(todo({ dueAt }), dueAt - 2 * HOUR), '「交周报」还有2小时就到点啦');
    assert.equal(reminderText(todo({ dueAt }), dueAt + 2 * HOUR), '「交周报」已经逾期2小时啦，记得处理');
  });

  test('刚过点不到一分钟：说「到点啦」，不说逾期', () => {
    const dueAt = 10 * HOUR;
    assert.equal(reminderText(todo({ dueAt }), dueAt + 10 * 1000), '「交周报」到点啦，记得处理');
  });

  test('超长正文在提醒里被截断', () => {
    const text = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸';
    const dueAt = 10 * HOUR;
    const said = reminderText(todo({ text, dueAt }), dueAt - HOUR);
    assert.ok(!said.includes(text), '提醒不应带出完整正文');
    assert.ok(said.includes('…'));
  });
});
