/**
 * 时间背景（host 半侧，纯逻辑）：把「现在几点」翻成一段中文上下文，由 index.ts 的
 * petSystemPrompt 追加到 system 末尾——碎碎念与对话共用同一份拼装，故一处生效、两端都有。
 *
 * 设计：
 * - **本机时间**：读 Date 的本地时间字段（getHours / getDay / …），不用 Intl.DateTimeFormat——
 *   桌宠说「晚上好」要跟着用户所在时区走，而 Intl 会额外牵进 locale 与时区口径的变量；
 * - **Date 由调用方传入**：本模块内部**不读时钟**（不 new Date()），每一档边界才能在测试里钉死；
 * - 非法 Date → 返回空串：调用方据此整行不加，绝不把 NaN 年/月/日塞进提示词（宁可没有时间信息）；
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

/**
 * 生成注入 system 末尾的时间背景（一行）。
 * @param date 当前时刻（生产调用方传 new Date()；测试传固定日期）
 * @returns 形如
 *   `【时间背景】2026年2月17日 星期二 21:14（晚上·工作日）。说话时可以自然带上当下时间的感觉，但不必刻意报时。`
 *   非法 Date → 空串（调用方据此不加这一行）
 */
export function timeContextOf(date: Date): string {
  // 非法 Date 的 getFullYear()/getDay() 都返回 NaN，直接拼会产出「NaN年NaN月」——显式挡掉
  if (Number.isNaN(date.getTime())) return '';
  const day = date.getDay();
  const hour = date.getHours();
  return (
    '【时间背景】' +
    date.getFullYear() +
    '年' +
    (date.getMonth() + 1) +
    '月' +
    date.getDate() +
    '日 ' +
    (WEEKDAYS[day] ?? '星期?') +
    ' ' +
    pad2(hour) +
    ':' +
    pad2(date.getMinutes()) +
    '（' +
    timeSlotOf(hour) +
    '·' +
    dayKindOf(day) +
    '）。说话时可以自然带上当下时间的感觉，但不必刻意报时。'
  );
}
