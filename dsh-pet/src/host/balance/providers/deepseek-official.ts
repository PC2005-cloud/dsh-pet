/**
 * DeepSeek 官方 API Key 路由（provider id deepseek-official）：账户金额。
 *
 * 取 GET https://api.deepseek.com/user/balance 后按币种逐条搬出 balance_infos；
 * 只取首条会让后面的币种凭空消失。金额原样透传，不按赠送加充值重算。
 * 档位基准与峰谷取自 ./deepseek-common.ts；重试与校验细节统一走 ./internal.ts。
 *
 * @module dsh-pet/src/host/balance/providers/deepseek-official
 */
import { deepseekFullBalance, deepseekPricingTier } from '../deepseek-common.ts';
import { fetchWithRetry, obj, str } from '../internal.ts';
import type { BalanceProvider } from '../types.ts';

/** 官方 API Key 路由的 id；独立模式据此判断余额那把 key 是不是 DeepSeek 的。 */
export const DEEPSEEK_OFFICIAL_PROVIDER_ID = 'deepseek-official';

/** DeepSeek 官方 API Key 路由的内置定义。 */
export const deepseekOfficial: BalanceProvider = {
  id: DEEPSEEK_OFFICIAL_PROVIDER_ID,
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
