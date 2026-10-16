/**
 * DSH 账号路由（provider id `deepseek-account`）—— 免费额度 / 平台登录，账户金额。
 *
 * 这条路由**没有 API Key**（`credential.mode === 'none'`）：凭证是 DSH 账号服务持有的授权记录，
 * 因此不发任何 HTTP，只经调用方注入的 `resolveAccount`（= `ctx.deepseekAccount.getBalance`）取快照。
 *
 * 展示口径与 `deepseek-official` **完全一致**（同一个 shape）：气泡都是「余额（峰/谷）¥x.xx」，
 * 金额语义也对齐官方定义 —— `total` = 赠送 + 充值（`granted` + `toppedUp`）。差异只在取数。
 * 档位基准与峰谷档位取自 ./deepseek-common.ts（两条 deepseek 路由同一套口径）。
 */
import { DEEPSEEK_FULL_BALANCE, deepseekPricingTier } from '../deepseek-common';
import { money, obj, sumMoney } from '../internal';
import type { AccountBalanceSnapshot, BalanceProvider, BalanceSuccess } from '../types';

/**
 * 账号余额快照 → 成功结果（纯函数，便于测试直接喂真实结构）。
 *
 * 失败口径：没有可用的充值钱包（未登录 / 查询失败 / 空数组）→ 抛错，由调用方落成 `fetch-error`；
 * 金额非法同理 —— **绝不伪造 0 余额**。
 *
 * 币种：钱包自带 `CNY`/`USD`，这里一并带出去，展示层据此选符号（CNY → ¥）。
 */
export function parseAccountBalance(
  snapshot: AccountBalanceSnapshot | null | undefined,
  provider: string,
): BalanceSuccess {
  if (!snapshot) throw new Error('dsh-pet: 账号未登录（deepseek-account）');
  if (snapshot.status !== 'ready') throw new Error('dsh-pet: 账号余额查询失败');
  const wallets = Array.isArray(snapshot.value) ? snapshot.value : [];
  // 充值钱包为空 = 这个账号没有可展示的余额（常见于只送不充的新号）→ 报错而非显示 ¥0.00
  if (wallets.length === 0) throw new Error('dsh-pet: 账号没有充值钱包余额');
  const first = obj(wallets[0] as unknown);
  if (!first) throw new Error('dsh-pet: 账号钱包结构非法');
  const currency = typeof first.currency === 'string' && first.currency.length > 0 ? first.currency : 'CNY';
  const toppedUp = money(first.balance, 'balance');
  // 赠送钱包：与充值同币种的那个（币种不同不硬配，见下）
  const bonus = (Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : [])
    .map((w) => obj(w as unknown))
    .find((w) => w !== undefined && w.currency === currency);
  const granted = bonus ? money(bonus.balance, 'bonus balance') : '0.00';
  return {
    ok: true,
    provider,
    shape: 'money',
    data: {
      currency,
      // 与官方路由**同构**：官方文档定义 total_balance = "The total available balance,
      // including the granted balance and the topped-up balance" —— 即 赠送 + 充值。
      // 只取充值会漏掉赠送额，让可用余额偏小。
      total: sumMoney(granted, toppedUp),
      // deepseek-official 的 granted/toppedUp 语义在账号侧对应「赠送 / 充值」两个钱包
      granted,
      toppedUp,
      fullBalance: DEEPSEEK_FULL_BALANCE,
      tier: deepseekPricingTier(),
    },
  };
}

export const deepseekAccount: BalanceProvider = {
  ids: ['deepseek-account'],
  credential: { mode: 'none' },
  async fetch({ provider, resolveAccount }) {
    // queryBalance 对 mode === 'none' 已保证 resolveAccount 在场（否则落 credential-missing）；
    // 这里是"不变量守卫"，只会在接线被改坏时触发。
    if (!resolveAccount) throw new Error('dsh-pet: 缺少账号服务（' + provider + '）');
    return parseAccountBalance(await resolveAccount(), provider);
  },
};
