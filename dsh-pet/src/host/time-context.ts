/**
 * 时间背景（host 半侧，纯逻辑）：把「现在几点 + 今天是不是什么日子」翻成一段中文上下文，
 * 由 index.ts 的 petSystemPrompt 追加到 system 末尾——碎碎念与对话共用同一份拼装，故一处生效、两端都有。
 *
 * 设计：
 * - **本机时间**：读 Date 的本地时间字段（getHours / getDay / …），不用 Intl 做时区换算——
 *   桌宠说「晚上好」要跟着用户所在时区走；
 * - **农历零依赖**：春节/中秋等用 ICU 自带的「中国农历」日历（`en-u-ca-chinese`）换算，不引第三方库。
 *   ⚠️ **已知精度边界（已评估并接受）**：朔时刻贴近 UTC+8 午夜时，ICU 会把农历初一放错一天。
 *   实测 2025–2060 的 445 个农历月起点里错 2 个，且都是正月——2027-02-06（距午夜 8 分钟，ICU 记 02-07）、
 *   2030-02-03（距午夜 5 分钟，ICU 记 02-02），表现为这两年春节与元宵各差一天。
 *   2027 一例已与香港天文台官方对照表核对（HKO 记 2027/2/6 为正月初一）。其余 9 个农历节日不受影响。
 *   将来若要求绝对准确：只需替换 lunarPartsOf 的实现（换库或加修正表），下游逻辑一行不用动。
 * - **节日长度与前后窗口是三件独立的事**：`ahead` = 提前多少天预热；`span` = 节日/假期本身持续多少天
 *   （期间说「还在X假期里」，最后一天说「假期最后一天了」）；`after` = 过后多少天还回味。缺省 3 / 1 / 3。
 * - ★ **PRIORITY 数组的顺序就是说话优先级：靠前的先说话**（与 memes「书写顺序 = 生效顺序」同一套思路）。
 *   一天只出一个从句，所以同一天被多个节日/假期覆盖时，谁在数组里靠前就由谁说。想改优先级就挪那几行，
 *   不必动任何逻辑。数组里那几处 `ahead / after` 微调（情人节 after:0、除夕 ahead:1、清明 ahead:1 等）
 *   都是为了让「只有当天值得说」的节日不被邻座节日的预热窗或回味窗挤掉，注释已逐条说明。
 * - **假期区间（寒暑假）**是另一类：一整段**公历区间**而非「某天 + 持续 N 天」，且中国没有全国统一日期
 *   （各省校历不同）——按**大致区间**写死（寒假 1/20–2/18、暑假 7/1–8/29），要精确到校历就得改成可配置项；
 * - **Date 由调用方传入**：本模块内部**不读时钟**（不 new Date()），每一档边界才能在测试里钉死；
 * - 非法 Date → 返回空串：调用方据此整行不加，绝不把 NaN 年/月/日塞进提示词；
 * - 纯函数、零依赖、不碰 IO，故能在 node:test 里直接跑（不必起宿主）。
 */

/** 时段文案：一天分 9 档（划分见 SLOTS） */
export type TimeSlot = '凌晨' | '清晨' | '早上' | '上午' | '中午' | '下午' | '傍晚' | '晚上' | '深夜';

/**
 * 时段划分表：[起始小时, 时段]，**按起始小时从晚到早**排列——匹配时取第一个不超过当前小时的档。
 * 口径（含起始小时，0–23 全覆盖、不重叠）：
 *   凌晨 0–4 / 清晨 5–6 / 早上 7–8 / 上午 9–10 / 中午 11–12 / 下午 13–16 / 傍晚 17–18 / 晚上 19–22 / 深夜 23
 */
const SLOTS: ReadonlyArray<readonly [number, TimeSlot]> = [
  [23, '深夜'],
  [19, '晚上'],
  [17, '傍晚'],
  [13, '下午'],
  [11, '中午'],
  [9, '上午'],
  [7, '早上'],
  [5, '清晨'],
  [0, '凌晨'],
];

/** 星期文案：索引 = Date.getDay()（0 = 周日） */
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const;

/** 一天毫秒数（日期算术用 UTC 毫秒，避开本地时区） */
const DAY_MS = 86_400_000;

/** 缺省窗口：提前 3 天预热、本身 1 天、过后 3 天回味 */
const DEFAULT_AHEAD = 3;
const DEFAULT_SPAN = 1;
const DEFAULT_AFTER = 3;

/** 假期区间的窗口：提前 3 天预热、末尾 3 天说「快结束了」、结束后 3 天回味 */
const SEASON_AHEAD = 3;
const SEASON_ENDING_AHEAD = 3;
const SEASON_AFTER = 3;

