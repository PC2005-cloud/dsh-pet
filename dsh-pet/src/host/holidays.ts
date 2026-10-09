import { createStartupData, fetchFresh } from './startup-data';

export interface HolidayCalendar {
  year: number;
  papers: string[];
  days: Array<{ date: string; name: string; isOffDay: boolean }>;
}
export const holidayUrl = (year: string | number) =>
  `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;
export const beijingDate = (time: number) => new Date(time + 8 * 3600_000).toISOString().slice(0, 10);

/** 拒绝错误年份、无公告来源、空表、无效日期和冲突日期，不把“更新失败”解释为无节假日。 */
export function validHolidayCalendar(value: unknown, key: string): value is HolidayCalendar {
  if (!value || typeof value !== 'object') return false;
  const data = value as HolidayCalendar;
  if (
    data.year !== Number(key) ||
    !Array.isArray(data.papers) ||
    !data.papers.length ||
    !data.papers.every((url) => {
      try {
        return /(^|\.)gov\.cn$/.test(new URL(url).hostname);
      } catch {
        return false;
      }
    }) ||
    !Array.isArray(data.days) ||
    !data.days.length ||
    data.days.length > 100
  )
    return false;
  const dates = new Set<string>();
  for (const day of data.days) {
    if (
      !day ||
      typeof day.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
      !Number.isFinite(Date.parse(day.date)) ||
      new Date(day.date).toISOString().slice(0, 10) !== day.date ||
      Math.abs(Number(day.date.slice(0, 4)) - data.year) > 1 ||
      typeof day.isOffDay !== 'boolean' ||
      typeof day.name !== 'string' ||
      !day.name ||
      dates.has(day.date)
    )
      return false;
    dates.add(day.date);
  }
  return data.days.some((day) => day.isOffDay && day.date.startsWith(key + '-'));
}

// 仅作为首次离线启动的明确兜底；联网结果与持久缓存优先。
const FALLBACK_2026: HolidayCalendar = {
  year: 2026,
  papers: ['https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm'],
  days: [
    ['01-01', 3],
    ['02-15', 9],
    ['04-04', 3],
    ['05-01', 5],
    ['06-19', 3],
    ['09-25', 3],
    ['10-01', 7],
  ].flatMap(([start, length]) =>
    Array.from({ length: Number(length) }, (_, i) => ({
      date: new Date(Date.parse('2026-' + start) + i * 86400_000).toISOString().slice(0, 10),
      name: '节假日',
      isOffDay: true,
    })),
  ),
};

export function createHolidayManager(cacheFile?: string, now = Date.now) {
  const year = () => Number(beijingDate(now()).slice(0, 4));
  const store = createStartupData<HolidayCalendar>({
    cacheFile,
    keys: () => [String(year()), String(year() + 1)],
    valid: validHolidayCalendar,
    fallback: (key) => (key === '2026' ? FALLBACK_2026 : undefined),
    fetch: async (key, signal) => JSON.parse(await fetchFresh(holidayUrl(key), signal)),
  });
  const isHoliday = (time: number): boolean | undefined => {
    const date = beijingDate(time);
    const y = Number(date.slice(0, 4));
    const current = store.current(String(y));
    const next = store.current(String(y + 1));
    // 次年公告可能修订本年十二月，优先取较新年度的明确条目。
    const entry = next?.days.find((d) => d.date === date) ?? current?.days.find((d) => d.date === date);
    return entry ? entry.isOffDay : current ? false : undefined;
  };
  return {
    start: store.start,
    refresh: store.refresh,
    dispose: store.dispose,
    isHoliday,
    status: () => ({
      date: beijingDate(now()),
      isHoliday: isHoliday(now()) ?? null,
      years: Object.fromEntries(
        [year(), year() + 1].map((y) => [
          y,
          { ...store.status(String(y)), url: holidayUrl(y), papers: store.current(String(y))?.papers ?? [] },
        ]),
      ),
    }),
  };
}

/** 周末即使调休上班也按 DeepSeek 的周末空闲价；未知年度不猜测工作日节假日。 */
export function peakAt(time: number, isHoliday: (time: number) => boolean | undefined): boolean | undefined {
  const d = new Date(time + 8 * 3600_000);
  if (
    d.getUTCDay() === 0 ||
    d.getUTCDay() === 6 ||
    !((d.getUTCHours() >= 9 && d.getUTCHours() < 12) || (d.getUTCHours() >= 14 && d.getUTCHours() < 18))
  )
    return false;
  const holiday = isHoliday(time);
  return holiday === undefined ? undefined : !holiday;
}
