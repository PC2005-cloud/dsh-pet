/**
 * 余额查询（host 半侧）：把「当前服务商」映射到对应的余额/用量接口并抓取。
 *
 * 设计：
 * - 数据源按「服务商 provider id」寻址（来源 = agentDefaultModel.currentSelection().provider）；
 * - 只登记有公开查询接口的服务商；未登记（如 opencode/Zen 暂无官方余额 API）→ 显式
 *   `unsupported`，由上层决定不显示，绝不静默伪造 0 余额；
 * - key 由调用方经 DSH 官方 credentialRef 解析后注入（不直接读 .credentials.yaml）；
 * - 网络超时 + 重试（实测该环境对境外端点间歇性超时）。
 */

/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 20_000;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;

/** 一个 service provider 的余额查询定义 */
export interface BalanceProvider {
  /** 可命中的 provider id（agentDefaultModel 报告的 id） */
  ids: string[];
  /** 凭证引用名（credentialRef），如 OPENCODE_GO_API_KEY */
  ref: string;
  /** 展示类型：余额 vs 用量 */
  kind: 'opencode' | 'deepseek';
  /**
   * 取数通道：`key` = 用凭证引用自行发 HTTP（默认）；`account` = 交给 DSH 的账号服务
   * （`ctx.get('deepseekAccount').getBalance()`），本模块不发任何请求。
   */
  via?: 'key' | 'account';
}

/** 已知可查询余额的服务商（只登记有公开 API 的；opencode/Zen 暂无官方余额 API，不在此表） */
export const BALANCE_PROVIDERS: BalanceProvider[] = [
  { ids: ['opencode-go'], ref: 'OPENCODE_GO_API_KEY', kind: 'opencode' },
  { ids: ['deepseek-official'], ref: 'DEEPSEEK_API_KEY', kind: 'deepseek' },
  // DSH 账号登录态（桌面端默认provider）：没有 API key 可用，余额只能经 DSH 自己的
  // `deepseekAccount` 服务读取——token 注入、x-client-* 头、401 失效清理都由该服务负责，
  // 插件不自持凭证（与鲸鱼挂件 dsh-whale-widget 同一数据源与口径）。
  { ids: ['deepseek-account'], ref: '', kind: 'deepseek', via: 'account' },
];

/**
 * 账号服务的余额钱包（与 DSH `@deepseek-ai/dsh-deepseek-account-platform` 的线上契约对齐：
 * 金额是十进制字符串，`value` = 充值钱包、`bonusWallets` = 赠金钱包）。
 */
export interface AccountWallet {
  currency?: unknown;
  balance?: unknown;
}

/** 账号服务 `getBalance()` 的返回值（只声明本模块用到的字段） */
export interface AccountBalanceResponse {
  status?: unknown;
  value?: unknown;
  bonusWallets?: unknown;
}

/** 账号服务取余额的入口（由调用方注入 `ctx.get('deepseekAccount')` 的绑定方法） */
export type AccountBalanceGetter = () => Promise<AccountBalanceResponse | undefined>;

/** provider id → 唯一匹配定义；未匹配返回 undefined（= 不支持查询） */
export function matchBalanceProvider(provider: string): BalanceProvider | undefined {
  return BALANCE_PROVIDERS.find((p) => p.ids.includes(provider));
}

/** 重构后的响应（client 端与 host 端同构使用） */
export type BalanceResult =
  | {
      ok: true;
      provider: string;
      kind: 'opencode';
      data: {
        rolling: number;
        weekly: number;
        monthly: number;
        rollingResetsAt: string;
        weeklyResetsAt: string;
        monthlyResetsAt: string;
      };
    }
  | {
      ok: true;
      provider: string;
      kind: 'deepseek';
      data: { currency: string; total: string; granted: string; toppedUp: string };
    }
  | { ok: false; provider: string; reason: 'unsupported' | 'credential-missing' | 'fetch-error'; message?: string };

/** fetch 一次，带超时；失败抛错（调用方决定是否重试） */
async function fetchOnce(url: string, key: string): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: 'Bearer ' + key, 'User-Agent': 'dsh-pet-balance' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/** fetch + 重试；全败抛最后错误 */
async function fetchWithRetry(url: string, key: string): Promise<Response> {
  let last: unknown;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      return await fetchOnce(url, key);
    } catch (e) {
      last = e;
      if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** 数字兜底校验：数值化失败或非有限数 → throw（数据异常显式报错，不静默当 0） */
function num(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('dsh-pet: 余额数据非法字段 ' + what);
  return n;
}

/** 字符串兜底校验：非空字符串，否则 throw */
function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('dsh-pet: 余额数据非法字段 ' + what);
  return value;
}

/** 抓取 OpenCode Go 用量（/zen/go/v1/usage） */
async function fetchOpencode(key: string, provider: string): Promise<BalanceResult> {
  const res = await fetchWithRetry('https://opencode.ai/zen/go/v1/usage', key);
  if (!res.ok) throw new Error('opencode usage HTTP ' + res.status);
  const body: unknown = await res.json();
  const usage = (body as { usage?: unknown })?.usage;
  if (!usage || typeof usage !== 'object') throw new Error('dsh-pet: opencode usage 响应缺少 usage');
  const u = usage as Record<string, { percent?: unknown; resetsAt?: unknown }>;
  const rolling = u.rolling,
    weekly = u.weekly,
    monthly = u.monthly;
  if (!rolling || !weekly || !monthly) throw new Error('dsh-pet: opencode usage 响应缺少窗口');
  return {
    ok: true,
    provider,
    kind: 'opencode',
    data: {
      rolling: num(rolling.percent, 'rolling.percent'),
      weekly: num(weekly.percent, 'weekly.percent'),
      monthly: num(monthly.percent, 'monthly.percent'),
      rollingResetsAt: str(rolling.resetsAt, 'rolling.resetsAt'),
      weeklyResetsAt: str(weekly.resetsAt, 'weekly.resetsAt'),
      monthlyResetsAt: str(monthly.resetsAt, 'monthly.resetsAt'),
    },
  };
}

