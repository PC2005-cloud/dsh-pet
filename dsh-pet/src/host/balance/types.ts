/**
 * 余额查询的契约层：服务商定义、取数上下文、路由结果、各形态的数据形状。
 *
 * 这里**只放形状与契约**，不放任何具体服务商的知识 —— 接口地址、业务额度、响应解析都在
 * `./providers/<名>.ts` 里各自一份。加一个服务商 = 加一个 provider 文件 + 在 `./index.ts`
 * 的注册表里加一行；本文件与 src/shared 都不用动。
 */

// ---------- 服务商定义（加服务商只需要实现这一个接口） ----------

/**
 * 凭证来源。
 * - `ref`：DSH credentialRef 名（如 `OPENCODE_GO_API_KEY`）—— 由调用方经 `ctx.credentials.resolve`
 *   解析后注入，插件自己不读凭证存储；
 * - `none`：该路由**没有** API Key（账号路由）。凭证是 DSH 账号服务持有的授权记录，只能经服务
 *   查询，见 ./providers/deepseek-account.ts。
 */
export type CredentialSpec = { mode: 'ref'; ref: string } | { mode: 'none' };

/**
 * 取数上下文：所有服务商的 `fetch` 收到的都是**同一个**形状，各取所需。
 * - `key`：已解析的 API Key（`credential.mode === 'ref'` 时保证非空）；`mode === 'none'` 时为空串；
 * - `resolveAccount`：账号余额查询；只有账号路由会读它，其余路由忽略。
 */
export interface BalanceFetchContext {
  /** 命中的 provider id（原样回填进结果，展示层据此区分服务商） */
  provider: string;
  /** 已解析的 API Key；`credential.mode === 'none'` 的路由为空串（它不读这个字段） */
  key: string;
  /** 账号余额查询（调用方注入 ctx.deepseekAccount.getBalance）；仅 `mode === 'none'` 使用 */
  resolveAccount?: () => Promise<AccountBalanceSnapshot | null | undefined>;
}

/**
 * 一个 service provider 的余额查询定义 —— **一行 = 一个自包含服务商**。
 * 接口地址、业务常量、响应解析全在它自己的文件里（见 ./providers/）。
 */
export interface BalanceProvider {
  /** 可命中的 provider id（agentDefaultModel 报告的 id） */
  ids: string[];
  /** 凭证来源（决定 queryBalance 是解析凭证还是调服务） */
  credential: CredentialSpec;
  /**
   * 取数 + 解析。**只负责成功路径**：任何失败（HTTP 非 2xx、字段缺失/非法、未登录、无钱包…）一律
   * `throw`，由 `queryBalance` 统一落成 `fetch-error`。这样所有服务商的失败口径完全一致，也不可能
   * 静默伪造 0 余额。
   */
  fetch(ctx: BalanceFetchContext): Promise<BalanceSuccess>;
}

// ---------- 各形态的数据（host → client 的叶子数据） ----------

/**
 * Command Code 的三窗口用量。
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

/** OpenCode Go 三窗口（该接口保证三窗都在，故三个窗口与三个重置时间都是必填） */
export interface OpencodeUsage {
  rolling: number;
  weekly: number;
  monthly: number;
  rollingResetsAt: string;
  weeklyResetsAt: string;
  monthlyResetsAt: string;
}

/**
 * DeepSeek 账户金额。官方 `/user/balance` 路由与 DSH 账号路由（./providers/deepseek-account.ts）
 * **同构**：两条路由都是这个形状，展示层因而共用同一套气泡。
 */
export interface DeepseekBalance {
  currency: string;
  total: string;
  granted: string;
  toppedUp: string;
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

// ---------- 路由结果 ----------

/** 成功结果（client 端与 host 端同构使用）：`kind` 是展示形态，`provider` 是当前到底是谁 */
export type BalanceSuccess =
  | { ok: true; provider: string; kind: 'opencode'; data: OpencodeUsage }
  | { ok: true; provider: string; kind: 'commandcode'; data: CommandCodeUsage }
  | { ok: true; provider: string; kind: 'deepseek'; data: DeepseekBalance };

/**
 * 按当前服务商查询余额的结果。
 * 失败带 `reason` 与可选 `message` —— 绝不返回伪造数字（0 余额必须来自接口，不能来自兜底）。
 */
export type BalanceResult =
  | BalanceSuccess
  | { ok: false; provider: string; reason: 'unsupported' | 'credential-missing' | 'fetch-error'; message?: string };
