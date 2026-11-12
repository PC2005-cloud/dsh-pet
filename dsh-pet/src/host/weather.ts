/**
 * 城市天气查询（host 半侧，免 key）：Open-Meteo 的地名搜索与当前天气。
 *
 * 只回答“这座城市现在什么天气”，不猜城市、不编数值：城市查不到或字段非法都返回 null。
 * 两级缓存：城市 → 坐标 7 天（地名不会变），坐标 → 天气 1 小时。
 * 依赖全局 fetch；调用方负责把结果变成一句人话，本模块不拼文案。
 * @module dsh-pet/src/host/weather
 */
import { fetchJson } from './fetch-json.ts';
import { wmoText } from './wmo-code.ts';

/** 一次查询可注入的依赖（测试用）。 */
export interface QueryWeatherDeps {
  /** 注入的 fetch；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 注入的等待（重试间隔）；缺省用 setTimeout。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 注入的时钟（ms）；缺省 `Date.now`，用于缓存判定。 */
  readonly now?: () => number;
  /** 跳过坐标与天气两级缓存的读取强制重查；成功后照旧覆盖缓存，失败不动旧值。 */
  readonly force?: boolean;
}

/** 当前天气快照，字段全部来自 Open-Meteo 的 `current` 段。 */
export interface WeatherSnapshot {
  /** 城市名，取地名搜索返回的中文名（与用户输入可能不同）。 */
  readonly city: string;
  /** 气温（°C）。 */
  readonly temperatureC: number;
  /** 体感温度（°C）。 */
  readonly apparentC: number;
  /** 相对湿度（%）。 */
  readonly humidityPercent: number;
  /** 风速（km/h）。 */
  readonly windKph: number;
  /** WMO 天气码，原样保留。 */
  readonly code: number;
  /** 天气码的中文短语。 */
  readonly summary: string;
  /** 观测时刻，站点当地时间（ISO 字符串，不带时区后缀）。 */
  readonly observedAt: string;
}

/** 坐标缓存有效期（ms）：城市不会搬家。 */
const GEO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 天气缓存有效期（ms）：1 小时——闲聊里不必拿"实时"换每次请求。 */
const WEATHER_TTL_MS = 60 * 60 * 1000;
/** 坐标缓存条目上限：对话里出现的城市数有限，32 条足够。 */
const GEO_CACHE_MAX = 32;

/** 地名搜索：只取第一条，中文名优先。 */
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&format=json&name=';

/** 当前天气端点。 */
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** 需要的 current 字段。 */
const CURRENT_FIELDS = 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code';

/** 一个已解析的地点。 */
interface Place {
  /** 地名（展示用）。 */
  readonly name: string;
  /** 纬度（度）。 */
  readonly latitude: number;
  /** 经度（度）。 */
  readonly longitude: number;
}

/** 城市名 → 地点，带写入时刻。 */
const geoCache = new Map<string, { readonly place: Place; readonly at: number }>();

/** 最近一次天气结果；键是坐标，坐标变了就重查。 */
let weatherCache: { readonly key: string; readonly value: WeatherSnapshot; readonly at: number } | null = null;

/** 清空两级缓存。 @internal 仅测试使用。 */
export function resetWeatherCache(): void {
  geoCache.clear();
  weatherCache = null;
}

/**
 * 查一座城市此刻的天气。
 *
 * @param city - 城市名（中文或英文皆可，交给地名搜索解析）；纯空白视作没给城市。
 * @param deps - 可注入的 fetch、等待与时钟。
 * @returns 天气快照；城市解析不到或上游字段非法时为 null。
 */
export async function queryWeather(city: string, deps: QueryWeatherDeps = {}): Promise<WeatherSnapshot | null> {
  const name = city.trim();
  if (name === '') return null;
  const place = await geocode(name, deps);
  if (place === null) return null;
  const key = place.latitude.toFixed(4) + ',' + place.longitude.toFixed(4);
  const now = deps.now ?? Date.now;
  if (
    deps.force !== true &&
    weatherCache !== null &&
    weatherCache.key === key &&
    now() - weatherCache.at < WEATHER_TTL_MS
  ) {
    return weatherCache.value;
  }
  const snapshot = await fetchCurrent(place, deps);
  if (snapshot !== null) weatherCache = { key, value: snapshot, at: now() };
  return snapshot;
}

