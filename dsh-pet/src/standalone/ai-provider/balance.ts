/**
 * 独立模式的余额查询：把设置页填的密钥注入 host 半侧的服务商定义。
 *
 * 独立模式没有 DSH 账号服务，也没有 credential store，密钥只有设置页保存的那一把；
 * 因此这里只做一件事——把 key 包成 queryBalance 需要的解析回调，取数与解析全走 host 半侧。
 * @module dsh-pet/src/standalone/ai-provider/balance
 */
import { queryBalance as queryProviderBalance, type BalanceResult } from '../../host/balance/index.ts';

/**
 * 按设置里选中的服务商查询余额。
 * @param provider - 设置中的 balanceProvider；空串表示未选择，直接返回 unsupported。
 * @param apiKey - 设置页保存的密钥；为空时由 host 半侧落成 credential-missing。
 * @returns host 半侧的归一化结果；失败绝不带伪造数字。
 */
export async function queryStandaloneBalance(provider: string, apiKey: string): Promise<BalanceResult> {
  if (!provider) return { ok: false, provider: '', reason: 'unsupported' };
  return queryProviderBalance(provider, async () => (apiKey ? apiKey : undefined));
}
