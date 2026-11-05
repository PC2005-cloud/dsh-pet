/**
 * 文案组装：把命中的节日、节气与时段拼成一句话，另提供历史消息用的时间前缀。
 *
 * 不读时钟、不碰 IO；候选由 ./lunar 提供。
 * 必须始终成立：同一日期多次调用结果一致，不依赖调用顺序。
 * @module dsh-pet/src/host/time-context/context
 */
import { MAX_AHEAD, MAX_LOOKBACK, SEASON_ENTRIES } from './entries.ts';
import type { Candidate, Entry, RankedEntry } from './entries.ts';
import {
  DEFAULT_AFTER,
  DEFAULT_AHEAD,
  DEFAULT_SPAN,
  SEASON_AFTER,
  SEASON_AHEAD,
  SEASON_ENDING_AHEAD,
  WEEKDAYS,
  dayKindOf,
  pad2,
  timeSlotOf,
} from './constants.ts';
import { dayOfYear, dayOfYearOf, entriesAt } from './lunar.ts';

/**
 * 相位 → 从句措辞。
 * @param entry - 节日条目；`name`/`spoken`/`span` 决定措辞与默认窗口。
 * @param delta - 相对节日起始日的天数：> 0 = 还有这么多天；0 = 起始当天；< 0 = 已在节期内或过后。
 */
function phraseOf(entry: Entry, delta: number): string {
  const span = entry.span ?? DEFAULT_SPAN;
  if (delta > 0) return delta === 1 ? '明天就是' + entry.name : '快要过' + entry.name + '了';
  if (delta === 0) return '今天是' + (entry.spoken ?? entry.name);
  // 节期内（长假分段说，避免十几天重复同一句）：进入节日体的第 daysIn + 1 天
  const daysIn = -delta;
  if (daysIn < span) {
    return span - daysIn === 1 ? entry.name + '假期最后一天了' : '还在' + entry.name + '假期里';
  }
  // 节后：rest 是「结束后第几天」（0 起）
  const rest = daysIn - span;
  return rest <= 1 ? entry.name + '刚过完' : entry.name + '这么快就过完了';
}

/**
 * 条目 → 候选从句（不在自身窗口内则返回 undefined）。
 * @param ranked - 已排序条目；`priority` 高者先出候选。
 * @param delta - 相对节日起始日的天数。
 */
function candidateOf(
  ranked: RankedEntry,
  delta: number,
  phrase: (entry: Entry, delta: number) => string = phraseOf,
): Candidate | undefined {
  const { entry, priority } = ranked;
  const ahead = entry.ahead ?? DEFAULT_AHEAD;
  const span = entry.span ?? DEFAULT_SPAN;
  const after = entry.after ?? DEFAULT_AFTER;
  const daysIn = -delta;
  if (delta > 0) {
    if (delta > ahead) return undefined;
  } else if (delta < 0) {
    if (daysIn >= span + after) return undefined;
  }
  return { clause: phrase(entry, delta), priority };
}

/** 假期区间 → 候选从句（不在窗口内返回 undefined）。 */
function seasonCandidateOf(date: Date): Candidate | undefined {
  const year = date.getFullYear();
  const today = dayOfYear(date);
  for (const ranked of SEASON_ENTRIES) {
    const { entry, priority, from: fromMd, to: toMd } = ranked;
    const name = entry.name;
    const from = dayOfYearOf(year, fromMd);
    const to = dayOfYearOf(year, toMd);
    if (today < from) {
      const ahead = from - today;
      if (ahead > SEASON_AHEAD) continue;
      return { clause: ahead === 1 ? '明天就放' + name + '了' : '快要放' + name + '了', priority };
    }
    if (today <= to) {
      if (today === from) return { clause: name + '开始了', priority };
      if (to - today < SEASON_ENDING_AHEAD) return { clause: name + '快结束了', priority };
      return { clause: '正在放' + name, priority };
    }
    const rest = today - to - 1;
    if (rest >= SEASON_AFTER) continue;
    return { clause: rest <= 1 ? name + '刚结束' : name + '这么快就过完了', priority };
  }
  return undefined;
}

/**
 * 节日从句：扫描窗口内枚举每一天命中的条目、算出各自相位与措辞，取优先级最小（数组里最靠前）的那个。
 * @returns 如「今天是大年初一」「快要过国庆节了」「还在春节假期里」「正在放暑假」；无节日时 ''。
 */
function holidayClauseOf(
  date: Date,
  phrase: (entry: Entry, delta: number) => string = phraseOf,
  season: (date: Date) => Candidate | undefined = seasonCandidateOf,
): string {
  let best: Candidate | undefined;
  const keep = (candidate: Candidate | undefined): void => {
    if (candidate && (!best || candidate.priority < best.priority)) best = candidate;
  };
  for (let delta = -MAX_LOOKBACK; delta <= MAX_AHEAD; delta++) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
    for (const ranked of entriesAt(day)) keep(candidateOf(ranked, delta, phrase));
  }
  keep(season(date));
  return best ? best.clause : '';
}

/** 时段与星期的俄文说法。区间仍由 timeSlotOf / dayKindOf 决定，这里只翻译已经算出来的词。 */
const SLOT_RU: Readonly<Record<string, string>> = {
  凌晨: 'глубокая ночь',
  清晨: 'раннее утро',
  早上: 'утро',
  上午: 'позднее утро',
  中午: 'полдень',
  下午: 'день',
  傍晚: 'вечер',
  晚上: 'поздний вечер',
  深夜: 'ночь',
};
const WEEK_RU: Readonly<Record<string, string>> = {
  星期日: 'воскресенье',
  星期一: 'понедельник',
  星期二: 'вторник',
  星期三: 'среда',
  星期四: 'четверг',
  星期五: 'пятница',
  星期六: 'суббота',
};
const KIND_RU: Readonly<Record<string, string>> = {
  工作日: 'будний день',
  周末: 'выходной',
};

