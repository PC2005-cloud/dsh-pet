/**
 * windows 形态：三窗口用量的百分比口径、气泡文案与最紧迫窗口判定。
 *
 * 与服务商无关——各窗口满额度与滚动窗时长都由数据带出，这里不写死任何服务商的额度。
 *
 * @module dsh-pet/src/shared/balance/handlers/windows
 */

import { balanceFill, balanceText } from '../copy.ts';
import { quotaTone } from '../tone.ts';
import type { BalanceBubbleRow, BalanceView, WindowKey, WindowUsage } from '../types.ts';
import type { ShapeHandler } from './shape.ts';

/**
 * 周与月的窗口展示名，供气泡与联想框文案使用。
 *
 * 滚动窗的时长是服务商自己的业务事实（如 5 小时），不走这张表，见 DEFAULT_ROLLING_LABEL。
 */
export const WINDOW_LABELS = {
  weekly: '周',
  monthly: '月',
} as const;

/**
 * 滚动窗展示名的兜底，服务商应随数据带 rollingLabel，缺省时才用它。
 *
 * 缺一个标签会让气泡出现空档，而 5h 是当前两个滚动窗口服务商的共同取值。
 */
export const DEFAULT_ROLLING_LABEL = '5h';

/** 取窗口展示名：滚动窗用服务商自报值，周与月走固定表 */
function windowLabel(v: BalanceView, w: WindowKey): string {
  if (w === 'rolling') return v.rollingLabel ?? DEFAULT_ROLLING_LABEL;
  if (w === 'weekly') return balanceText('balance.window.weekly');
  return balanceText('balance.window.monthly');
}

/** 各窗口的满额度，全部来自数据 */
function windowQuotas(v: BalanceView): Record<WindowKey, number | undefined> {
  return { rolling: v.rollingCapUsd, weekly: v.weeklyCapUsd, monthly: v.monthlyCapUsd };
}

/**
 * 取最先告急的一个窗口，所有 windows 形态的服务商共用同一套判定。
 *
 * 满额度齐全时按绝对口径比剩余额度（USD）；有窗口给不出满额度时退化为比已用百分比——
 * 两窗额度量级不同，缺一个还硬比绝对剩余会反直觉。不存在的窗口直接跳过，不补 0。
 *
 * 绝对口径的副作用是滚动窗通常先报（额度最小），这一行为刻意保留，两端一致。
 */
export function urgentWindow(v: BalanceView): WindowUsage | undefined {
  // 只有 windows 形态有「窗口」概念：money（账户余额）与 points（积分）都没有可告急的窗口
  if (v.shape !== 'windows') return undefined;
  const quotas = windowQuotas(v);
  const resets: Record<WindowKey, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  const present = (['rolling', 'weekly', 'monthly'] as WindowKey[]).filter((w) => v[w] !== undefined);
  if (present.length === 0) return undefined;
  const allQuotas = present.every((w) => {
    const quota = quotas[w];
    return quota !== undefined && quota > 0;
  });

  let best: WindowUsage | undefined;
  for (const w of present) {
    const percent = v[w] ?? 0;
    const quota = quotas[w];
    const cand: WindowUsage = {
      label: windowLabel(v, w),
      percent,
      quotaUsd: quota,
      remainingUsd: allQuotas && quota !== undefined ? (quota * (100 - percent)) / 100 : undefined,
      resetsAt: resets[w],
    };
    if (best === undefined) {
      best = cand;
      continue;
    }
    const moreUrgent = allQuotas ? (cand.remainingUsd ?? 0) < (best.remainingUsd ?? 0) : cand.percent > best.percent;
    if (moreUrgent) best = cand;
  }
  return best;
}

/**
 * 把重置时间转成一句相对文案，保留一位小数。
 *
 * 四天及以上报「N.x 天」，不足四天报「N.x 小时」；已过重置点报「已重置」，时间未知返回空串。
 */
export function resetInText(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = t - Date.now();
  if (delta <= 0) return balanceText('balance.reset.done');
  const hoursF = delta / 3_600_000;
  if (hoursF >= 96) {
    const value = (Math.round((hoursF / 24) * 10) / 10).toFixed(1);
    return balanceFill('balance.time.days', { value });
  }
  const value = Math.max(0.1, Math.round(hoursF * 10) / 10).toFixed(1);
  return balanceFill('balance.time.hours', { value });
}

