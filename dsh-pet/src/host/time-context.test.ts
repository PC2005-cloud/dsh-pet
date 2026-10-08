/**
 * 时间背景单元测试 —— 钉住注入 system 末尾的那一行文字：
 *  - 时段划分：0–23 点逐时映射（凌晨 0-4 / 清晨 5-6 / 早上 7-8 / 上午 9-10 / 中午 11-12 /
 *    下午 13-16 / 傍晚 17-18 / 晚上 19-22 / 深夜 23），含分钟边界不越档（04:59 仍凌晨、05:00 进清晨）；
 *  - 工作日 / 周末：周六周日 = 周末，与余额低谷判定同一口径；
 *  - 整行格式：不补零的月日 + 补零的时分 + 星期 + 时段 + 工作日或周末 + 可选节日从句 + **克制的引导语**；
 *  - 节日窗口：节前「快要过X了」/「明天就是X」、当天「今天是X」、
 *    **节期内**「还在X假期里」/「X假期最后一天了」（按各节日自己的 span）、
 *    节后「X刚过完」/「X这么快就过完了」（按各自的 after）；
 *  - 节日长度个性化：元旦/端午/清明/劳动节各 3 天、中秋 3 天、国庆 7 天、春节 15 天（除夕→正月十五）；
 *  - 假期区间：寒假 30 天、暑假 60 天；
 *  - **优先级 = PRIORITY 数组顺序（靠前的先说话）**：本文件逐条钉住几个真实冲突日的归属——
 *    2/14 情人节、2/16 除夕、3/3 元宵、4/1 愚人节、5/4 青年节、7/1 暑假、8/19 七夕、12/31 跨年夜；
 *  - 农历：春节/除夕/元宵/端午/中秋/腊八按 ICU 换算命中；**闰月不误判**（2028 闰五月初五不算端午）；
 *  - 非法 Date → 空串（调用方据此整行不加，绝不产出「NaN年NaN月」）。
 *
 * 日期期待值均有依据：农历日期经 ICU 换算，并抽样用天文朔与香港天文台对照表核对（见 time-context.ts
 * 头部对 ICU 边界精度的说明）。日期一律用 `new Date(y, m, d, h, min)` 的**本地时间**构造，与实现读本地
 * 字段同一口径，因此断言不随运行机器的时区变化。
 *
 * 未覆盖：ICU 不可用/退化时的降级分支（需要替换全局 Intl 才能构造，且模块内的格式器有惰性缓存，
 * 测试里改写全局状态会与其它用例相互干扰）——该分支靠代码审查保证，不在此处假装测过。
 *
 * 跑法：node --experimental-strip-types --test src/host/time-context.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dayKindOf, timeContextOf, timeSlotOf, type TimeSlot } from './time-context.ts';

/** 0–23 点逐时期望时段（改划分口径时必须同步这里，否则测试红） */
const EXPECTED_BY_HOUR: TimeSlot[] = [
  '凌晨',
  '凌晨',
  '凌晨',
  '凌晨',
  '凌晨',
  '清晨',
  '清晨',
  '早上',
  '早上',
  '上午',
  '上午',
  '中午',
  '中午',
  '下午',
  '下午',
  '下午',
  '下午',
  '傍晚',
  '傍晚',
  '晚上',
  '晚上',
  '晚上',
  '晚上',
  '深夜',
];

/** 注入文本的固定尾巴（引导语）——主张克制，避免模型句句都提时间/节日 */
const TAIL = '。这只是背景，不必刻意报时，也别句句都提节日——多数时候正常说话就好，真贴切时才顺口带一句。';

/** 断言注入文本含指定节日从句（从句在整行里以「，…。」出现） */
function assertClause(date: Date, clause: string): void {
  const text = timeContextOf(date);
  assert.ok(text.includes('，' + clause + '。'), `${date.toDateString()} 期望含「${clause}」，实际：${text}`);
}

/** 断言该日期没有任何节日从句（工作日/周末后直接接句号 + 引导语） */
function assertNoClause(date: Date): void {
  assert.match(timeContextOf(date), /(工作日|周末)。这只是背景/);
}

describe('timeSlotOf —— 小时 → 时段', () => {
  test('0–23 点逐时映射（钉死全部档位边界）', () => {
    const actual = Array.from({ length: 24 }, (_, h) => timeSlotOf(h));
    assert.deepEqual(actual, EXPECTED_BY_HOUR);
  });

  test('越界 / NaN → 凌晨兜底（不抛错，提示词路径不能因时间格式失败）', () => {
    assert.equal(timeSlotOf(-1), '凌晨');
    assert.equal(timeSlotOf(24), '深夜');
    assert.equal(timeSlotOf(Number.NaN), '凌晨');
  });
});