/** 两位补零（只用于时分；月/日刻意不补零——中文日期写「2月17日」比「02月17日」自然） */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 小时 → 时段。
 * @param hour 小时数（来自 Date.getHours()，正常为 0–23）
 * @returns 对应时段；越界/NaN（异常输入）按「凌晨」兜底、绝不抛错——提示词路径不能因为时间格式问题失败
 */
export function timeSlotOf(hour: number): TimeSlot {
  for (const [start, slot] of SLOTS) {
    if (hour >= start) return slot;
  }
  return '凌晨';
}

/**
 * 星期几 → 工作日 / 周末（周六周日算周末；与余额低谷判定同一口径，见 balance/deepseek-common.ts）。
 * @param day Date.getDay()（0 = 周日）
 * @returns 「周末」（周六/周日）或「工作日」
 */
export function dayKindOf(day: number): '工作日' | '周末' {
  return day === 0 || day === 6 ? '周末' : '工作日';
}

/** 节日/假期条目的公共字段 */
interface EntryBase {
  /** 正式名：节前/节中/节后措辞用它（「快要过春节了」「还在春节假期里」） */
  name: string;
  /** 当天的口语名：用于「今天是…」；缺省 = 用 name */
  spoken?: string;
  ahead?: number;
  span?: number;
  after?: number;
}

/** 节日/假期条目（判别联合：公历日 / 农历日 / 除夕 / 假期区间） */
type Entry = EntryBase &
  (
    | { kind: 'solar'; key: string }
    | { kind: 'lunar'; key: string }
    | { kind: 'lunarEve' }
    | { kind: 'season'; from: string; to: string }
  );

/**
 * ★ 顺序 = 优先级（靠前的先说话）。编排口径：
 *   ① 只有「当天」值得说、且会被邻座节日窗口挤掉的小节（情人节 / 跨年夜 / 愚人节 / 青年节）排在各自邻座之前，
 *      并用 after: 0 掐掉回味，免得反过来压住邻座的当天；
 *   ② 除夕、元宵必须排在春节之前：否则 2/16 会说「明天就是春节」、3/3 会说「春节假期最后一天」，
 *      而不是「今天是除夕」「今天是元宵节」；
 *   ③ 大节与家庭假期（春节 / 中秋 / 国庆 / 元旦 / 端午 / 清明 / 劳动节 / 寒暑假）在中段，
 *      传统节日（七夕 / 中元 / 龙抬头 / 重阳 / 腊八 / 小年）紧随其后并**排在寒暑假之前**——
 *      所以暑假里的七夕、寒假里的小年照常由节日说话；
 *   ④ 纪念日类（妇女节 / 教师节 / 建党节 / 建军节 / 万圣夜 / 平安夜 / 圣诞节）排在最后，
 *      因此暑假期间的建党节（7/1）、建军节（8/1）会让位给「正在放暑假」。
 *   ⑤ 寒暑假区间放在中段之后、纪念日之前：7/1 既是建党节又是暑假首日，按本顺序由「暑假开始了」说话。
 */
