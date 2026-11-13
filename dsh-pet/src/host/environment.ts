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
  try {
    // 首选 UAPI：一次请求同时给城市与天气，省掉「IP 定位 + 地名搜索」两次往返；
    // 它的 IP 定位实测比 ip-api 准（同一个教育网出口，它给南昌、ip-api 给上海）
    const uapi = await fetchUapiWeather(deps);
    if (uapi !== null) {
      return {
        ...(uapi.region === '' ? {} : { region: uapi.region }),
        city: uapi.city,
        weather: uapi.weather,
      };
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
