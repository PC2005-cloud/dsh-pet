/**
 * 余额查询的**内部工具**（host 侧）：网络策略 + 响应校验 + 金额处理。
 *
 * 只给 ./providers/* 用。所有服务商共用同一套口径：
 * - 网络：20s 超时 + 3 次重试（实测该环境对境外端点间歇性超时）；
 * - 校验：必填字段缺失/非法一律 `throw`，**绝不静默当 0**（失败要显式暴露成 fetch-error）；
 * - 可选字段：缺失就是缺失（`undefined`），不补默认值。
 */

/** 抓取超时（ms） */
const FETCH_TIMEOUT_MS = 20_000;
/** 单次抓取失败后的重试次数（失败间隔 0.8s 线性退避） */
const RETRIES = 3;

/** fetch 一次，带超时；失败抛错（调用方决定是否重试） */
async function fetchOnce(url: string, key: string): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: 'Bearer ' + key, 'User-Agent': 'dsh-pet-balance' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/** fetch + 重试；全败抛最后错误 */
export async function fetchWithRetry(url: string, key: string): Promise<Response> {
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
export function num(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('dsh-pet: 余额数据非法字段 ' + what);
  return n;
}

/** 字符串兜底校验：非空字符串，否则 throw */
export function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('dsh-pet: 余额数据非法字段 ' + what);
  return value;
}

/** 宽松数值（数字或数字字符串）：缺失/空/非法 → undefined（可选字段用；必填字段走 num() 抛错） */
export function looseNum(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 取对象：不是对象（含数组/null）→ undefined */
export function obj(value: unknown): Record<string, unknown> | undefined {
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
export function readWindow(value: unknown): { percent: number; capUsd: number; resetsAt?: string } | undefined {
  const w = obj(value);
  if (!w) return undefined;
  const used = looseNum(w.used);
  const cap = looseNum(w.cap);
  if (used === undefined || cap === undefined || cap <= 0) return undefined;
  // 下界取 0（-1 之类的负用量是无意义数据，按「未消耗」读）；上界不夹——超额时如实报 >100%
  return { percent: Math.max(0, (used / cap) * 100), capUsd: cap, resetsAt: resetTime(w.resetAt) };
}

/** 查询串：只带出现过的参数（`orgId` 取不到时不硬塞空值） */
export function queryString(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][];
  return pairs.length > 0 ? '?' + pairs.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : '';
}

/**
 * 账号侧金额 → 两位小数字符串。
 *
 * 平台回传的是**保留服务端精度的原始串**（实测形如 `9.9902690000000000`，README 亦声明
 * 允许 `0E-16`、`5.0000000000000000` 这类写法），直接显示会变成 `¥9.9902690000000000`，
 * 与官方路由的 `¥8.79` 风格不一致 —— 故在这里收敛到两位小数。
 * 非法（非数字）仍抛错，绝不伪造 0。
 */
export function money(value: unknown, what: string): string {
  const raw = str(value, what);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('dsh-pet: 账号余额金额非法 ' + what);
  return n.toFixed(2);
}

/**
 * 两个金额串相加 → 两位小数。
 * 走整数分相加（先四舍五入到分），避免 0.1+0.2 这类二进制浮点误差在金额上显形。
 */
export function sumMoney(a: string, b: string): string {
  return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}