/** 抓取 DeepSeek 余额（/user/balance） */
async function fetchDeepseek(key: string, provider: string): Promise<BalanceResult> {
  const res = await fetchWithRetry('https://api.deepseek.com/user/balance', key);
  if (!res.ok) throw new Error('deepseek balance HTTP ' + res.status);
  const body: unknown = await res.json();
  const infos = (body as { balance_infos?: unknown })?.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) throw new Error('dsh-pet: deepseek balance 响应缺少 balance_infos');
  const first = infos[0] as Record<string, unknown>;
  return {
    ok: true,
    provider,
    kind: 'deepseek',
    data: {
      currency: str(first.currency, 'currency'),
      total: str(first.total_balance, 'total_balance'),
      granted: str(first.granted_balance, 'granted_balance'),
      toppedUp: str(first.topped_up_balance, 'topped_up_balance'),
    },
  };
}

/**
 * 解析账号服务返回值：钱包按币种求和 → 与 API key 路径**同口径**的余额结果。
 *
 * 口径说明（与鲸鱼挂件一致）：`total_balance` 本身就是「充值 + 赠金」，
 * 所以 total = 充值(normal/value) + 赠金(bonusWallets)，否则「按余额差」推算的今日已用会偏小。
 *
 * @returns 结构化结果；服务未登录 / 未就绪 / 钱包为空时返回 undefined（调用方回落，绝不伪造 0）
 */
function accountBalanceResult(raw: AccountBalanceResponse, provider: string): BalanceResult | undefined {
  if (raw.status !== 'ready') return undefined;
  const normal = Array.isArray(raw.value) ? (raw.value as AccountWallet[]) : [];
  const bonus = Array.isArray(raw.bonusWallets) ? (raw.bonusWallets as AccountWallet[]) : [];
  if (normal.length === 0) return undefined;

  /** 可数值化的钱包（金额非法直接排除，绝不当 0 计入） */
  const wallets = normal.filter((w) => w && Number.isFinite(Number(w.balance)));
  if (wallets.length === 0) return undefined;

  const currency = wallets.some((w) => String(w.currency ?? '').toUpperCase() === 'CNY')
    ? 'CNY'
    : String(wallets[0].currency ?? 'CNY').toUpperCase();
  /** 同币种金额求和（跨币种不相加：无法换算，只取主币种口径） */
  const sumOf = (list: AccountWallet[]): number =>
    list
      .filter((w) => w && String(w.currency ?? 'CNY').toUpperCase() === currency && Number.isFinite(Number(w.balance)))
      .reduce((s, w) => s + Number(w.balance), 0);

  const toppedUp = sumOf(normal);
  const granted = sumOf(bonus);
  return {
    ok: true,
    provider,
    kind: 'deepseek',
    data: {
      currency,
      total: String(toppedUp + granted),
      granted: String(granted),
      toppedUp: String(toppedUp),
    },
  };
}

/**
 * 按当前服务商查询余额。
 * @param provider agentDefaultModel.currentSelection().provider
 * @param resolveKey 凭证解析：ref 名 → key（由调用方注入 ctx.credentials.resolve）
 * @param accountBalance 账号服务取余额（由调用方注入 `ctx.get('deepseekAccount')` 的绑定方法）；
 *        缺失或返回未就绪 → 回落 `unsupported`，不静默伪装成 0
 * @returns 结构化结果：成功 / 不支持 / 缺凭证 / 抓取失败（失败带 message，绝不返回伪造数字）
 */
export async function queryBalance(
  provider: string,
  resolveKey: (ref: string) => Promise<string | undefined>,
  accountBalance?: AccountBalanceGetter,
): Promise<BalanceResult> {
  const match = matchBalanceProvider(provider);
  if (!match) return { ok: false, provider, reason: 'unsupported' };

  // 账号态：不自持凭证，也不发 HTTP——交给 DSH 的账号服务（老宿主没有该服务 → 仍然是 unsupported）
  if (match.via === 'account') {
    if (!accountBalance) return { ok: false, provider, reason: 'unsupported' };
    try {
      const raw = await accountBalance();
      // 未登录 / 未就绪 / 钱包为空 → undefined，同样回落 unsupported（不伪造 0）
      return raw
        ? (accountBalanceResult(raw, provider) ?? { ok: false, provider, reason: 'unsupported' })
        : { ok: false, provider, reason: 'unsupported' };
    } catch (e) {
      return { ok: false, provider, reason: 'fetch-error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  const rc = await resolveKey(match.ref);
  if (!rc) return { ok: false, provider, reason: 'credential-missing', message: '缺少凭证 ' + match.ref };

  try {
    return match.kind === 'opencode' ? await fetchOpencode(rc, provider) : await fetchDeepseek(rc, provider);
  } catch (e) {
    return { ok: false, provider, reason: 'fetch-error', message: e instanceof Error ? e.message : String(e) };
  }
}
