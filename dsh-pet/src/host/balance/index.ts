/**
 * 余额查询（host 半侧）：把「当前服务商」映射到对应的余额/用量接口并抓取。
 *
 * 设计：
 * - 数据源按「服务商 provider id」寻址（来源 = agentDefaultModel.currentSelection().provider）；
 * - 只登记**有查询接口**的服务商（公开文档化，或第一方 CLI 正在用的未文档化路由）；一个都没有的
 *   服务商不在此表 → 显式 `unsupported`，由上层决定不显示，绝不静默伪造 0 余额；
 * - **一个服务商 = 一个自包含文件**（见 ./providers/）：接口地址、业务常量、响应解析都在它自己那份，
 *   本文件只留注册表与统一的凭证/失败口径。加一个服务商 = 加一个 provider 文件 + 在下面加一行；
 * - key 由调用方经 DSH 官方 credentialRef 解析后注入（不直接读 .credentials.yaml）；
 * - 例外：DSH 账号路由（`deepseek-account`，免费额度 / 平台登录）**没有** API Key，它的凭证是
 *   账号服务持有的授权记录，由调用方经 `resolveAccount` 注入查询（同样不直接读凭证存储）；
 * - 失败口径统一：provider 只负责成功路径，任何失败一律 `throw`，这里统一落成 `fetch-error`。
 */
import { commandCode } from './providers/commandcode';
import { deepseekAccount } from './providers/deepseek-account';
import { deepseekOfficial } from './providers/deepseek-official';
import { opencodeGo } from './providers/opencode-go';
import type { AccountBalanceSnapshot, BalanceProvider, BalanceResult } from './types';

/** 已登记的服务商（登记口径见模块头：只收有接口的，其余 → `unsupported`） */
export const BALANCE_PROVIDERS: BalanceProvider[] = [opencodeGo, commandCode, deepseekOfficial, deepseekAccount];

/** provider id → 唯一匹配定义；未匹配返回 undefined（= 不支持查询） */
export function matchBalanceProvider(provider: string): BalanceProvider | undefined {
  return BALANCE_PROVIDERS.find((p) => p.ids.includes(provider));
}

/**
 * 失败结果（三种 reason 一个出口，避免各处手写字段）。
 * `message` 缺省时**不写这个键** —— 叶子的形状是对外契约，多一个 `undefined` 键会让
 * `deepStrictEqual` 一类的严格比对失败（消费端也按「有/无」判断）。
 */
function failed(
  provider: string,
  reason: 'unsupported' | 'credential-missing' | 'fetch-error',
  message?: string,
): BalanceResult {
  return message === undefined ? { ok: false, provider, reason } : { ok: false, provider, reason, message };
}

/**
 * 按当前服务商查询余额。
 * @param provider agentDefaultModel.currentSelection().provider
 * @param resolveKey 凭证解析：ref 名 → key（由调用方注入 ctx.credentials.resolve）
 * @param resolveAccount 账号余额查询（由调用方注入 ctx.deepseekAccount.getBalance）；
 *   只被 `deepseek-account` 用到。缺省时该路由报 `credential-missing`（账号服务不在场）
 * @returns 结构化结果：成功 / 不支持 / 缺凭证 / 抓取失败（失败带 message，绝不返回伪造数字）
 */
export async function queryBalance(
  provider: string,
  resolveKey: (ref: string) => Promise<string | undefined>,
  resolveAccount?: () => Promise<AccountBalanceSnapshot | null | undefined>,
): Promise<BalanceResult> {
  const def = matchBalanceProvider(provider);
  if (!def) return failed(provider, 'unsupported');

  // 凭证前置检查放在 try 之外：解析凭证本身抛错属于意外异常，由调用方（refreshBalance）兜底 ——
  // 与拆分前的口径一致。账号路由没有 API Key，改为判定「账号服务在不在场」。
  let key = '';
  if (def.credential.mode === 'ref') {
    const resolved = await resolveKey(def.credential.ref);
    if (!resolved) return failed(provider, 'credential-missing', '缺少凭证 ' + def.credential.ref);
    key = resolved;
  } else if (!resolveAccount) {
    return failed(provider, 'credential-missing', '缺少账号服务（' + provider + '）');
  }

  try {
    return await def.fetch({ provider, key, resolveAccount });
  } catch (e) {
    return failed(provider, 'fetch-error', e instanceof Error ? e.message : String(e));
  }
}

// ---- 对外再导出：调用方（宿主与测试）只需要认这一个入口 ----
export { parseAccountBalance } from './providers/deepseek-account';
export { parseCommandCode } from './providers/commandcode';
export type {
  AccountBalanceSnapshot,
  BalanceFetchContext,
  BalanceProvider,
  BalanceResult,
  BalanceShape,
  BalanceSuccess,
  CredentialSpec,
  MoneyBalance,
  PricingTier,
  WindowsUsage,
} from './types';
