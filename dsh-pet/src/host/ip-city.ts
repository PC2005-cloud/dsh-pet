/**
 * 出口 IP → 城市（host 半侧，免 key）：ip-api.com 首选，失败回落 ipwho.is。
 *
 * 只回答“大致在哪个城市”，不承诺精确：同一 IP 两家库可能给出不同城市，实测出现过
 * 「ip-api 说南昌、ipwho.is 说鹰潭」。缓存 6 小时且并发单飞；查不到返回 null，调用方不得编造城市。
 * 失败不抛也不记日志：说不说、怎么说由调用方决定。
 * @module dsh-pet/src/host/ip-city
 */
import { fetchJson } from './fetch-json.ts';

/** 一次定位可注入的依赖（测试用）。 */
export interface LocateCityDeps {
  /** 注入的 fetch；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 注入的等待（重试间隔）；缺省用 setTimeout。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 注入的时钟（ms）；缺省 `Date.now`，用于缓存判定。 */
  readonly now?: () => number;
  /** 跳过缓存读取强制重查；成功后照旧覆盖缓存，失败不动旧值。 */
  readonly force?: boolean;
}

/** 定位结果：只有 IP 库给出的大致位置。 */
export interface CityLocation {
  /** 城市名；ip-api 给中文，ipwho.is 给英文。 */
  readonly city: string;
  /** 一级行政区（省 / 州）；两家都可能给空串。 */
  readonly region: string;
  /** 国家名。 */
  readonly country: string;
}

/** 缓存有效期（ms）：IP 与城市的对应关系变得很慢。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 首选端点：免费、免 key、中文地名；代价是只能走明文 HTTP。 */
const IP_API_URL = 'http://ip-api.com/json/?lang=zh-CN&fields=status,city,regionName,country';

/** 兜底端点：HTTPS、免 key，城市为英文。 */
const IP_WHO_URL = 'https://ipwho.is/';

/** 最近一次成功结果；进程内单条，键就是“这台机器当前出口”。 */
let cached: { readonly value: CityLocation; readonly at: number } | null = null;

/** 进行中的请求；并发调用共享它，避免同时打两个端点。 */
let inFlight: Promise<CityLocation | null> | null = null;

/** 清空缓存与进行中的请求。 @internal 仅测试使用。 */
export function resetCityCache(): void {
  cached = null;
  inFlight = null;
}

/**
 * 定位当前出口 IP 所在城市。
 *
 * @param deps - 可注入的 fetch、等待与时钟。
 * @returns 城市信息；两个端点都失败或返回不可用时为 null。
 */
export async function locateCity(deps: LocateCityDeps = {}): Promise<CityLocation | null> {
  const now = deps.now ?? Date.now;
  if (deps.force !== true && cached !== null && now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (inFlight !== null) return inFlight;
  const pending = locateFresh(deps).finally(() => {
    inFlight = null;
  });
  inFlight = pending;
  return pending;
}

/** 依次问两个端点，任一成功即写缓存。 */
async function locateFresh(deps: LocateCityDeps): Promise<CityLocation | null> {
  const now = deps.now ?? Date.now;
  const value = (await askIpApi(deps)) ?? (await askIpWho(deps));
  if (value !== null) cached = { value, at: now() };
  return value;
}

/** ip-api.com：`status` 不是 success 视作没查到。 */
async function askIpApi(deps: LocateCityDeps): Promise<CityLocation | null> {
  try {
    const body = recordOf(
      await fetchJson(IP_API_URL, { label: 'ip-api', fetchImpl: deps.fetchImpl, sleep: deps.sleep }),
    );
    if (body === undefined || body.status !== 'success') return null;
    const city = textOf(body.city);
    if (city === undefined) return null;
    return { city, region: textOf(body.regionName) ?? '', country: textOf(body.country) ?? '' };
  } catch {
    return null;
  }
}

/** ipwho.is：`success` 不为 true 或没有城市时视作没查到。 */
async function askIpWho(deps: LocateCityDeps): Promise<CityLocation | null> {
  try {
    const body = recordOf(
      await fetchJson(IP_WHO_URL, { label: 'ipwho.is', fetchImpl: deps.fetchImpl, sleep: deps.sleep }),
    );
    if (body === undefined || body.success !== true) return null;
    const city = textOf(body.city);
    if (city === undefined) return null;
    return { city, region: textOf(body.region) ?? '', country: textOf(body.country) ?? '' };
  } catch {
    return null;
  }
}

/** 取普通对象；数组、null 与其它类型返回 undefined。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 取非空字符串；其它类型或空串返回 undefined。 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
