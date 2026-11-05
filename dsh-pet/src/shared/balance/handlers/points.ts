/**
 * points 形态：积分或点数余额（非货币）的已用百分比与气泡文案。
 *
 * 与 money 的区别只在语义：单位是数据带出的后缀，绝不套货币符号；数学是同一套，单位在比值里
 * 被约掉，同样没有汇率问题。
 *
 * @module dsh-pet/src/shared/balance/handlers/points
 */

import { balanceText } from '../copy.ts';
import type { BalanceBubbleRow, BalanceView } from '../types.ts';
import type { ShapeHandler } from './shape.ts';

/**
 * 与 money 同一套「按基准折算」的数学，数据来自 points 而非 wallets。
 *
 * 没有基准或基准非法则返回 undefined，不播档位动画，也不替服务商猜一个。
 */
function pointsPercent(v: BalanceView): number | undefined {
  const total = Number(v.points?.total);
  const full = Number(v.points?.full);
  if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) return undefined;
  return Math.max(0, Math.min(100, 100 - (total / full) * 100));
}

/**
 * 一行「余额 800 积分」。
 *
 * 单位是数据带出的后缀，绝不套货币符号——$/¥ 那套判断只属于 money；0 也照常显示，0 积分是真实读数。
 */
function pointsRows(v: BalanceView): BalanceBubbleRow[] {
  const p = v.points;
  if (!p) return [{ role: 'label', text: balanceText('balance.points.unavailable') }];
  return [{ role: 'label', text: balanceText('balance.label') + p.total + ' ' + p.unit }];
}

/** points 形态的展示规则：百分比按积分基准折算，气泡只拼数字与单位。 */
export const pointsHandler: ShapeHandler = {
  percent: pointsPercent,
  rows: pointsRows,
};
