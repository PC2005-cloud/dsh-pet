/**
 * Command Code（provider id `commandcode`）—— 三窗口用量，走**控制面** `/alpha/*`。
 *
 * 用量在官方 CLI 使用的未文档化控制面上，与推理数据面的 `/provider`、`/provider/v1` 不是同一条
 * 路径：先 whoami 取 orgId，再依次取额度 / 订阅 / 当期消耗（**串行 4 次调用**）。
 *
 * 数据来源与口径（与官方 CLI 的 `/alpha` 路由一致）：
 * - `credits`：`monthlyCredits` + `purchasedCredits` + `freeCredits` = 剩余额度；
 * - `windowLimits`：`limited` 为真才有 5h（`fiveHour`）/ 周窗口，各 `{used, cap, resetAt}`；
 * - `usage/summary` 的 `totalCost` = 当期已消耗 → 月度百分比 = 消耗 /（消耗 + 剩余）；
 * - 订阅接口（可选）只提供月度重置时间（`currentPeriodEnd`）。
 *
 * 展示形态与 opencode 相同（`shape: 'windows'`），展示层因而共用同一套「取最紧迫窗口」逻辑。
 */
import { fetchWithRetry, looseNum, num, obj, queryString, readWindow } from '../internal';
import type { BalanceProvider, BalanceSuccess, WindowsUsage } from '../types';

/** 控制面基址（`/alpha/*` 固定在根域名） */
const API_BASE = 'https://api.commandcode.ai';

/** 滚动窗时长（展示名）：本服务商的 5h 窗口就是 `windowLimits.fiveHour` */
const ROLLING_LABEL = '5h';

/** 抓一次 JSON（GET + Bearer），HTTP 非 2xx 抛错；`label` 是接口路径，只进错误信息（便于自查哪一个失败） */
async function fetchJson(url: string, key: string, label: string): Promise<unknown> {
  const res = await fetchWithRetry(url, key);
  if (!res.ok) throw new Error('commandcode ' + label + ' HTTP ' + res.status);
  return (await res.json()) as unknown;
}

/**
 * 解析三个接口的响应 → 成功结果（纯函数：网络与凭证都在外面，测试直接喂真实报文）。
 *
 * 失败口径：**必填字段缺失/非法一律抛错**（调用方落成 `fetch-error`，绝不伪造 0 余额）；
 * 可选信息（不限额窗口、`cap` 为 0、占位重置时间、订阅缺失）一律省略。
 */
export function parseCommandCode(
  creditsBody: unknown,
  subscriptionBody: unknown,
  summaryBody: unknown,
  provider: string,
): BalanceSuccess {
  const root = obj(creditsBody);
  const credits = obj(root?.credits);
  if (!credits) throw new Error('dsh-pet: commandcode 响应缺少 credits');

  // 三个额度字段全缺 = 认不出响应形态：宁可报错，也不把分母当 0 算出「已用 100%」
  const creditFields = [credits.monthlyCredits, credits.purchasedCredits, credits.freeCredits];
  if (creditFields.every((v) => looseNum(v) === undefined)) {
    throw new Error('dsh-pet: commandcode credits 响应缺少额度字段');
  }
  const remaining = creditFields.reduce<number>((sum, v) => sum + Math.max(0, looseNum(v) ?? 0), 0);

  const summary = obj(summaryBody);
  const spentRaw = summary?.totalCost;
  if (spentRaw === undefined || spentRaw === null) throw new Error('dsh-pet: commandcode usage 响应缺少 totalCost');
  const spent = Math.max(0, num(spentRaw, 'totalCost'));

  const pool = spent + remaining;
  const data: WindowsUsage = { monthly: pool > 0 ? (spent / pool) * 100 : 0 };
  if (pool > 0) data.monthlyCapUsd = pool;

  const subscription = obj(obj(subscriptionBody)?.data);
  const periodEnd = subscription?.currentPeriodEnd;
  if (typeof periodEnd === 'string' && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;

  // 实际报文把 windowLimits 放在 credits 同级；同时兼容嵌在 credits 内的变体
  const limits = obj(root?.windowLimits) ?? obj(credits.windowLimits);
  if (limits?.limited === true) {
    const fiveHour = readWindow(limits.fiveHour);
    if (fiveHour) {
      data.rolling = fiveHour.percent;
      data.rollingCapUsd = fiveHour.capUsd;
      data.rollingLabel = ROLLING_LABEL;
      if (fiveHour.resetsAt) data.rollingResetsAt = fiveHour.resetsAt;
    }
    const weekly = readWindow(limits.weekly);
    if (weekly) {
      data.weekly = weekly.percent;
      data.weeklyCapUsd = weekly.capUsd;
      if (weekly.resetsAt) data.weeklyResetsAt = weekly.resetsAt;
    }
  }

  return { ok: true, provider, shape: 'windows', data };
}

export const commandCode: BalanceProvider = {
  ids: ['commandcode'],
  credential: { mode: 'ref', ref: 'COMMANDCODE_API_KEY' },
  async fetch({ key, provider }) {
    const whoami = obj(
      await fetchJson(API_BASE + '/alpha/whoami' + queryString({ limits: '1' }), key, '/alpha/whoami'),
    );
    const org = obj(whoami?.org);
    const orgId = typeof org?.id === 'string' && org.id.length > 0 ? org.id : undefined;

    const credits = await fetchJson(
      API_BASE + '/alpha/billing/credits' + queryString({ orgId }),
      key,
      '/alpha/billing/credits',
    );

    // 订阅是**可选**的：按量付费账号可能没有订阅（该接口非 2xx），此时只是月度窗口缺重置倒计时，
    // 三个窗口的百分比一个都不少 → 不因此整体失败（也不编造一个重置时间）
    let subscription: unknown;
    try {
      subscription = await fetchJson(
        API_BASE + '/alpha/billing/subscriptions' + queryString({ orgId }),
        key,
        '/alpha/billing/subscriptions',
      );
    } catch {
      subscription = undefined;
    }

    // since 只在拿得到当期起始时间时带：该接口的默认区间由服务端决定，插件不猜
    const periodStart = obj(obj(subscription)?.data)?.currentPeriodStart;
    const summary = await fetchJson(
      API_BASE +
        '/alpha/usage/summary' +
        queryString({ since: typeof periodStart === 'string' ? periodStart : undefined, orgId }),
      key,
      '/alpha/usage/summary',
    );

    return parseCommandCode(credits, subscription, summary, provider);
  },
};
