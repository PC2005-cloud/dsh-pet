/**
 * UAPI 天气适配（host 半侧，免 key）：一次请求同时拿到城市与当前天气，映射成现有的 WeatherSnapshot。
 *
 * 上游是第三方聚合站，字段是它自己的口径：风力按「级」、图标是私有编号、更新时间是相对文案。
 * 这里只做换算与收窄，**不改变对外契约**——返回的仍是 WeatherSnapshot，前端与 /environment 的字段一个都不动。
 * 失败一律返回 null：调用方拿它当首选，失败要静默回落到自建链路（IP 定位 + Open-Meteo）。
 * @module dsh-pet/src/host/uapi
 */
import { fetchJson } from './fetch-json.ts';
import type { WeatherSnapshot } from './weather.ts';

/** 端点：不带 city 时上游按客户端 IP 自动定位（实测比 ip-api 准，教育网 IP 能落到南昌）。 */
const UAPI_URL = 'https://uapis.cn/api/v1/misc/weather?extended=true';

/** 结果缓存有效期（ms）：上游是站点数据、5~10 分钟一刷，且对话是高频路径，1 小时太旧。 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 蒲福风级 0–12 级的风速区间中值（km/h）；表外的级别按 12 级兜底。 */
const WIND_KPH_BY_LEVEL: readonly number[] = [0.5, 3, 8.5, 15.5, 24.5, 34.5, 44.5, 55.5, 68, 81, 94, 108, 118];

/**
 * UAPI 图标码 → 既有 WMO 码；前端那 27 个图标按 WMO 画，所以换算在宿主完成。
 *
 * 上游沿用和风那套 100–999 的编号；同义码合并到同一档（小雨与毛毛雨都按 WMO 61），
 * 表外的码回落到 3（阴），不让一个没见过的码把图标画空。
 */
const WMO_BY_UAPI_ICON: ReadonlyMap<number, number> = new Map([
  [100, 0],
  [150, 0],
  [101, 1],
  [102, 1],
  [103, 2],
  [104, 3],
  [300, 80],
  [301, 81],
  [302, 95],
  [303, 95],
  [304, 96],
  [305, 61],
  [309, 61],
  [306, 63],
  [314, 63],
  [307, 65],
  [308, 65],
  [310, 65],
  [311, 65],
  [312, 65],
  [315, 65],
  [316, 65],
  [317, 65],
  [318, 65],
  [399, 61],
  [313, 66],
  [400, 71],
  [408, 71],
  [499, 71],
  [404, 71],
  [405, 71],
  [406, 71],
  [401, 73],
  [409, 73],
  [402, 75],
  [403, 75],
  [410, 75],
  [407, 85],
  [500, 45],
  [501, 45],
  [509, 45],
  [514, 45],
  [515, 45],
  [502, 45],
  [511, 45],
  [512, 45],
  [513, 45],
  [503, 45],
  [504, 45],
  [507, 45],
  [508, 45],
]);

/** 一次 UAPI 查询的结果：城市与快照；城市来自上游（IP 定位或城市名回显）。 */
export interface UapiEnvironment {
  /** 省 / 州，如“江西省”。 */
  readonly region: string;
  /** 市，如“南昌市”。 */
  readonly city: string;
  /** 已换算成现有快照形状的当前天气。 */
  readonly weather: WeatherSnapshot;
}

/** 最近一次成功结果（只有「自动定位」这一种键，进程内单条）。 */
let cached: { readonly value: UapiEnvironment; readonly at: number } | null = null;

/** 进行中的请求；并发调用共享它，避免同时打两次上游。 */
let inFlight: Promise<UapiEnvironment | null> | null = null;

/** 清空缓存与进行中的请求。 @internal 仅测试使用。 */
export function resetUapiCache(): void {
  cached = null;
  inFlight = null;
}

/** 可注入的依赖（测试用）。 */
export interface UapiDeps {
  /** 注入的 fetch；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 注入的等待（重试间隔）；缺省用 setTimeout。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 注入的时钟（ms）；缺省 `Date.now`，用于缓存与相对时间换算。 */
  readonly now?: () => number;
  /** 跳过缓存强制重查（右键「查询天气」走这条）。 */
  readonly force?: boolean;
  /** 用户配置的城市；非空则按它查，不再由上游按 IP 定位。 */
  readonly city?: string;
}

