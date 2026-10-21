/**
 * DeepSeek 官方 API Key 路由（provider id `deepseek-official`）—— 账户金额。
 *
 * 接口：`GET https://api.deepseek.com/user/balance`（Bearer）。
 * 三个金额由接口原样透传（不自己按 `granted + topped_up` 重算 `total_balance`）—— 官方路由给的
 * 数字比本插件推算的可信。档位基准与峰谷档位取自 ./deepseek-common.ts（两条 deepseek 路由同一套口径）。
 *
 * 与账号路由（./deepseek-account.ts）**同 shape、同形**：展示层共用同一套气泡，差异只在取数。
 * `balance_infos` 是**按币种分条的数组**（账户可同时持有 CNY 与 USD），逐条搬出去——
 * 只取 `[0]` 会让排在后面的币种余额凭空消失。
 */
import { deepseekFullBalance, deepseekPricingTier } from '../deepseek-common';
import { fetchWithRetry, obj, str } from '../internal';
import type { BalanceProvider } from '../types';

export const deepseekOfficial: BalanceProvider = {
  ids: ['deepseek-official'],
  credential: { mode: 'ref', ref: 'DEEPSEEK_API_KEY' },
  async fetch({ key, provider }) {
    const res = await fetchWithRetry('https://api.deepseek.com/user/balance', key);
    if (!res.ok) throw new Error('deepseek balance HTTP ' + res.status);
    const body: unknown = await res.json();
    const infos = (body as { balance_infos?: unknown })?.balance_infos;
    if (!Array.isArray(infos) || infos.length === 0)
      throw new Error('dsh-pet: deepseek balance 响应缺少 balance_infos');
    const wallets = infos.map((raw) => {
      const w = obj(raw) ?? {};
      const currency = str(w.currency, 'currency');
      const fullBalance = deepseekFullBalance(currency);
      return {
        currency,
        total: str(w.total_balance, 'total_balance'),
        granted: str(w.granted_balance, 'granted_balance'),
        toppedUp: str(w.topped_up_balance, 'topped_up_balance'),
        ...(fullBalance === undefined ? {} : { fullBalance }),
      };
    });
    return {
      ok: true,
      provider,
      shape: 'money',
      data: { wallets, tier: deepseekPricingTier() },
    };
  },
};