/** 节日从句的俄文套话。节日名仍用那一张农历表里的中文，不另做一份日历。 */
function phraseRu(entry: Entry, delta: number): string {
  const span = entry.span ?? DEFAULT_SPAN;
  const name = entry.name;
  if (delta > 0) return delta === 1 ? 'завтра ' + name : 'скоро ' + name;
  if (delta === 0) return 'сегодня ' + (entry.spoken ?? name);
  const daysIn = -delta;
  if (daysIn < span) return span - daysIn === 1 ? 'последний день ' + name : 'еще каникулы ' + name;
  const rest = daysIn - span;
  return rest <= 1 ? name + ' только что прошел' : name + ' уже прошел';
}

/** 假期区间的俄文套话，窗口与 {@link seasonCandidateOf} 相同。 */
function seasonCandidateRu(date: Date): Candidate | undefined {
  const year = date.getFullYear();
  const today = dayOfYear(date);
  for (const ranked of SEASON_ENTRIES) {
    const { entry, priority, from: fromMd, to: toMd } = ranked;
    const name = entry.name;
    const from = dayOfYearOf(year, fromMd);
    const to = dayOfYearOf(year, toMd);
    if (today < from) {
      const ahead = from - today;
      if (ahead > SEASON_AHEAD) continue;
      return { clause: ahead === 1 ? 'завтра каникулы ' + name : 'скоро каникулы ' + name, priority };
    }
    if (today <= to) {
      if (today === from) return { clause: name + ' начались', priority };
      if (to - today < SEASON_ENDING_AHEAD) return { clause: name + ' скоро кончатся', priority };
      return { clause: 'идут каникулы ' + name, priority };
    }
    const rest = today - to - 1;
    if (rest >= SEASON_AFTER) continue;
    return { clause: rest <= 1 ? name + ' только что кончились' : name + ' уже кончились', priority };
  }
  return undefined;
}

/** ru 的时间背景：套话是俄语，节日名留在中文表里。 */
function timeContextRu(date: Date): string {
  const day = date.getDay();
  const hour = date.getHours();
  const holiday = holidayClauseOf(date, phraseRu, seasonCandidateRu);
  const parts = [
    date.getDate() + '.' + (date.getMonth() + 1) + '.' + date.getFullYear(),
    WEEK_RU[WEEKDAYS[day] ?? ''] ?? '',
    pad2(hour) + ':' + pad2(date.getMinutes()),
    SLOT_RU[timeSlotOf(hour)] ?? '',
    KIND_RU[dayKindOf(day)] ?? '',
    holiday,
  ].filter((part) => part !== '');
  return (
    'Сейчас ' + parts.join(', ') + '. Это только фон: не сообщай время нарочно и не упоминай праздник в каждой фразе.'
  );
}

/**
 * 生成注入 system 末尾的时间背景（一行）。
 * @param date - 当前时刻（生产调用方传 new Date()；测试传固定日期）。
 * @returns 形如
 *   `【当下】现在是2026年10月8日星期四 21:32，晚上，工作日，国庆节刚过完。这只是背景，不必刻意报时，也别句句都提节日。`
 *   无节日时中间那一段省略；非法 Date → 空串（调用方据此不加这一行）。
 */
export function timeContextOf(date: Date, localeId?: string | null): string {
  if (Number.isNaN(date.getTime())) return '';
  if (localeId === 'ru') return timeContextRu(date);
  const day = date.getDay();
  const hour = date.getHours();
  const holiday = holidayClauseOf(date);
  return (
    '【当下】现在是' +
    date.getFullYear() +
    '年' +
    (date.getMonth() + 1) +
    '月' +
    date.getDate() +
    '日' +
    (WEEKDAYS[day] ?? '星期?') +
    ' ' +
    pad2(hour) +
    ':' +
    pad2(date.getMinutes()) +
    '，' +
    timeSlotOf(hour) +
    '，' +
    dayKindOf(day) +
    (holiday ? '，' + holiday : '') +
    '。这只是背景，不必刻意报时，也别句句都提节日——多数时候正常说话就好，真贴切时才顺口带一句。'
  );
}

/**
 * 历史消息的时间前缀（对话历史专用）：`10月31日 22:53`，跨年时带年份。
 *
 * 不带方括号，由调用方决定怎么包；是否加前缀（阈值）也归调用方判断。
 *
 * @param ts - 那条消息的发送时刻（毫秒时间戳，`memory.json` 里每条都带）。
 * @param now - 当前时刻；与发送时刻不同年时前缀带年份，消掉“哪一年”的歧义。
 * @returns `ts` 或 `now` 非法时返回空串（调用方据此不加前缀，原样发送）。
 */
export function historyStampOf(ts: number, now: Date, localeId?: string | null): string {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime()) || Number.isNaN(now.getTime())) return '';
  if (localeId === 'ru') {
    const date = pad2(at.getDate()) + '.' + pad2(at.getMonth() + 1);
    const withYear = at.getFullYear() === now.getFullYear() ? date : date + '.' + at.getFullYear();
    return withYear + ' ' + pad2(at.getHours()) + ':' + pad2(at.getMinutes());
  }
  const date =
    (at.getFullYear() === now.getFullYear() ? '' : at.getFullYear() + '年') +
    (at.getMonth() + 1) +
    '月' +
    at.getDate() +
    '日';
  return date + ' ' + pad2(at.getHours()) + ':' + pad2(at.getMinutes());
}
