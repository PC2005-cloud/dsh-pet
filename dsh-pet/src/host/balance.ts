/**
 * 余额查询（host 半侧）：把「当前服务商」映射到对应的余额/用量接口并抓取。
 *
 * 设计：
 * - 数据源按「服务商 provider id」寻址（来源 = agentDefaultModel.currentSelection().provider）；
 * - 只登记**有查询接口**的服务商（公开文档化，或第一方 CLI 正在用的未文档化路由）；一个都没有的
 *   服务商不在此表 → 显式 `unsupported`，由上层决定不显示，绝不静默伪造 0 余额；
 * - key 由调用方经 DSH 官方 credentialRef 解析后注入（不直接读 .credentials.yaml）；
 * - 例外：DSH 账号路由（`deepseek-account`，免费额度 / 平台登录）**没有** API Key，它的凭证是
 *   账号服务持有的授权记录，由调用方经 `resolveAccount` 注入查询（同样不直接读凭证存储）；
 * - 网络超时 + 重试（实测该环境对境外端点间歇性超时）；
 * - Command Code 的用量在**控制面** `/alpha/*`（官方 CLI 使用、未文档化），与推理数据面的
 *   `/provider`、`/provider/v1` 不是同一条路径：先 whoami 取 orgId，再依次取额度 / 订阅 / 当期消耗。
 */

/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 20_000;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;

/** 一个 service provider 的余额查询定义 */
export interface BalanceProvider {
  /** 可命中的 provider id（agentDefaultModel 报告的 id） */
  ids: string[];
  /**
   * 凭证引用名（credentialRef），如 OPENCODE_GO_API_KEY。
   * 账号路由（`deepseek-account`）**没有** API Key：它的凭证是 DSH 账号服务持有的授权记录，
   * 由 `resolveAccount` 注入查询，故此处留空字符串。
   */
  ref: string;
  /** 展示类型：`opencode` / `commandcode` = 三窗口用量（百分比 + 重置时间）；`deepseek` = 账户金额 */
  kind: 'opencode' | 'deepseek' | 'commandcode';
}

/** 已知可查询余额的服务商（登记口径见模块头：只收有接口的，其余 → `unsupported`） */
export const BALANCE_PROVIDERS: BalanceProvider[] = [
  { ids: ['opencode-go'], ref: 'OPENCODE_GO_API_KEY', kind: 'opencode' },
  { ids: ['commandcode'], ref: 'COMMANDCODE_API_KEY', kind: 'commandcode' },
  { ids: ['deepseek-official'], ref: 'DEEPSEEK_API_KEY', kind: 'deepseek' },
  // DSH 账号路由（免费额度 / 平台登录）：与 deepseek-official 共用同一套「余额」展示，
  // 但取数走 DSH 第一方的账号服务（ctx.deepseekAccount.getBalance），不是 HTTP + API Key。
  { ids: ['deepseek-account'], ref: '', kind: 'deepseek' },
];

/** provider id → 唯一匹配定义；未匹配返回 undefined（= 不支持查询） */
export function matchBalanceProvider(provider: string): BalanceProvider | undefined {
  return BALANCE_PROVIDERS.find((p) => p.ids.includes(provider));
}

/**
 * Command Code 的三窗口用量（host → client 的叶子数据）。
 * 字段名与 opencode 对齐，展示层共用同一套「取最紧迫窗口」逻辑：`rolling` = `windowLimits.fiveHour`、
 * `weekly` = `windowLimits.weekly`、`monthly` = 套餐月度额度（消耗 /（消耗 + 剩余））。
 * `rolling`/`weekly` 只在 `windowLimits.limited === true` 且 `cap > 0` 时出现（缺省 = 无此窗口，不是 0）；
 * `*CapUsd` 为窗口满额度（月度池为 0 时缺省）；`*ResetsAt` 缺省按「已重置」处理。
 */
