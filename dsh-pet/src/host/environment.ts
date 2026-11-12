/**
 * 此刻的环境事实：城市（IP 定位）与天气（Open-Meteo），供 system 时间行与 /environment 共用。
 *
 * 只负责“能拿到什么就给什么”，从不抛错——查不到就少一段，对话不能因为查天气失败而失败。
 * force 时跳过三级缓存的读取强制重查，成功后照常覆盖缓存。
 * 天气的新鲜度由 ./weather 自己的 1 小时缓存兜住，这里不再做第二层超龄判断。
 * @module dsh-pet/src/host/environment
 */
import { locateCity } from './ip-city.ts';
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
  /** 省 / 州，如“江西省”；IP 库没给时缺省。 */
  readonly region?: string;
  /** 市，如“南昌市”；IP 定位不到时整条结果为空。 */
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
    const located = await locateCity(deps);
    if (located === null) return {};
    const weather = await queryWeather(located.city, deps);
    return {
      ...(located.region === '' ? {} : { region: located.region }),
      city: located.city,
      ...(weather === null ? {} : { weather }),
    };
  } catch {
    // 两条查询都自带兜底，走到这里只可能是意料外的事：宁可不写，也别让这一句对话挂掉
    return {};
  }
}