/** 城市名 → 坐标；命中缓存时不再发请求；带行政区后缀查不到时去掉后缀再试一次。 */
async function geocode(city: string, deps: QueryWeatherDeps): Promise<Place | null> {
  const now = deps.now ?? Date.now;
  const hit = geoCache.get(city);
  if (deps.force !== true && hit !== undefined && now() - hit.at < GEO_TTL_MS) return hit.place;
  // 上游地名库不认行政区后缀：实测「南昌市」零命中、「南昌」一条命中，IP 定位给的名字正好带「市」
  const bare = withoutAdminSuffix(city);
  const place = (await searchPlace(city, deps)) ?? (bare === city ? null : await searchPlace(bare, deps));
  if (place === null) return null;
  rememberPlace(city, place, now());
  return place;
}

/** 去掉「市 / 县 / 区 / 旗」后缀；去掉后不足两个字就原样返回（免得把「沙市」削成「沙」）。 */
function withoutAdminSuffix(city: string): string {
  const trimmed = city.replace(/[市县区旗]$/u, '');
  return trimmed.length >= 2 ? trimmed : city;
}

/** 一次地名搜索：取第一条结果的坐标与中文名。 */
async function searchPlace(name: string, deps: QueryWeatherDeps): Promise<Place | null> {
  let body: Record<string, unknown> | undefined;
  try {
    body = recordOf(
      await fetchJson(GEOCODE_URL + encodeURIComponent(name), {
        label: 'open-meteo-geocoding',
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      }),
    );
  } catch {
    return null;
  }
  const results = body?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = recordOf(results[0]);
  const latitude = numberOrUndefined(first?.latitude);
  const longitude = numberOrUndefined(first?.longitude);
  if (latitude === undefined || longitude === undefined) return null;
  return { name: textOf(first?.name) ?? name, latitude, longitude };
}

/** 拉当前天气；任一必备字段缺失或非数值都算查询失败。 */
async function fetchCurrent(place: Place, deps: QueryWeatherDeps): Promise<WeatherSnapshot | null> {
  const url =
    FORECAST_URL +
    '?latitude=' +
    place.latitude +
    '&longitude=' +
    place.longitude +
    '&current=' +
    CURRENT_FIELDS +
    '&timezone=auto';
  let body: Record<string, unknown> | undefined;
  try {
    body = recordOf(
      await fetchJson(url, { label: 'open-meteo-forecast', fetchImpl: deps.fetchImpl, sleep: deps.sleep }),
    );
  } catch {
    return null;
  }
  const current = recordOf(body?.current);
  if (current === undefined) return null;
  const temperatureC = numberOrUndefined(current.temperature_2m);
  const apparentC = numberOrUndefined(current.apparent_temperature);
  const humidityPercent = numberOrUndefined(current.relative_humidity_2m);
  const windKph = numberOrUndefined(current.wind_speed_10m);
  const code = numberOrUndefined(current.weather_code);
  const observedAt = textOf(current.time);
  if (
    temperatureC === undefined ||
    apparentC === undefined ||
    humidityPercent === undefined ||
    windKph === undefined ||
    code === undefined ||
    observedAt === undefined
  ) {
    return null;
  }
  return {
    city: place.name,
    temperatureC,
    apparentC,
    humidityPercent,
    windKph,
    code,
    summary: wmoText(code),
    observedAt,
  };
}

/** 写坐标缓存；超过上限时先丢最旧的一条。 */
function rememberPlace(city: string, place: Place, at: number): void {
  if (geoCache.size >= GEO_CACHE_MAX && !geoCache.has(city)) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of geoCache) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) geoCache.delete(oldestKey);
  }
  geoCache.set(city, { place, at });
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

/** 取有限数值；字符串也接受（上游偶尔把数字写成字符串）。 */
function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
