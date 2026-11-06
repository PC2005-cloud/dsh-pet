/**
 * 消息时间戳的展示格式。
 *
 * 纯函数：`now` 由调用方传入，不读时钟，便于测试。今天的消息只给时间，
 * 更早的补上日期——聊天记录跨天时，光看 `08:26:46` 分不清是哪天。
 * @module dsh-pet/src/client/chat/stamp
 */
import type { ChatTranslate } from './runtime.ts';

/** 一天的毫秒数；只用于算「差几天」，日界按本地时区取整。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 两位补零。 */
const pad = (value: number): string => String(value).padStart(2, '0');

/** 时:分:秒。 */
const clockOf = (date: Date): string =>
  pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());

/** 本地日界的时间戳（当天 00:00）。 */
const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * 时间戳 → 展示文本。
 *
 * @param ts - 消息时间戳（毫秒）；非正数视为没有时间。
 * @param now - 当前时刻（毫秒），由调用方注入。
 * @param t - 文案翻译；日期格式由字典按语言给出，不在代码里写死中文。
 * @returns 今天 `HH:mm:ss`；昨天带「昨天」；同年补月日；跨年补年份。
 */
export function formatStamp(ts: number, now: number, t: ChatTranslate): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const date = new Date(ts);
  const today = new Date(now);
  const days = Math.round((startOfDay(today) - startOfDay(date)) / DAY_MS);
  const clock = clockOf(date);
  if (days <= 0) return clock; // 今天（以及时钟偏差导致的「未来」都按今天处理）
  if (days === 1) return t('stampYesterday') + ' ' + clock;
  const monthDay = t('stampMonthDay', { month: date.getMonth() + 1, day: date.getDate() });
  if (date.getFullYear() === today.getFullYear()) return monthDay + ' ' + clock;
  return (
    t('stampFullDate', { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }) + ' ' + clock
  );
}