describe('dayKindOf —— 星期 → 工作日 / 周末', () => {
  test('周六（6）/ 周日（0）= 周末，周一至周五 = 工作日', () => {
    assert.equal(dayKindOf(0), '周末');
    assert.equal(dayKindOf(6), '周末');
    for (const day of [1, 2, 3, 4, 5]) {
      assert.equal(dayKindOf(day), '工作日');
    }
  });
});

describe('timeContextOf —— 整行格式（无节日）', () => {
  test('无节日时是完整的一行，且不含节日从句', () => {
    assert.equal(
      timeContextOf(new Date(2026, 4, 12, 15, 4)),
      '【当下】现在是2026年5月12日星期二 15:04，下午，工作日' + TAIL,
    );
  });

  test('时分补零、月日不补零', () => {
    assert.equal(
      timeContextOf(new Date(2026, 5, 5, 9, 7)),
      '【当下】现在是2026年6月5日星期五 09:07，上午，工作日' + TAIL,
    );
  });

  test('周六算周末', () => {
    assert.equal(
      timeContextOf(new Date(2026, 4, 9, 23, 59)),
      '【当下】现在是2026年5月9日星期六 23:59，深夜，周末' + TAIL,
    );
  });

  test('周日算周末、整点分钟补零', () => {
    assert.equal(
      timeContextOf(new Date(2026, 4, 10, 5, 0)),
      '【当下】现在是2026年5月10日星期日 05:00，清晨，周末' + TAIL,
    );
  });

  test('引导语克制：明确要求不必报时、别句句都提节日', () => {
    const text = timeContextOf(new Date(2026, 4, 12, 15, 4));
    assert.ok(text.includes('不必刻意报时'));
    assert.ok(text.includes('也别句句都提节日'));
  });

  test('分钟边界不越档：04:59 仍是凌晨、05:00 已进清晨', () => {
    assert.ok(timeContextOf(new Date(2026, 4, 12, 4, 59)).includes('，凌晨，工作日'));
    assert.ok(timeContextOf(new Date(2026, 4, 12, 5, 0)).includes('，清晨，工作日'));
  });

  test('分钟边界不越档：22:59 仍是晚上、23:00 已进深夜', () => {
    assert.ok(timeContextOf(new Date(2026, 4, 12, 22, 59)).includes('，晚上，工作日'));
    assert.ok(timeContextOf(new Date(2026, 4, 12, 23, 0)).includes('，深夜，工作日'));
  });

  test('非法 Date → 空串（整行不加，不产出 NaN 乱码）', () => {
    assert.equal(timeContextOf(new Date('not a date')), '');
  });
});

describe('节日 —— 单日节日（span = 1）', () => {
  test('当天：今天是国庆节', () => {
    assertClause(new Date(2026, 9, 1, 12, 0), '今天是国庆节');
  });

  test('当天用口语名：元旦说「新年第一天」', () => {
    assertClause(new Date(2026, 0, 1, 8, 0), '今天是新年第一天');
  });

  test('跨年夜：排在元旦之前，12/31 说跨年夜而不是「明天就是元旦」', () => {
    assertClause(new Date(2025, 11, 31, 20, 0), '今天是跨年夜');
  });

  test('平安夜排在圣诞节之前且不留回味：12/24 说平安夜、12/25 说圣诞节', () => {
    assertClause(new Date(2025, 11, 24, 20, 0), '今天是平安夜');
    assertClause(new Date(2025, 11, 25, 20, 0), '今天是圣诞节');
  });

  test('节前 +3 / +2 天：快要过儿童节了', () => {
    assertClause(new Date(2026, 4, 29, 10, 0), '快要过儿童节了');
    assertClause(new Date(2026, 4, 30, 10, 0), '快要过儿童节了');
  });

  test('节前 +1 天：明天就是儿童节', () => {
    assertClause(new Date(2026, 4, 31, 10, 0), '明天就是儿童节');
  });

  test('节后第 1 / 2 天：儿童节刚过完', () => {
    assertClause(new Date(2026, 5, 2, 10, 0), '儿童节刚过完');
    assertClause(new Date(2026, 5, 3, 10, 0), '儿童节刚过完');
  });

  test('节后第 3 天：儿童节这么快就过完了', () => {
    assertClause(new Date(2026, 5, 4, 10, 0), '儿童节这么快就过完了');
  });

  test('窗口外（前后第 4 天）不注入节日', () => {
    assertNoClause(new Date(2026, 4, 28, 10, 0));
    assertNoClause(new Date(2026, 5, 5, 10, 0));
  });
});

