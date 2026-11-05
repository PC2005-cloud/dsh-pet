/**
 * money 形态：账户金额的已用百分比与气泡文案。
 *
 * 不同币种不能相加金额，但比例是无量纲的，所以不需要汇率——各币种按自己的基准算剩余比例后叠加。
 *
 * @module dsh-pet/src/shared/balance/handlers/money
 */

import { getHostLocale } from '../../../locale/current.ts';
import { balanceText } from '../copy.ts';
import type { BalanceBubbleRow, BalanceView } from '../types.ts';
import type { ShapeHandler } from './shape.ts';

/**
 * 各币种按自己的基准算剩余比例，相加后折算成已用百分比。
 *
 * 没有基准的币种跳过，不替它猜一个；一个带基准的币种都没有则返回 undefined，不播档位动画。
 */
function moneyPercent(v: BalanceView): number | undefined {
  let remaining = 0;
  let based = 0;
  for (const w of v.wallets ?? []) {
    const total = Number(w.total);
    const full = Number(w.fullBalance);
    if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) continue;
    remaining += total / full; // 负数（透支）会拉低剩余量，最终被夹到「已用完」
    based++;
  }
  if (based === 0) return undefined;
  return Math.max(0, Math.min(100, 100 - remaining * 100));
}

/**
 * 一行「余额（峰/谷）¥x.xx」。
 *
 * 只显示 total 非 0 的币种：负数要显示（透支是真的欠钱），正好 0 的不占地方；CNY 优先，
 * 用符号拼接、以「/」分隔；全为 0 时兜底 ¥0.00，否则气泡会空一行。档位装饰只有提供该计价
 * 规则的服务商才有，没有就不加括号那一段。
 */
function moneyRows(v: BalanceView): BalanceBubbleRow[] {
  const visible = (v.wallets ?? [])
    .filter((w) => Number(w.total) !== 0)
    .sort((a, b) => (a.currency === 'CNY' ? 0 : 1) - (b.currency === 'CNY' ? 0 : 1));
  const amount =
    visible.length > 0 ? visible.map((w) => (w.currency === 'USD' ? '$' : '¥') + w.total).join('/') : '¥0.00';
  const close = getHostLocale() === 'ru' ? ')' : '）';
  if (!v.tier) return [{ role: 'label', text: balanceText('balance.label') + amount }];
  return [
    { role: 'label', text: balanceText('balance.money.open') },
    {
      role: 'tier',
      tier: v.tier,
      text: v.tier === 'peak' ? balanceText('balance.tier.peak') : balanceText('balance.tier.valley'),
    },
    { role: 'label', text: close + amount },
  ];
}

/** money 形态的展示规则：百分比按币种基准折算，收成一行业务气泡。 */
export const moneyHandler: ShapeHandler = {
  percent: moneyPercent,
  rows: moneyRows,
};