/**
 * 查一次自动定位的城市与天气。
 *
 * @param deps - 注入的 fetch、等待、时钟与 force。
 * @returns 城市与快照；上游不可用或字段不全时为 null（调用方回落）。
 */
export async function fetchUapiWeather(deps: UapiDeps = {}): Promise<UapiEnvironment | null> {
  const now = deps.now ?? Date.now;
  if (deps.force !== true && cached !== null && now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (inFlight !== null) return inFlight;
  const pending = requestUapi(deps)
    .then((value) => {
      if (value !== null) cached = { value, at: now() };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = pending;
  return pending;
}

/** 真正打一次上游；任何异常都折成 null。 */
async function requestUapi(deps: UapiDeps): Promise<UapiEnvironment | null> {
  // 带 city 就按城市查，不带则由上游按客户端 IP 自动定位；上游认得「扬州」这种不带「市」的写法
  const city = (deps.city ?? '').trim();
  const url = city === '' ? UAPI_URL : UAPI_URL + '&city=' + encodeURIComponent(city);
  let body: Record<string, unknown> | undefined;
  try {
    body = recordOf(await fetchJson(url, { label: 'uapis.cn', fetchImpl: deps.fetchImpl, sleep: deps.sleep }));
  } catch {
    return null;
  }
  return body === undefined ? null : toEnvironment(body, (deps.now ?? Date.now)());
}

/**
 * 上游报文 → 城市与快照。
 *
 * 必填字段（城市、天气文本、温度、湿度）缺一个就整份判失败——宁可回落，也不给前端半个天气。
 * 体感缺失时按气温兜底（上游不传 extended 时才可能缺，这里始终带 expanded）。
 *
 * @param body - 上游 JSON 对象。
 * @param nowMs - 换算相对更新时间用的当前时刻。
 * @returns 归一后的结果；字段不全时 null。
 */
function toEnvironment(body: Record<string, unknown>, nowMs: number): UapiEnvironment | null {
  const city = textOf(body.city);
  const summary = textOf(body.weather);
  const temperatureC = numOf(body.temperature);
  const humidityPercent = numOf(body.humidity);
  if (city === undefined || summary === undefined || temperatureC === undefined || humidityPercent === undefined) {
    return null;
  }
  const apparentC = numOf(body.feels_like) ?? temperatureC;
  return {
    region: textOf(body.province) ?? '',
    city,
    weather: {
      city,
      summary,
      temperatureC,
      apparentC,
      humidityPercent,
      windKph: windKphOf(textOf(body.wind_power)),
      code: wmoOf(numOf(body.weather_icon)),
      observedAt: observedAtOf(body.report_time, nowMs),
    },
  };
}

/** 风级文本（「2级」/「Level 3」）→ 风速（km/h 区间中值）；认不出时 0。 */
function windKphOf(text: string | undefined): number {
  const level = text === undefined ? undefined : /(\d+)/.exec(text);
  if (level === undefined || level === null) return 0;
  const index = Math.min(Number(level[1]), WIND_KPH_BY_LEVEL.length - 1);
  return WIND_KPH_BY_LEVEL[index] ?? 0;
}

/** 图标码 → WMO 码；表外一律按「阴」。 */
function wmoOf(icon: number | undefined): number {
  if (icon === undefined) return 3;
  return WMO_BY_UAPI_ICON.get(icon) ?? 3;
}

/**
 * 更新时间 → `HH:mm`。
 *
 * 上游两种写法：国内是「7 分钟前发布」，国外是「2026-11-13 15:00」；前者按当前时刻倒推，
 * 认不出时用当前时刻——气泡脚注只用来表示「这是什么时候的数据」，不让它空着。
 */
function observedAtOf(raw: unknown, nowMs: number): string {
  const text = typeof raw === 'string' ? raw : '';
  const absolute = /(\d{1,2}):(\d{2})/.exec(text);
  if (absolute !== null) return pad2(Number(absolute[1])) + ':' + absolute[2];
  const relative = /(\d+)\s*分钟前/.exec(text);
  const at = relative === null ? nowMs : nowMs - Number(relative[1]) * 60 * 1000;
  const date = new Date(at);
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/** 两位补零。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 取普通对象；数组、null 与其它类型返回 undefined。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 取非空字符串。 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 取有限数值；字符串数字也接受（上游偶尔把温度写成字符串）。 */
function numOf(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
