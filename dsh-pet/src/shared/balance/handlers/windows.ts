// windows 形态（三窗口用量）：百分比口径、窗口文案、最紧迫窗口判定。
//
// 与服务商无关：各窗口满额度、滚动窗时长（rollingLabel）都由数据带出，这里不写死任何服务商的额度。

import { quotaTone } from '../tone';
import type { BalanceBubbleRow, BalanceView, WindowKey, WindowUsage } from '../types';
import type { ShapeHandler } from './shape';

/**
 * 窗口展示名（联想框文案用）：周、月。
 * 滚动窗的时长是**服务商自己的业务事实**（如 5 小时），不走这张表，见 DEFAULT_ROLLING_LABEL。
 */
export const WINDOW_LABELS = {
  weekly: '周',
  monthly: '月',
} as const;

/**
 * 滚动窗展示名的兜底：服务商应随数据带 `rollingLabel`，缺省时才用它。
 * 之所以要有兜底：缺一个标签会让气泡出现空档，而 5h 是当前两个滚动窗口服务商的共同取值。
 */
export const DEFAULT_ROLLING_LABEL = '5h';

/** 窗口展示名：滚动窗取服务商自报值（缺省 5h），周/月走固定表 */
function windowLabel(v: BalanceView, w: WindowKey): string {
  if (w === 'rolling') return v.rollingLabel ?? DEFAULT_ROLLING_LABEL;
  return WINDOW_LABELS[w];
}

/** 各窗口的满额度（USD）：全部来自数据（展示层不写死任何服务商的额度） */
function windowQuotas(v: BalanceView): Record<WindowKey, number | undefined> {
  return { rolling: v.rollingCapUsd, weekly: v.weeklyCapUsd, monthly: v.monthlyCapUsd };
}

/**
 * 取最先告急的一个窗口（所有 windows 形态的服务商共用同一套，无服务商判断）：
 * - 满额度齐全 → 绝对口径：剩余额度（USD）最少者；
 * - 有窗口给不出满额度 → 退化为相对口径：已用百分比最大者
 *   （两窗额度量级不同，缺一个还硬比绝对剩余会反直觉）。
 * 不存在的窗口直接跳过，不补 0。
 *
 * 绝对口径的副作用（刻意保留）：滚动窗额度最小，通常先报它；两端一致，完整读数见 tools/api-tester.html。
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
 * 重置时间 → 相对文案（保留 1 位小数）：
 * - 距重置 ≥ 4 天 → 「N.x 天」
 * - 距重置 < 4 天 → 「N.x 小时」
 * - 已过重置点 → 「已重置」；未知时间 → 空串
 */
export function resetInText(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = t - Date.now();
  if (delta <= 0) return '已重置';
  const hoursF = delta / 3_600_000;
  if (hoursF >= 96) return (Math.round((hoursF / 24) * 10) / 10).toFixed(1) + ' 天';
  return Math.max(0.1, Math.round(hoursF * 10) / 10).toFixed(1) + ' 小时';
}

/** windows：三窗口取最大（只有月窗口时就是它自己） */
function windowsPercent(v: BalanceView): number | undefined {
  return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
}

/** windows：收起态 —— 标题（如有）+ 最紧迫窗口的「已用/剩余 N%」+ 重置倒计时 */
function windowsRows(v: BalanceView): BalanceBubbleRow[] {
  const w = urgentWindow(v);
  if (!w) return [{ role: 'label', text: '额度数据不可用' }];
  const reset = resetInText(w.resetsAt);

  if (v.provider === 'google-antigravity') {
    const remainingPct = Math.max(0, Math.min(100, Math.round(100 - w.percent)));
    return [
      { role: 'sub', text: 'google-antigravity' },
      { role: 'label', text: w.label + '额度剩余 ' + remainingPct + '%' },
      { role: 'sub', text: reset ? reset + '重置' : '已重置' },
    ];
  }

  return [
    { role: 'label', text: w.label + '额度已用 ' + Math.round(w.percent) + '%' },
    { role: 'sub', text: reset ? reset + '重置' : '已重置' },
  ];
}

/**
 * windows：展开态每个存在窗口一行 —— 窗口名 + 进度条 + 已用/剩余百分比 + 重置倒计时。
 * 只列**存在**的窗口：`rolling` / `weekly` 缺省 = 该服务商没有这个窗口，不补 0、不画空条。
 */
function windowsDetail(v: BalanceView): BalanceBubbleRow[] {
  const resets: Record<WindowKey, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  const rows: BalanceBubbleRow[] = [];
  if (v.provider === 'google-antigravity') {
    rows.push({ role: 'sub', text: 'google-antigravity' });
  }
  for (const w of ['rolling', 'weekly', 'monthly'] as WindowKey[]) {
    const percent = v[w];
    if (percent === undefined) continue;
    // 与收起态同一套重置文案（"已重置" / "N.x 小时重置"），两端直接原样渲染
    const reset = resetInText(resets[w]);
    const resetText = reset === '' ? '已重置' : reset + '重置';

    if (v.provider === 'google-antigravity') {
      const remainingPct = Math.max(0, Math.min(100, Math.round(100 - percent)));
      // 剩余口径配色：剩余 <= 10% 告警红色，<= 30% 预警黄色，其余正常绿色
      const tone = remainingPct <= 10 ? 'crit' : remainingPct <= 30 ? 'warn' : 'ok';
      const usedText = '剩余 ' + remainingPct + '%';
      rows.push({
        role: 'quota',
        text: windowLabel(v, w) + ' ' + usedText + ' ' + resetText,
        label: windowLabel(v, w),
        percent: remainingPct,
        tone,
        usedText,
        resetText,
      });
    } else {
      const usedText = Math.round(percent) + '%';
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
  }
  return rows.length > 0 ? rows : windowsRows(v);
}

export const windowsHandler: ShapeHandler = {
  percent: windowsPercent,
  rows: windowsRows,
  detail: windowsDetail,
};
