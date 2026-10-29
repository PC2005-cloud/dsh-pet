/**
 * 待办提醒的节奏与文案（宿主半侧纯逻辑）。
 *
 * 只回答「什么时候该提醒」与「提醒说什么」：不读文件、不碰计时器与 HTTP，时间由调用方注入。
 * 到期越近提醒越密是这份模块的核心契约：调整档位只改下面的两张表，`nextReminderAt` 自动跟随。
 * @module dsh-pet/src/host/todo/policy
 */
import type { TodoRecord } from './types.ts';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 到期前的提醒档位：`[至少还剩多少毫秒, 提醒间隔]`，从宽到窄匹配。 */
const AHEAD_STEPS: ReadonlyArray<readonly [number, number]> = [
  [3 * DAY_MS, DAY_MS],
  [DAY_MS, 12 * HOUR_MS],
  [6 * HOUR_MS, 4 * HOUR_MS],
  [HOUR_MS, HOUR_MS],
  [15 * MINUTE_MS, 20 * MINUTE_MS],
  [0, 5 * MINUTE_MS],
];

/** 逾期后的提醒间隔：1 天内 30 分钟一次，一周内 6 小时一次，再久就不再打扰。 */
const OVERDUE_FRESH_INTERVAL_MS = 30 * MINUTE_MS;
const OVERDUE_OLD_INTERVAL_MS = 6 * HOUR_MS;
/** 逾期超过这么久就不再提醒（待办仍留在清单里，等用户自己处理）。 */
const OVERDUE_STOP_MS = 7 * DAY_MS;
/** 距离到期还有这么久之前完全不提醒：一个月的远期事项不值得天天念。 */
const AHEAD_START_MS = 7 * DAY_MS;

/** 提醒文案里引用正文的长度上限（码点）：气泡放不下整条待办。 */
const REMINDER_TEXT_MAX = 18;

/**
 * 按「距到期还有多久」取提醒间隔。
 *
 * @param remainingMs - 到期时刻减当前时刻；≤0 表示已逾期。
 * @returns 间隔毫秒；`Infinity` 表示这个阶段不该再提醒。
 */
export function reminderIntervalMs(remainingMs: number): number {
  if (remainingMs <= 0) {
    const overdueBy = -remainingMs;
    if (overdueBy >= OVERDUE_STOP_MS) return Number.POSITIVE_INFINITY;
    return overdueBy >= DAY_MS ? OVERDUE_OLD_INTERVAL_MS : OVERDUE_FRESH_INTERVAL_MS;
  }
  if (remainingMs > AHEAD_START_MS) return Number.POSITIVE_INFINITY;
  for (const [minRemaining, interval] of AHEAD_STEPS) {
    if (remainingMs >= minRemaining) return interval;
  }
  return 5 * MINUTE_MS;
}

/**
 * 这一条待办下一次该在什么时候提醒。
 *
 * 以「上次提醒（没提醒过就用创建时刻）+ 当前阶段间隔」为下一次时刻：时间越接近到期，
 * 间隔越短，于是下一次提醒自动提前；改期限或重新打开会把 `lastRemindedAt` 清空，重新排期。
 * 剩余时间短于档位间隔时取剩余时间；已经逾期但从未提醒过时返回排期起点（即「现在就该提醒」），
 * 否则巡检错过第一次提醒后，逾期档位会把它推到 30 分钟之后。
 *
 * @param todo - 单条待办。
 * @param now - 当前时刻（epoch ms）。
 * @returns 下一次提醒时刻；已完成、无期限或已过提醒阶段时为 null。
 */
export function nextReminderAt(todo: TodoRecord, now: number): number | null {
  if (todo.done || todo.dueAt === null) return null;
  const intervalNow = reminderIntervalMs(todo.dueAt - now);
  if (!Number.isFinite(intervalNow)) return null;
  // 已经提醒过：从上次提醒时刻按当前档位续排。间隔在到期前会逐级缩短，下一次自然提前。
  if (todo.lastRemindedAt !== null) return todo.lastRemindedAt + intervalNow;
  const remainingAtCreation = todo.dueAt - todo.createdAt;
  // 创建时还没进入提醒窗口（远期事项）：先按当前档位排；这个时刻早已过去，进入窗口后的第一拍补上。
  if (remainingAtCreation > AHEAD_START_MS) return todo.createdAt + intervalNow;
  // 首次提醒必须用「创建那一刻的剩余量」算，不能用「现在还剩多少」：后者会把已流逝的时间重复计一次，
  // 让第一次提醒在创建后紧接着就触发（短期限事项实测会提前整整一个档位）。
  const intervalAtCreation = reminderIntervalMs(remainingAtCreation);
  const step = Math.min(Number.isFinite(intervalAtCreation) ? intervalAtCreation : 0, Math.max(0, remainingAtCreation));
  return todo.createdAt + step;
}

/** 一条到点的提醒：待办本体与它该被提醒的时刻。 */
export interface DueReminder {
  todo: TodoRecord;
  at: number;
}

/**
 * 从清单里挑出「最该现在提醒」的一条。
 *
 * 一拍最多提醒一条：多条同时到期时按提醒时刻先后，再按到期先后（更急的优先）。
 *
 * @param todos - 全部待办。
 * @param now - 当前时刻（epoch ms）。
 * @returns 命中的待办；没有到点的返回 null。
 */
export function pickReminder(todos: readonly TodoRecord[], now: number): DueReminder | null {
  let best: DueReminder | null = null;
  for (const todo of todos) {
    const at = nextReminderAt(todo, now);
    if (at === null || at > now) continue;
    if (best === null || at < best.at) {
      best = { todo, at };
      continue;
    }
    if (at === best.at) {
      const todoDue = todo.dueAt ?? Number.POSITIVE_INFINITY;
      const bestDue = best.todo.dueAt ?? Number.POSITIVE_INFINITY;
      if (todoDue < bestDue) best = { todo, at };
    }
  }
  return best;
}

/**
 * 把毫秒差写成人话。
 *
 * @param ms - 时长（非负；负数先取绝对值）。
 * @returns 例如「25分钟」「3小时」「2天」。
 */
export function spanText(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / MINUTE_MS));
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.max(1, Math.round(minutes / 60));
  if (hours < 24) return `${hours}小时`;
  return `${Math.max(1, Math.round(hours / 24))}天`;
}

/** 正文超长时按码点截断并补省略号。 */
export function truncateTodoText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('') + '…';
}

/**
 * 一条提醒的气泡文案。
 *
 * @param todo - 有期限且未完成的待办。
 * @param now - 当前时刻（epoch ms），用于判断还剩多久。
 * @returns 一句可以直接说出口的提醒。
 */
export function reminderText(todo: TodoRecord, now: number): string {
  const label = truncateTodoText(todo.text, REMINDER_TEXT_MAX);
  const dueAt = todo.dueAt ?? now;
  if (dueAt <= now) {
    // 刚过点不到一分钟不说「逾期 1 分钟」——那只是四舍五入，读起来像迟到了很久。
    if (now - dueAt < MINUTE_MS) return `「${label}」到点啦，记得处理`;
    return `「${label}」已经逾期${spanText(now - dueAt)}啦，记得处理`;
  }
  return `「${label}」还有${spanText(dueAt - now)}就到点啦`;
}
