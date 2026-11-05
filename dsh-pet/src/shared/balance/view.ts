/**
 * 气泡行数据的主出口：把余额状态转成气泡行，浏览器与桌面共用同一份内容与文案。
 *
 * 纯函数，不碰 DOM 与 React；形态相关的文案也不在这里，本模块只负责不可用状态的说明行，
 * 其余按形态查分发表。必须始终成立：不可用时绝不伪造数字。
 *
 * @module dsh-pet/src/shared/balance/view
 */

import { balanceFill, balanceText } from './copy.ts';
import { HANDLERS } from './handlers/index.ts';
import type { BalanceBubbleRow, BalanceState, BalanceUnavailable, CustomNode } from './types.ts';

/**
 * 不可用状态的气泡行：显式给出原因，绝不伪造数字。
 *
 * 次要行为空的会被剔除——空 div 在气泡里会白占一行高度。
 */
function unavailableRows(state: BalanceUnavailable): BalanceBubbleRow[] {
  const rows: BalanceBubbleRow[] =
    state.reason === 'unsupported'
      ? [
          { role: 'error', text: balanceText('balance.error.unsupported') },
          { role: 'sub', text: balanceFill('balance.error.provider', { provider: state.provider }) },
        ]
      : state.reason === 'credential-missing'
        ? [
            // host 的 message 已自带「缺少凭证 X」前缀，这里原样展示，不再加前缀。
            { role: 'error', text: balanceText('balance.error.credential') },
            { role: 'sub', text: state.message ?? '' },
          ]
        : [
            { role: 'error', text: balanceText('balance.error.fetch') },
            { role: 'sub', text: state.message ?? '' },
          ];
  return rows.filter((r) => r.role !== 'quota' && r.text !== '');
}

/**
 * 把余额状态渲染成气泡行数据。
 *
 * 形态文案由各 handler 提供；custom 形态返回空数组——它走节点树这条并行通道（见下方 customViews），
 * 空数组只在误用行数据时兜底成空气泡。不可用时显式展示原因，绝不伪造数字。
 */
export function balanceBubbleView(state: BalanceState): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  return HANDLERS[state.shape].rows(state);
}

/**
 * 展开态的气泡行，点开余额气泡后显示。
 *
 * 只有 windows 有三窗口读数可展开，每个存在的窗口一行；money 与 points 没有窗口概念，
 * 回落到收起态视图，避免点了一下却什么都没变的空交互。
 */
export function balanceDetailView(state: BalanceState): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  const handler = HANDLERS[state.shape];
  return handler.detail ? handler.detail(state) : handler.rows(state);
}

/**
 * 余额气泡的可翻页数：不可用只有一页说明；windows 至少两页（收起态 + 窗口明细），
 * 服务商给了区间用量就多一页；custom 以节点树页数为准，其余形态点开没有新内容。
 *
 * 页数与 {@link balancePageView} 必须同源：两边各判一次就会翻出一页空白。
 */
export function balancePageCount(state: BalanceState): number {
  if (!state.ok) return 1;
  if (state.shape === 'custom') return Math.max(1, customViews(state)?.length ?? 1);
  if (state.shape !== 'windows') return 1;
  return state.usage ? 3 : 2;
}

/**
 * 指定页的气泡行数据：windows 下 0 为收起态、1 为窗口明细、2 为区间用量。
 *
 * 越界页回落到最后一页有内容的页，不返回空数组——空白气泡比停在前一页更像坏了。
 */
export function balancePageView(state: BalanceState, page: number): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  const handler = HANDLERS[state.shape];
  if (state.shape !== 'windows' || page <= 0) return handler.rows(state);
  if (page === 1 || !state.usage) return balanceDetailView(state);
  return handler.usage?.(state) ?? balanceDetailView(state);
}

// 自定义气泡（custom 形态）走节点树这条并行通道：行数据由插件定好长什么样，只填文案；
// 节点树把布局本身交给第三方。两种通道按 shape 互斥，两端渲染入口各判一次即可，其余展示逻辑共用。

/**
 * 多页节点树：只对 custom 形态有值，其余形态返回 undefined，调用方据此回落行数据。
 * 第一项是初始页；多于一项时气泡可点，点一下切下一页，末页回第一页。
 */
export function customViews(state: BalanceState): CustomNode[] | undefined {
  if (!state.ok || state.shape !== 'custom') return undefined;
  const views = HANDLERS[state.shape].views?.(state);
  return views && views.length > 0 ? views : undefined;
}

/**
 * custom 气泡是否可点切页，两端据此决定气泡可不可点。
 *
 * 只有一页时点开也没有别的内容，保持不可点，气泡继续不挡页面。
 */
export function customClickable(state: BalanceState): boolean {
  return (customViews(state)?.length ?? 0) > 1;
}