describe('节日 —— 长度个性化（span > 1，长假分三段）', () => {
  test('国庆 7 天：开始 → 假期中 → 最后一天 → 回味', () => {
    assertClause(new Date(2026, 9, 1, 10, 0), '今天是国庆节');
    assertClause(new Date(2026, 9, 5, 10, 0), '还在国庆节假期里');
    assertClause(new Date(2026, 9, 7, 10, 0), '国庆节假期最后一天了');
    assertClause(new Date(2026, 9, 8, 10, 0), '国庆节刚过完');
    assertClause(new Date(2026, 9, 10, 10, 0), '国庆节这么快就过完了');
    assertNoClause(new Date(2026, 9, 11, 10, 0));
  });

  test('元旦 3 天：假期中 → 最后一天 → 回味', () => {
    assertClause(new Date(2026, 0, 2, 10, 0), '还在元旦假期里');
    assertClause(new Date(2026, 0, 3, 10, 0), '元旦假期最后一天了');
    assertClause(new Date(2026, 0, 4, 10, 0), '元旦刚过完');
  });

  test('清明 3 天（大致 4/4 起）：愚人节次日才开始预热', () => {
    assertNoClause(new Date(2026, 3, 2, 10, 0));
    assertClause(new Date(2026, 3, 3, 10, 0), '明天就是清明节');
    assertClause(new Date(2026, 3, 4, 10, 0), '今天是清明节');
    assertClause(new Date(2026, 3, 6, 10, 0), '清明节假期最后一天了');
    assertClause(new Date(2026, 3, 7, 10, 0), '清明节刚过完');
  });

  test('劳动节 3 天与青年节让位：5/4 说青年节、5/5 再说劳动节', () => {
    assertClause(new Date(2026, 4, 1, 10, 0), '今天是劳动节');
    assertClause(new Date(2026, 4, 3, 10, 0), '劳动节假期最后一天了');
    assertClause(new Date(2026, 4, 4, 10, 0), '今天是青年节');
    assertClause(new Date(2026, 4, 5, 10, 0), '劳动节刚过完');
  });

  test('中秋 3 天：假期中与最后一天', () => {
    assertClause(new Date(2026, 8, 25, 10, 0), '今天是中秋节');
    assertClause(new Date(2026, 8, 26, 10, 0), '还在中秋节假期里');
    assertClause(new Date(2026, 8, 27, 10, 0), '中秋节假期最后一天了');
    // 中秋 after 只有 2 天，但优先级高于国庆：9/28 仍说中秋，9/30 才轮到国庆前夜
    assertClause(new Date(2026, 8, 28, 10, 0), '中秋节刚过完');
    assertClause(new Date(2026, 8, 30, 10, 0), '明天就是国庆节');
  });

  test('中秋 after=2：回味窗口到第 2 天为止（2027 验证）', () => {
    assertClause(new Date(2027, 8, 17, 10, 0), '中秋节假期最后一天了');
    assertClause(new Date(2027, 8, 18, 10, 0), '中秋节刚过完');
    assertClause(new Date(2027, 8, 19, 10, 0), '中秋节刚过完');
    assertNoClause(new Date(2027, 8, 20, 10, 0));
  });

  test('春节 15 天（正月初一 → 正月十五）：整段都在年味里', () => {
    assertClause(new Date(2026, 1, 17, 10, 0), '今天是大年初一');
    assertClause(new Date(2026, 1, 20, 10, 0), '还在春节假期里');
  });

  test('节前与当天压过「假期中」：3/2 说明天就是元宵节，3/3 是元宵节当天', () => {
    assertClause(new Date(2026, 2, 2, 10, 0), '明天就是元宵节');
    assertClause(new Date(2026, 2, 3, 10, 0), '今天是元宵节');
  });

  test('元宵排在春节之前：元宵的当天与回味都归元宵', () => {
    assertClause(new Date(2026, 2, 4, 10, 0), '元宵节刚过完');
    assertClause(new Date(2026, 2, 5, 10, 0), '元宵节刚过完');
    assertClause(new Date(2026, 2, 7, 10, 0), '明天就是妇女节');
  });
});

