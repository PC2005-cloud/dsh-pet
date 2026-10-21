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
import { deepseekFullBalance, deepseekPricingTier } from '../deepseek-common';
import { money, obj, sumMoney } from '../internal';
import type { AccountBalanceSnapshot, BalanceProvider, BalanceSuccess } from '../types';

/**
 * 账号余额快照 → 成功结果（纯函数，便于测试直接喂真实结构）。
 *
 * 失败口径：没有可用的充值钱包（未登录 / 查询失败 / 空数组）→ 抛错，由调用方落成 `fetch-error`；
 * 金额非法同理 —— **绝不伪造 0 余额**。
 *
 * 多币种：账号可能同时持有 CNY / USD 钱包，**每个币种各出一条**（`data.wallets`），
 * 选哪个显示交给展示层（它才知道气泡宽度、要不要显示为 0 的币种）。
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
  // 旧实现只取 wallets[0]，会把排在前面的空 USD 钱包当成账户余额，显示成 $0.00。
  // 现在**全部搬出去**（多币种各一条），由展示层决定显示哪些——选哪个币种不该在取数层丢掉。
  const candidates = wallets.map((w) => obj(w as unknown)).filter((w): w is Record<string, unknown> => w !== undefined);
  if (candidates.length === 0) throw new Error('dsh-pet: 账号钱包结构非法');

  // 充值额按币种聚合（同币种出现多条钱包时累加，不丢钱）
  const toppedUpBy = new Map<string, string>();
  for (const w of candidates) {
    const currency = typeof w.currency === 'string' && w.currency.length > 0 ? w.currency : 'CNY';
    const amount = money(w.balance, 'balance');
    const prev = toppedUpBy.get(currency);
    toppedUpBy.set(currency, prev === undefined ? amount : sumMoney(prev, amount));
  }
  // 赠送额同样按币种聚合；币种非法的那条跳过（无法归属，不硬配）
  const grantedBy = new Map<string, string>();
  for (const raw of Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []) {
    const w = obj(raw as unknown);
    if (!w || typeof w.currency !== 'string' || w.currency.length === 0) continue;
    const amount = money(w.balance, 'bonus balance');
    const prev = grantedBy.get(w.currency);
    grantedBy.set(w.currency, prev === undefined ? amount : sumMoney(prev, amount));
  }
  // 只在赠送钱包里出现的币种也补一条：那笔余额是真实可用的，不能因为"没有充值钱包"就凭空消失
  for (const currency of grantedBy.keys()) {
    if (!toppedUpBy.has(currency)) toppedUpBy.set(currency, '0.00');
  }

  const walletsOut = [...toppedUpBy.entries()].map(([currency, toppedUp]) => {
    const granted = grantedBy.get(currency) ?? '0.00';
    const fullBalance = deepseekFullBalance(currency);
    return {
      currency,
      // 与官方路由**同构**：官方文档定义 total_balance = 赠送 + 充值，这里由两个钱包加出来
      total: sumMoney(granted, toppedUp),
      granted,
      toppedUp,
      ...(fullBalance === undefined ? {} : { fullBalance }),
    };
  });
  return {
    ok: true,
    provider,
    shape: 'money',
    data: { wallets: walletsOut, tier: deepseekPricingTier() },
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