const PRIORITY: readonly Entry[] = [
  // —— 小节：只有当天值得说，排在邻座之前并掐掉回味 ——
  { kind: 'solar', key: '2-14', name: '情人节', after: 0 }, // 不让春节的 3 天前窗吃掉情人节当天
  { kind: 'solar', key: '12-31', name: '跨年夜', after: 0 }, // 排在元旦前：12/31 说跨年夜，1/1 说元旦
  { kind: 'solar', key: '4-1', name: '愚人节', after: 0 }, // 排在清明前，否则 4/1 会说「快要过清明节了」
  { kind: 'solar', key: '5-4', name: '青年节', ahead: 0, after: 0 }, // 排在劳动节前，否则 5/4 被劳动节回味压掉；不留前后窗，免得抢 5/3 的最后一天

  // —— 春节一族：除夕、元宵必须在春节之前 ——
  // ahead:1 → 2/15 起才预热，免得 2/14 就说「快要过除夕了」；after:0 → 2/17 交给春节当天，不说「除夕刚过完」
  { kind: 'lunarEve', name: '除夕', ahead: 1, after: 0 },
  { kind: 'lunar', key: '1-15', name: '元宵节' },
  { kind: 'lunar', key: '1-1', name: '春节', spoken: '大年初一', span: 15 }, // 正月初一 → 正月十五

  // —— 大节（假期长度按各自实际）——
  { kind: 'lunar', key: '8-15', name: '中秋节', span: 3, after: 2 }, // 中秋假期 3 天；小节过去就过去了
  { kind: 'solar', key: '10-1', name: '国庆节', span: 7 }, // 国庆假期 7 天
  { kind: 'solar', key: '1-1', name: '元旦', spoken: '新年第一天', span: 3 }, // 元旦假期 3 天
  { kind: 'lunar', key: '5-5', name: '端午节', span: 3 },
  { kind: 'solar', key: '4-4', name: '清明节', span: 3, ahead: 1 }, // 大致 4/4 起 3 天（真日期为节气 4/4 或 4/5）；ahead:1 让出 4/1–4/2 给愚人节
  { kind: 'solar', key: '5-1', name: '劳动节', span: 3 },
  { kind: 'solar', key: '6-1', name: '儿童节' },

  // —— 传统节日：排在寒暑假之前，假期里照常过节 ——
  { kind: 'lunar', key: '7-7', name: '七夕' },
  { kind: 'lunar', key: '7-15', name: '中元节' },
  { kind: 'lunar', key: '2-2', name: '龙抬头' },
  { kind: 'lunar', key: '9-9', name: '重阳节' },
  { kind: 'lunar', key: '12-8', name: '腊八节' },
  { kind: 'lunar', key: '12-23', name: '小年' },

  // —— 假期区间（大致区间，非校历）——
  { kind: 'season', from: '1-20', to: '2-18', name: '寒假' }, // 30 天
  { kind: 'season', from: '7-1', to: '8-29', name: '暑假' }, // 60 天

  // —— 纪念日类：排在假期之后，假期里让位给假期 ——
  { kind: 'solar', key: '3-8', name: '妇女节' },
  { kind: 'solar', key: '9-10', name: '教师节' },
  { kind: 'solar', key: '7-1', name: '建党节' },
  { kind: 'solar', key: '8-1', name: '建军节' },
  { kind: 'solar', key: '10-31', name: '万圣夜' },
  // 平安夜排在圣诞节之前（12/24 说平安夜），after:0 让它别用回味吃掉 12/25 的圣诞节当天
  { kind: 'solar', key: '12-24', name: '平安夜', after: 0 },
  { kind: 'solar', key: '12-25', name: '圣诞节' },
];

/** 带优先级的条目（priority = 在 PRIORITY 里的下标，越小越优先） */
interface RankedEntry {
  entry: Entry;
  priority: number;
}

/** 公历 / 农历 / 除夕 / 假期区间的索引（模块加载时按 PRIORITY 建一次） */
const SOLAR_INDEX = new Map<string, RankedEntry>();
const LUNAR_INDEX = new Map<string, RankedEntry>();
const SEASON_ENTRIES: Array<RankedEntry & { from: string; to: string }> = [];
let LUNAR_EVE: RankedEntry | undefined;

PRIORITY.forEach((entry, priority) => {
  if (entry.kind === 'solar') SOLAR_INDEX.set(entry.key, { entry, priority });
  else if (entry.kind === 'lunar') LUNAR_INDEX.set(entry.key, { entry, priority });
  else if (entry.kind === 'lunarEve') LUNAR_EVE = { entry, priority };
  else SEASON_ENTRIES.push({ entry, priority, from: entry.from, to: entry.to });
});

/** 候选从句（连同优先级） */
interface Candidate {
  clause: string;
  priority: number;
}

/** 农历月日（ICU 换算结果） */
interface LunarParts {
  /** 农历月：1–12；**闰月取负**（闰六月 = -6），与平月区分开 */
  month: number;
  /** 农历日：1–30 */
  day: number;
}

/** ICU 中国农历格式器；null = 已判定本环境不可用（不重试、不抛错） */
let lunarFormatter: Intl.DateTimeFormat | null | undefined;

/**
 * 取 ICU 农历格式器。
 * Intl 在缺少该日历时**不会抛错**，而是静默退回公历——那会让每个月都被当成农历同月同日，
 * 所以这里用 resolvedOptions().calendar 确认它真的解析成了 'chinese'，否则一律判不可用。
 */
function getLunarFormatter(): Intl.DateTimeFormat | undefined {
  if (lunarFormatter === null) return undefined;
  if (!lunarFormatter) {
    const fmt = new Intl.DateTimeFormat('en-u-ca-chinese', { month: 'numeric', day: 'numeric', year: 'numeric' });
    lunarFormatter = fmt.resolvedOptions().calendar === 'chinese' ? fmt : null;
  }
  return lunarFormatter ?? undefined;
}

/** 年内日序号（0 起，按 UTC 计算，闰年自然正确）——假期区间比较用它 */
function dayOfYear(date: Date): number {
  return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / DAY_MS;
}

/** '月-日' → 该年内的日序号（0 起） */
function dayOfYearOf(year: number, monthDay: string): number {
  const [month, day] = monthDay.split('-').map(Number);
  return (Date.UTC(year, (month ?? 1) - 1, day ?? 1) - Date.UTC(year, 0, 1)) / DAY_MS;
}