/** 三窗口取最大值，只有月窗口时就是它本身 */
function windowsPercent(v: BalanceView): number | undefined {
  return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
}

/** 把 resetInText 的三种返回翻成一句提示：空串 = 时间未知，'已重置' = 已经过点，其余 = 倒计时。 */
function resetPhrase(reset: string): string {
  if (reset === '') return balanceText('balance.reset.unknown');
  const done = balanceText('balance.reset.done');
  if (reset === done) return done;
  return balanceFill('balance.reset.countdown', { time: reset });
}

/** 两行：最紧迫窗口的已用百分比与重置倒计时 */
function windowsRows(v: BalanceView): BalanceBubbleRow[] {
  const w = urgentWindow(v);
  if (!w) return [{ role: 'label', text: balanceText('balance.quota.unavailable') }];
  const reset = resetInText(w.resetsAt);
  return [
    {
      role: 'label',
      text: balanceFill('balance.window.used', { label: w.label, percent: Math.round(w.percent) }),
    },
    { role: 'sub', text: resetPhrase(reset) },
  ];
}

/**
 * 展开态每个存在的窗口一行：窗口名、进度条、已用百分比与重置倒计时。
 *
 * 只列存在的窗口，rolling 与 weekly 缺省表示该服务商没有这个窗口，不补 0、不画空条。
 */
function windowsDetail(v: BalanceView): BalanceBubbleRow[] {
  const resets: Record<WindowKey, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  const rows: BalanceBubbleRow[] = [];
  for (const w of ['rolling', 'weekly', 'monthly'] as WindowKey[]) {
    const percent = v[w];
    if (percent === undefined) continue;
    // 与收起态同一套重置文案，两端原样渲染。
    const reset = resetInText(resets[w]);
    const usedText = Math.round(percent) + '%';
    const resetText = resetPhrase(reset);
    rows.push({
      role: 'quota',
      text: windowLabel(v, w) + ' ' + usedText + ' ' + resetText,
      label: windowLabel(v, w),
      percent,
      tone: quotaTone(percent),
      usedText,
      resetText,
    });
  }
  return rows.length > 0 ? rows : windowsRows(v);
}

/** 紧凑计数：1.2B / 96.0M / 478.3K，千以下取整。固定一位小数——同一页三个数字宽度稳定，不随取值跳动。 */
function compactCount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

/**
 * 第三页：本期累计用量。一行 `usage` 承载整张卡，两端摆成三行两列——
 * 「Token / 总量」「输入 / 输出」「本期请求数 / 花费」，总量是唯一的大字。
 *
 * 服务商没给这项数据时返回 undefined，由页数判定决定气泡只有两页；给的一半数字不会被拼进来。
 */
function windowsUsage(v: BalanceView): BalanceBubbleRow[] | undefined {
  const u = v.usage;
  if (!u) return undefined;
  const total = compactCount(u.totalTokens);
  const input = balanceFill('balance.usage.input', { value: compactCount(u.inputTokens) });
  const output = balanceFill('balance.usage.output', { value: compactCount(u.outputTokens) });
  const period = balanceFill('balance.usage.period', { count: u.requests });
  const spend = '$' + u.spentUsd.toFixed(2);
  const title = balanceText('balance.usage.title');
  // 比例条用真实占比：输入通常占绝对多数，条看起来几乎单色是事实，不做最小宽度放大。
  const sum = u.inputTokens + u.outputTokens;
  const inputPercent = sum > 0 ? (u.inputTokens / sum) * 100 : undefined;
  return [
    {
      role: 'usage',
      text: balanceFill('balance.usage.summary', { title, total, input, output, period, spend }),
      title,
      total,
      input,
      output,
      period,
      spend,
      inputPercent,
    },
  ];
}

/** windows 形态的展示规则：百分比取三窗口最大，展开态逐窗口一行，有用量时多一页。 */
export const windowsHandler: ShapeHandler = {
  percent: windowsPercent,
  rows: windowsRows,
  detail: windowsDetail,
  usage: windowsUsage,
};
