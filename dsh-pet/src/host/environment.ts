/**
 * 此刻的环境事实：城市与天气，供 system 时间行与 /environment 共用。
 *
 * 首选 UAPI（一次请求同时给城市与天气）；它不可用时回落到自建链路（IP 定位 + Open-Meteo）。
 * 只负责“能拿到什么就给什么”，从不抛错——两条链路都失败就返回空对象，对话不能因为查天气挂掉。
 * force 时跳过缓存的读取强制重查，成功后照常覆盖缓存。
 * @module dsh-pet/src/host/environment
 */
import { locateCity } from './ip-city.ts';
import { fetchUapiWeather } from './uapi.ts';
import { queryWeather, type WeatherSnapshot } from './weather.ts';

/** 可注入的依赖（测试用）。 */
export interface EnvironmentDeps {
  /** 注入的 fetch；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 注入的等待（重试间隔）；缺省用 setTimeout。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 注入的时钟（ms）；缺省 `Date.now`。 */
  readonly now?: () => number;
  /** 跳过缓存读取强制重查。 */
  readonly force?: boolean;
  /** 覆盖配置里的城市（测试用）；生产走 {@link setCityProvider}。 */
  readonly city?: string;
}

/** 配置里的天气城市读取口；宿主启动时注入一次，两条取数路径因此自动一致。 */
let cityProvider: () => string | undefined = () => undefined;

/**
 * 注入「配置里的天气城市」读取口。
 *
 * 只注入一次、所有调用方共享：/environment 路由与 system 时间行调的是同一个函数，
 * 各自再去读配置就会出现两边说法不一致。
 *
 * @param provider - 返回配置的城市名；空串或 undefined 表示跟随 IP 自动定位。
 */
export function setCityProvider(provider: () => string | undefined): void {
  cityProvider = provider;
}

/** 环境事实：省市两段分开给，拼成一句话是消费方的事。 */
export interface EnvironmentFacts {
  /** 省 / 州，如“江西省”；上游没给时缺省。 */
  readonly region?: string;
  /** 市，如“南昌市”；两条链路都定位不到时整条结果为空。 */
  readonly city?: string;
  /** 可用的当前天气；查不到时缺省。 */
  readonly weather?: WeatherSnapshot;
}

/**
 * 查一次此刻的环境。
 *
 * @param deps - 注入的 fetch、等待、时钟与 force。
 * @returns 城市与天气；都没有时是空对象（调用方据此少写几段）。
 */
export async function currentEnvironment(deps: EnvironmentDeps = {}): Promise<EnvironmentFacts> {
  // 配置的城市优先：用户既然写了，就不该再让 IP 归属地库替他决定
  const city = (deps.city ?? cityProvider() ?? '').trim();
  try {
    // 首选 UAPI：一次请求同时给城市与天气，省掉「IP 定位 + 地名搜索」两次往返；
    // 它的 IP 定位实测比 ip-api 准（同一个教育网出口，它给南昌、ip-api 给上海）
    const uapi = await fetchUapiWeather(city === '' ? deps : { ...deps, city });
    if (uapi !== null) {
      return {
        ...(uapi.region === '' ? {} : { region: uapi.region }),
        city: uapi.city,
        weather: uapi.weather,
      };
    }
    // 配了城市：UAPI 不可用就直接按城市名查，跳过 IP 定位——用户已经说了在哪，
    // 再让 IP 库投票只会把它改回省会或邻市
    if (city !== '') {
      const weather = await queryWeather(city, deps);
      return weather === null ? { city } : { city: weather.city, weather };
    }
    // 回落：自建链路（IP 定位 → 地名搜索 → 天气）
    const located = await locateCity(deps);
    if (located === null) return {};
    const weather = await queryWeather(located.city, deps);
    return {
      ...(located.region === '' ? {} : { region: located.region }),
      city: located.city,
      ...(weather === null ? {} : { weather }),
    };
  } catch {
    // 两条链路都自带兜底，走到这里只可能是意料外的事：宁可不写，也别让这一句对话挂掉
    return {};
  }
}