export interface CommandCodeUsage {
  monthly: number;
  rolling?: number;
  weekly?: number;
  rollingCapUsd?: number;
  weeklyCapUsd?: number;
  monthlyCapUsd?: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
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
      kind: 'commandcode';
      data: CommandCodeUsage;
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

// ---------- Command Code（`/alpha` 控制面） ----------

/** Command Code 控制面基址（`/alpha/*` 固定在根域名） */
const COMMAND_CODE_API_BASE = 'https://api.commandcode.ai';

/** 宽松数值（数字或数字字符串）：缺失/空/非法 → undefined（可选字段用；必填字段走 num() 抛错） */
function looseNum(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 取对象：不是对象（含数组/null）→ undefined */
function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 重置时间：字符串原样（ISO 8601）；数字时间戳按秒/毫秒自动识别转 ISO；0 / 负数 / 非法 → undefined。
 * 真实报文里空闲窗口是 `resetAt: 0`（占位值，不是 1970 年重置）→ 视为「无重置时间」。
 */
function resetTime(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  const n = looseNum(value);
  if (n === undefined || n <= 0) return undefined;
  const ms = n < 1_000_000_000_000 ? n * 1000 : n; // 秒级时间戳 < 1e12，毫秒级 >= 1e12
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** 一个限额窗口（`{used, cap, resetAt}`）→ 百分比 + 满额度 + 重置时间；形态不认识 → undefined（该窗口视为不存在） */
function readWindow(value: unknown): { percent: number; capUsd: number; resetsAt?: string } | undefined {
  const w = obj(value);
  if (!w) return undefined;
  const used = looseNum(w.used);
  const cap = looseNum(w.cap);
  if (used === undefined || cap === undefined || cap <= 0) return undefined;
  // 下界取 0（-1 之类的负用量是无意义数据，按「未消耗」读）；上界不夹——超额时如实报 >100%
  return { percent: Math.max(0, (used / cap) * 100), capUsd: cap, resetsAt: resetTime(w.resetAt) };
}

/**
 * 解析 Command Code 三个接口的响应 → `BalanceResult`（纯函数：网络与凭证都在外面，测试直接喂真实报文）。
 *
 * 数据来源与口径（与官方 CLI 的 `/alpha` 路由一致）：
 * - `credits`：`monthlyCredits` + `purchasedCredits` + `freeCredits` = 剩余额度；
 * - `windowLimits`：`limited` 为真才有 5h（`fiveHour`）/ 周窗口，各 `{used, cap, resetAt}`；
 * - `usage/summary` 的 `totalCost` = 当期已消耗 → 月度百分比 = 消耗 /（消耗 + 剩余）；
 * - 订阅接口（可选）只提供月度重置时间（`currentPeriodEnd`）。
 *
 * 失败口径：**必填字段缺失/非法一律抛错**（调用方落成 `fetch-error`，绝不伪造 0 余额）；
 * 可选信息（不限额窗口、`cap` 为 0、占位重置时间、订阅缺失）一律省略。
 */
export function parseCommandCode(
  creditsBody: unknown,
  subscriptionBody: unknown,
  summaryBody: unknown,
  provider: string,
): BalanceResult {
  const root = obj(creditsBody);
  const credits = obj(root?.credits);
  if (!credits) throw new Error('dsh-pet: commandcode 响应缺少 credits');

  // 三个额度字段全缺 = 认不出响应形态：宁可报错，也不把分母当 0 算出「已用 100%」
  const creditFields = [credits.monthlyCredits, credits.purchasedCredits, credits.freeCredits];
  if (creditFields.every((v) => looseNum(v) === undefined)) {
    throw new Error('dsh-pet: commandcode credits 响应缺少额度字段');
  }
  const remaining = creditFields.reduce<number>((sum, v) => sum + Math.max(0, looseNum(v) ?? 0), 0);

  const summary = obj(summaryBody);
  const spentRaw = summary?.totalCost;
  if (spentRaw === undefined || spentRaw === null) throw new Error('dsh-pet: commandcode usage 响应缺少 totalCost');
  const spent = Math.max(0, num(spentRaw, 'totalCost'));

  const pool = spent + remaining;
  const data: CommandCodeUsage = { monthly: pool > 0 ? (spent / pool) * 100 : 0 };
  if (pool > 0) data.monthlyCapUsd = pool;

  const subscription = obj(obj(subscriptionBody)?.data);
  const periodEnd = subscription?.currentPeriodEnd;
  if (typeof periodEnd === 'string' && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;

  // 实际报文把 windowLimits 放在 credits 同级；同时兼容嵌在 credits 内的变体
  const limits = obj(root?.windowLimits) ?? obj(credits.windowLimits);
  if (limits?.limited === true) {
    const fiveHour = readWindow(limits.fiveHour);
    if (fiveHour) {
      data.rolling = fiveHour.percent;
      data.rollingCapUsd = fiveHour.capUsd;
      if (fiveHour.resetsAt) data.rollingResetsAt = fiveHour.resetsAt;
    }
    const weekly = readWindow(limits.weekly);
    if (weekly) {
      data.weekly = weekly.percent;
      data.weeklyCapUsd = weekly.capUsd;
      if (weekly.resetsAt) data.weeklyResetsAt = weekly.resetsAt;
    }
  }

  return { ok: true, provider, kind: 'commandcode', data };
}

/** 抓一次 JSON（GET + Bearer），HTTP 非 2xx 抛错；`label` 是接口路径，只进错误信息（便于自查哪一个失败） */
async function fetchJson(url: string, key: string, label: string): Promise<unknown> {
  const res = await fetchWithRetry(url, key);
  if (!res.ok) throw new Error('commandcode ' + label + ' HTTP ' + res.status);
  return (await res.json()) as unknown;
}

/** 查询串：只带出现过的参数（`orgId` 取不到时不硬塞空值） */
function queryString(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][];
  return pairs.length > 0 ? '?' + pairs.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '';
}

/** 抓取 Command Code 三窗口用量（控制面 `/alpha/*`，官方 CLI 同款路由） */
async function fetchCommandCode(key: string, provider: string): Promise<BalanceResult> {
  const base = COMMAND_CODE_API_BASE;
  const whoami = obj(await fetchJson(base + '/alpha/whoami' + queryString({ limits: '1' }), key, '/alpha/whoami'));
  const org = obj(whoami?.org);
  const orgId = typeof org?.id === 'string' && org.id.length > 0 ? org.id : undefined;

  const credits = await fetchJson(
    base + '/alpha/billing/credits' + queryString({ orgId }),
    key,
    '/alpha/billing/credits',
  );

  // 订阅是**可选**的：按量付费账号可能没有订阅（该接口非 2xx），此时只是月度窗口缺重置倒计时，
  // 三个窗口的百分比一个都不少 → 不因此整体失败（也不编造一个重置时间）
  let subscription: unknown;
  try {
    subscription = await fetchJson(
      base + '/alpha/billing/subscriptions' + queryString({ orgId }),
      key,
      '/alpha/billing/subscriptions',
    );
  } catch {
    subscription = undefined;
  }

  // since 只在拿得到当期起始时间时带：该接口的默认区间由服务端决定，插件不猜
  const periodStart = obj(obj(subscription)?.data)?.currentPeriodStart;
  const summary = await fetchJson(
    base +
      '/alpha/usage/summary' +
      queryString({ since: typeof periodStart === 'string' ? periodStart : undefined, orgId }),
    key,
    '/alpha/usage/summary',
  );

  return parseCommandCode(credits, subscription, summary, provider);
}

/**
 * DSH 账号服务的余额快照（`ctx.deepseekAccount.getBalance()` 的返回，只取用到的字段）。
 * 与 `dsh-deepseek-account` 的 `AccountDetails['balance']` 同构：`ready` 带两个钱包数组，
 * `failed` 是"查过但失败"（与"没登录"的 null 不同）。
 */
export interface AccountBalanceSnapshot {
  status: 'ready' | 'failed';
  /** 充值钱包（normal_wallets），金额是保留服务端精度的十进制字符串 */
  value?: readonly { currency?: unknown; balance?: unknown }[];
  /** 赠送钱包（bonus_wallets） */
  bonusWallets?: readonly { currency?: unknown; balance?: unknown }[];
}

/**
 * 账号侧金额 → 两位小数字符串。
 *
 * 平台回传的是**保留服务端精度的原始串**（实测形如 `9.9902690000000000`，README 亦声明
 * 允许 `0E-16`、`5.0000000000000000` 这类写法），直接显示会变成 `¥9.9902690000000000`，
 * 与官方路由的 `¥8.79` 风格不一致 —— 故在这里收敛到两位小数。
 * 非法（非数字）仍抛错，绝不伪造 0。
 */
function money(value: unknown, what: string): string {
  const raw = str(value, what);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('dsh-pet: 账号余额金额非法 ' + what);
  return n.toFixed(2);
}

/**
 * 两个金额串相加 → 两位小数。
 * 走整数分相加（先四舍五入到分），避免 0.1+0.2 这类二进制浮点误差在金额上显形。
 */
function sumMoney(a: string, b: string): string {
  return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}

/**
 * 账号余额快照 → `BalanceResult`（纯函数，便于测试直接喂真实结构）。
 *
 * 展示口径与 `deepseek-official` **完全一致**：气泡都是「余额（峰/谷）¥x.xx」，
 * 金额语义也对齐官方定义 —— `total` = 赠送 + 充值（`granted` + `toppedUp`）。
 * 差异只在取数：一个走 HTTP + API Key，一个走 DSH 账号服务。
 *
 * 失败口径：没有可用的充值钱包（未登录 / 查询失败 / 空数组）→ 抛错，由调用方落成 `fetch-error`；
 * 金额非法同理 —— **绝不伪造 0 余额**。
 *
 * 币种：钱包自带 `CNY`/`USD`，这里一并带出去，展示层据此选符号（CNY → ¥）。
 */
export function parseAccountBalance(
  snapshot: AccountBalanceSnapshot | null | undefined,
  provider: string,
): BalanceResult {
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
    kind: 'deepseek',
    data: {
      currency,
      // 与官方路由**同构**：官方文档定义 total_balance = "The total available balance,
      // including the granted balance and the topped-up balance" —— 即 赠送 + 充值。
      // 只取充值会漏掉赠送额，让可用余额偏小。
      total: sumMoney(granted, toppedUp),
      // deepseek-official 的 granted/toppedUp 语义在账号侧对应「赠送 / 充值」两个钱包
      granted,
      toppedUp,
    },
  };
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
  const match = matchBalanceProvider(provider);
  if (!match) return { ok: false, provider, reason: 'unsupported' };

  // 账号路由没有 API Key：凭证由 DSH 账号服务持有，走 resolveAccount（放在 try 里，
  // 让"未登录 / 查询失败"落成 fetch-error，与 HTTP 分支的失败口径一致）
  if (match.ref === '') {
    if (!resolveAccount) {
      return { ok: false, provider, reason: 'credential-missing', message: '缺少账号服务（deepseek-account）' };
    }
    try {
      return parseAccountBalance(await resolveAccount(), provider);
    } catch (e) {
      return { ok: false, provider, reason: 'fetch-error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  const rc = await resolveKey(match.ref);
  if (!rc) return { ok: false, provider, reason: 'credential-missing', message: '缺少凭证 ' + match.ref };

  try {
    if (match.kind === 'opencode') return await fetchOpencode(rc, provider);
    if (match.kind === 'commandcode') return await fetchCommandCode(rc, provider);
    return await fetchDeepseek(rc, provider);
  } catch (e) {
    return { ok: false, provider, reason: 'fetch-error', message: e instanceof Error ? e.message : String(e) };
  }
}