describe('节日 —— 农历（ICU 换算）', () => {
  test('除夕：腊月最后一天（2026 是腊月廿九，不是三十）', () => {
    assertClause(new Date(2026, 1, 16, 12, 0), '今天是除夕');
  });

  test('除夕 ahead=1：2/14 不说除夕，说情人节', () => {
    assertClause(new Date(2026, 1, 14, 12, 0), '今天是情人节');
  });

  test('元宵节', () => {
    assertClause(new Date(2026, 2, 3, 12, 0), '今天是元宵节');
  });

  test('端午节（3 天假）', () => {
    assertClause(new Date(2026, 5, 19, 12, 0), '今天是端午节');
    assertClause(new Date(2026, 5, 21, 12, 0), '端午节假期最后一天了');
  });

  test('中秋节', () => {
    assertClause(new Date(2026, 8, 25, 12, 0), '今天是中秋节');
  });

  test('腊八节（公历 1 月，农历还在上一年，且在寒假里照常说）', () => {
    assertClause(new Date(2026, 0, 26, 12, 0), '今天是腊八节');
  });

  test('七夕（落在暑假里也要说节日，不被假期压掉）', () => {
    assertClause(new Date(2026, 7, 19, 12, 0), '今天是七夕');
  });

  test('闰月不误判：2028 闰五月初五不是端午，真端午在 2028-05-28', () => {
    assertClause(new Date(2028, 4, 28, 12, 0), '今天是端午节');
    assertNoClause(new Date(2028, 5, 27, 12, 0)); // 闰五月初五：月为负，不参与匹配
  });
});

describe('假期区间 —— 寒假 30 天 / 暑假 60 天', () => {
  test('寒假：预热 → 开始 → 假期中', () => {
    assertClause(new Date(2026, 0, 17, 10, 0), '快要放寒假了');
    assertClause(new Date(2026, 0, 19, 10, 0), '明天就放寒假了');
    assertClause(new Date(2026, 0, 20, 10, 0), '寒假开始了');
    assertClause(new Date(2026, 1, 5, 10, 0), '正在放寒假');
  });

  test('寒假末尾（用 2028：2026 的这几天被春节占了）', () => {
    assertClause(new Date(2028, 1, 18, 10, 0), '寒假快结束了');
    assertClause(new Date(2028, 1, 19, 10, 0), '寒假刚结束');
    assertClause(new Date(2028, 1, 21, 10, 0), '寒假这么快就过完了');
    assertNoClause(new Date(2028, 1, 22, 10, 0));
  });

  test('暑假：预热 → 首日 → 假期中', () => {
    // 暑假排在建党节之前：7/1 说「暑假开始了」，不再被建党节压掉
    assertClause(new Date(2026, 5, 28, 10, 0), '快要放暑假了');
    assertClause(new Date(2026, 5, 30, 10, 0), '明天就放暑假了');
    assertClause(new Date(2026, 6, 1, 10, 0), '暑假开始了');
    assertClause(new Date(2026, 6, 15, 10, 0), '正在放暑假');
  });

  test('暑假末尾：中元节优先，随后是暑假的收尾', () => {
    assertClause(new Date(2026, 7, 27, 10, 0), '今天是中元节');
    assertClause(new Date(2026, 7, 28, 10, 0), '中元节刚过完');
    assertClause(new Date(2026, 7, 31, 10, 0), '暑假刚结束');
    assertClause(new Date(2026, 8, 1, 10, 0), '暑假这么快就过完了');
    assertNoClause(new Date(2026, 8, 2, 10, 0));
  });
});

describe('节日 —— 优先级＝数组顺序（靠前的先说话）', () => {
  test('当天压过节前：2026-02-14 是情人节（春节还差 3 天）', () => {
    assertClause(new Date(2026, 1, 14, 12, 0), '今天是情人节');
  });

  test('节前压过节后：2026-02-15 说「明天就是除夕」', () => {
    assertClause(new Date(2026, 1, 15, 12, 0), '明天就是除夕');
  });

  test('除夕排在春节之前：2026-02-16 说除夕，而非「明天就是春节」', () => {
    assertClause(new Date(2026, 1, 16, 12, 0), '今天是除夕');
  });

  test('愚人节排在清明之前：2026-04-01 说愚人节', () => {
    assertClause(new Date(2026, 3, 1, 12, 0), '今天是愚人节');
  });

  test('春节压过寒假：寒假期间仍由春节说话', () => {
    assertClause(new Date(2026, 1, 18, 12, 0), '还在春节假期里');
  });

  test('传统节日压过暑假：8/19 七夕当天说七夕', () => {
    assertClause(new Date(2026, 7, 19, 12, 0), '今天是七夕');
  });

  test('暑假压过纪念日：7/1 既是建党节又是暑假首日，说暑假', () => {
    assertClause(new Date(2026, 6, 1, 12, 0), '暑假开始了');
  });
});
