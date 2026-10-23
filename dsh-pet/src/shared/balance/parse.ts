// 解析：host 写进 /state 叶子的原始响应 → 客户端视图。
//
// 这一层是**白名单透传**：字段一个一个挑，没写进来的字段会被静默丢弃（新增字段必须在这里加）。
// 形状不认识 / 非法 → 返回 null，让调用方跳过这一拍；这里绝不抛异常（跑在 1s 轮询里，
// 抛一次会把整拍打断，其余叶子也跟着不渲染）。

import type { BalanceState, MoneyWalletView, RawBalanceResult } from './types';

/**
 * 可选数字：缺省 → undefined；出现但非法 → null（调用方据此整拍跳过——不把 NaN/字符串送进展示层）。
 */
function optNum(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * host 的余额原始响应（`BalanceResult`，经 `/state` 的 `sections.balance` 叶子送达）→ 客户端视图。
 *
 * 形状非法 / shape 不认识 → **null**（消费端跳过这一拍）——注意这里**不抛**：它跑在 1s 轮询里，
 * 抛异常会把整拍打断（其余叶子也跟着不渲染）。取数失败（HTTP/网络）不在这里发生：取数在 host，
 * 失败会以 `ok:false` 写进 S，由这里正常映射成"不可用"状态。
 */
export function toBalanceState(raw: unknown): BalanceState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawBalanceResult;
  const provider = String(r.provider ?? 'unknown');
  if (r.ok !== true) {
    const reason =
      r.reason === 'unsupported' || r.reason === 'credential-missing' || r.reason === 'fetch-error'
        ? r.reason
        : 'fetch-error';
    return { provider, ok: false, reason, message: typeof r.message === 'string' ? r.message : undefined };
  }

  const d = r.data;
  if (!d || typeof d !== 'object') return null;

  if (r.shape === 'windows') {
    const monthly = optNum(d.monthly);
    const rolling = optNum(d.rolling);
    const weekly = optNum(d.weekly);
    const rollingCapUsd = optNum(d.rollingCapUsd);
    const weeklyCapUsd = optNum(d.weeklyCapUsd);
    const monthlyCapUsd = optNum(d.monthlyCapUsd);
    // 至少需要有一个有效窗口（如 rolling、weekly 或 monthly）
    if (monthly === undefined && rolling === undefined && weekly === undefined) return null;
    // 出现但非法（optNum 返回 null）→ 整拍跳过，不把坏数字送进展示层
    if (
      monthly === null ||
      rolling === null ||
      weekly === null ||
      rollingCapUsd === null ||
      weeklyCapUsd === null ||
      monthlyCapUsd === null
    ) {
      return null;
    }
    return {
      provider,
      shape: 'windows',
      ok: true,
      rolling,
      weekly,
      monthly,
      rollingCapUsd,
      weeklyCapUsd,
      monthlyCapUsd,
      rollingLabel: typeof d.rollingLabel === 'string' && d.rollingLabel.length > 0 ? d.rollingLabel : undefined,
      rollingResetsAt: typeof d.rollingResetsAt === 'string' ? d.rollingResetsAt : undefined,
      weeklyResetsAt: typeof d.weeklyResetsAt === 'string' ? d.weeklyResetsAt : undefined,
      monthlyResetsAt: typeof d.monthlyResetsAt === 'string' ? d.monthlyResetsAt : undefined,
    };
  }
  if (r.shape === 'money') {
    // 多币种：每项必须有 currency + total；granted / toppedUp 缺省记 '0.00'（只用于展示分项，
    // 不参与档位），fullBalance 缺省 = 该币种没有基准。结构不合法的项直接丢弃——少一条币种比整拍不渲染好。
    const raw = Array.isArray(d.wallets) ? d.wallets : [];
    const wallets: MoneyWalletView[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const w = item as Record<string, unknown>;
      if (typeof w.currency !== 'string' || w.currency.length === 0) continue;
      if (typeof w.total !== 'string' || w.total.length === 0) continue;
      wallets.push({
        currency: w.currency,
        total: w.total,
        granted: typeof w.granted === 'string' && w.granted.length > 0 ? w.granted : '0.00',
        toppedUp: typeof w.toppedUp === 'string' && w.toppedUp.length > 0 ? w.toppedUp : '0.00',
        fullBalance: typeof w.fullBalance === 'string' && w.fullBalance.length > 0 ? w.fullBalance : undefined,
      });
    }
    // 一个钱包都没有 = 认不出响应（host 侧空钱包是按 fetch-error 写的，走到这里说明结构坏了）
    if (wallets.length === 0) return null;
    return {
      provider,
      shape: 'money',
      ok: true,
      wallets,
      tier: d.tier === 'peak' || d.tier === 'idle' ? d.tier : undefined,
    };
  }
  if (r.shape === 'points') {
    // points：unit + total 缺一不可 —— 没有单位拼不出「800 积分」，没有数字更无从展示。
    // full 缺省 = 没有基准（不参与档位折算）；空串按缺省处理，与 money 的 fullBalance 同口径。
    if (typeof d.unit !== 'string' || d.unit.length === 0) return null;
    if (typeof d.total !== 'string' || d.total.length === 0) return null;
    return {
      provider,
      shape: 'points',
      ok: true,
      points: {
        unit: d.unit,
        total: d.total,
        full: typeof d.full === 'string' && d.full.length > 0 ? d.full : undefined,
      },
    };
  }
  return null;
}
