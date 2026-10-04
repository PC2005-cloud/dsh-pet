/**
 * OpenCode Go（provider id `opencode-go`）—— 三窗口用量。
 *
 * 接口：`GET https://opencode.ai/zen/go/v1/usage`（Bearer），响应 `{ usage: { rolling, weekly, monthly } }`。
 * 该接口保证三个窗口都在，故三窗与三个重置时间全是必填（缺一个就说明响应形态变了 → 报错，不静默）。
 *
 * 满额度是**本服务商的业务常量**（接口不回报），跟着数据带出去；滚动窗是 5 小时。
 *
 * 注意 `opencode-go` 与 `opencode` 是两个 id：Zen 按量版（`opencode`）没有用量接口，不登记。
 */
import { fetchWithRetry, num, str } from '../internal';
import type { BalanceProvider } from '../types';

/** 各窗口满额度金额（USD）。业务常量：12 = 5h（5 小时滚动窗口）、30 = 周、60 = 月 */
const QUOTA_USD = {
  rolling: 12,
  weekly: 30,
  monthly: 60,
} as const;

/** 滚动窗时长（展示名）：本服务商是 5 小时 */
const ROLLING_LABEL = '5h';

export const opencodeGo: BalanceProvider = {
  ids: ['opencode-go'],
  credential: { mode: 'ref', ref: 'OPENCODE_GO_API_KEY' },
  async fetch({ key, provider }) {
    const res = await fetchWithRetry('https://opencode.ai/zen/go/v1/usage', key);
    if (!res.ok) throw new Error('opencode usage HTTP ' + res.status);
    const body: unknown = await res.json();
    const usage = (body as { usage?: unknown })?.usage;
    if (!usage || typeof usage !== 'object') throw new Error('dsh-pet: opencode usage 响应缺少 usage');
    const u = usage as Record<string, { percent?: unknown; resetsAt?: unknown }>;
    const rolling = u.rolling,
      weekly = u.weekly,
      monthly = u.monthly;
    if (!rolling || !weekly || !monthly) throw new Error('dsh-pet: opencode usage 响应缺少窗口');
    return {
      ok: true,
      provider,
      shape: 'windows',
      data: {
        rolling: num(rolling.percent, 'rolling.percent'),
        weekly: num(weekly.percent, 'weekly.percent'),
        monthly: num(monthly.percent, 'monthly.percent'),
        rollingCapUsd: QUOTA_USD.rolling,
        weeklyCapUsd: QUOTA_USD.weekly,
        monthlyCapUsd: QUOTA_USD.monthly,
        rollingLabel: ROLLING_LABEL,
        rollingResetsAt: str(rolling.resetsAt, 'rolling.resetsAt'),
        weeklyResetsAt: str(weekly.resetsAt, 'weekly.resetsAt'),
        monthlyResetsAt: str(monthly.resetsAt, 'monthly.resetsAt'),
      },
    };
  },
};