/**
 * 公历日期 → 农历月日。
 * @returns 农历月/日（闰月 month 为负）；环境不支持农历、取不到月日，或**农历年与公历年不吻合**
 *   （自洽校验，合理范围：公历年或公历年 − 1，用于挡住 ICU 退化时把公历当农历返回）→ undefined。
 */
function lunarPartsOf(date: Date): LunarParts | undefined {
  const fmt = getLunarFormatter();
  if (!fmt) return undefined;
  const parts = fmt.formatToParts(date);
  const pick = (type: string): string | undefined => parts.find((p) => p.type === type)?.value;
  const rawMonth = pick('month');
  const rawDay = pick('day');
  const rawYear = pick('relatedYear') ?? pick('year');
  if (!rawMonth || !rawDay || !rawYear) return undefined;
  const month = Number.parseInt(rawMonth, 10);
  const day = Number.parseInt(rawDay, 10);
  const year = Number.parseInt(rawYear, 10);
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return undefined;
  const gregorianYear = date.getFullYear();
  // 农历年只会是当年或前一年（春节前的 1–2 月仍属上一个农历年）
  if (year !== gregorianYear && year !== gregorianYear - 1) return undefined;
  return { month: /bis/i.test(rawMonth) ? -month : month, day };
}

/** 当天是否是除夕（腊月最后一天：次日为正月初一即成立，廿九/三十都能认） */
function isLunarEve(date: Date): boolean {
  const today = lunarPartsOf(date);
  if (!today || today.month !== 12) return false;
  const next = lunarPartsOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
  return Boolean(next && next.month === 1 && next.day === 1);
}

/** 某一天命中的全部条目（公历、农历、除夕三类；假期区间不按天查，另行处理） */
function entriesAt(date: Date): RankedEntry[] {
  const out: RankedEntry[] = [];
  const solar = SOLAR_INDEX.get(date.getMonth() + 1 + '-' + date.getDate());
  if (solar) out.push(solar);
  const lunar = lunarPartsOf(date);
  // 闰月（month < 0）不参与匹配：闰五月初五不是端午
  if (lunar && lunar.month > 0) {
    const hit = LUNAR_INDEX.get(lunar.month + '-' + lunar.day);
    if (hit) out.push(hit);
  }
  if (LUNAR_EVE && isLunarEve(date)) out.push(LUNAR_EVE);
  return out;
}

/**
 * 相位 → 从句措辞。
 * @param delta 相对**节日起始日**的天数：> 0 = 还有这么多天；0 = 起始当天；< 0 = 已在节期内或过后
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
 * @param delta 相对节日起始日的天数
 */
function candidateOf(ranked: RankedEntry, delta: number): Candidate | undefined {
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
  return { clause: phraseOf(entry, delta), priority };
}

/** 假期区间 → 候选从句（不在窗口内返回 undefined） */
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

/** 条目里最长的预热天数与回看距离（长假 15 天 + 回味 3 天），据此决定扫描窗口 */
const HOLIDAY_ENTRIES = PRIORITY.filter((e) => e.kind !== 'season');
const MAX_AHEAD = Math.max(...HOLIDAY_ENTRIES.map((e) => e.ahead ?? DEFAULT_AHEAD));
const MAX_LOOKBACK = Math.max(...HOLIDAY_ENTRIES.map((e) => (e.span ?? DEFAULT_SPAN) - 1 + (e.after ?? DEFAULT_AFTER)));

/**
 * 节日从句：扫描窗口内枚举每一天命中的条目、算出各自相位与措辞，取**优先级最小**（数组里最靠前）的那个。
 * @returns 如「今天是大年初一」「快要过国庆节了」「还在春节假期里」「正在放暑假」；无节日时 ''
 */
function holidayClauseOf(date: Date): string {
  let best: Candidate | undefined;
  const keep = (candidate: Candidate | undefined): void => {
    if (candidate && (!best || candidate.priority < best.priority)) best = candidate;
  };
  for (let delta = -MAX_LOOKBACK; delta <= MAX_AHEAD; delta++) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
    for (const ranked of entriesAt(day)) keep(candidateOf(ranked, delta));
  }
  keep(seasonCandidateOf(date));
  return best ? best.clause : '';
}

/**
 * 生成注入 system 末尾的时间背景（一行）。
 * @param date 当前时刻（生产调用方传 new Date()；测试传固定日期）
 * @returns 形如
 *   `【当下】现在是2026年10月8日星期四 21:32，晚上，工作日，国庆节刚过完。这只是背景，不必刻意报时，也别句句都提节日。`
 *   无节日时中间那一段省略；非法 Date → 空串（调用方据此不加这一行）
 */
export function timeContextOf(date: Date): string {
  // 非法 Date 的 getFullYear()/getDay() 都返回 NaN，直接拼会产出「NaN年NaN月」——显式挡掉
  if (Number.isNaN(date.getTime())) return '';
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
