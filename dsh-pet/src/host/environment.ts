/**
 * 此刻的环境事实：城市（IP 定位）与天气（Open-Meteo），拼进 system 的时间行。
 *
 * 只负责“能拿到什么就给什么”，从不抛错——查不到就少写一段，对话不能因为查天气失败而失败。
 * 天气的新鲜度由 ./weather 自己的 1 小时缓存兜住，这里不再做第二层超龄判断。
 * @module dsh-pet/src/host/environment
 */
import { locateCity, type CityLocation } from './ip-city.ts';
import { queryWeather, type WeatherSnapshot } from './weather.ts';

/** 可注入的依赖（测试用）。 */
export interface EnvironmentDeps {
  /** 注入的 fetch；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 注入的等待（重试间隔）；缺省用 setTimeout。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 注入的时钟（ms）；缺省 `Date.now`。 */
  readonly now?: () => number;
}

/** 时间行要用的环境事实；两个字段都可能缺省。 */
export interface EnvironmentFacts {
  /** 地点短语（省 + 市）；IP 定位不到时缺省，时间行会省掉“你在……”那半句。 */
  readonly place?: string;
  /** 可用的当前天气；查不到时缺省，时间行会写“这次没查到”的交代。 */
  readonly weather?: WeatherSnapshot;
}

/**
 * 地点短语：省 + 市。
 *
 * 省是城市猜错时的兜底（IP 库给城市常错、给省通常对），也用来消重名城市；
 * 省市互相包含时只留一个（“北京市 / 北京”不该写成“北京市北京”）。
 * 拉丁文地名之间补一个空格，中文之间直接连写。
 *
 * @param located - IP 定位结果。
 * @returns 展示用地点；城市为空时返回 undefined。
 */
function placeTextOf(located: CityLocation): string | undefined {
  const city = located.city;
  if (city === '') return undefined;
  const region = located.region;
  if (region === '' || region === city) return city;
  if (region.includes(city)) return region;
  if (city.includes(region)) return city;
  return /[\u4e00-\u9fa5]$/u.test(region) ? region + city : region + ' ' + city;
}

/**
 * 查一次此刻的环境。
 *
 * @param deps - 注入的 fetch、等待与时钟。
 * @returns 城市与天气；都没有时是空对象（时间行据此只写时间本身）。
 */
export async function currentEnvironment(deps: EnvironmentDeps = {}): Promise<EnvironmentFacts> {
  try {
    const located = await locateCity(deps);
    if (located === null) return {};
    const place = placeTextOf(located);
    if (place === undefined) return {};
    const weather = await queryWeather(located.city, deps);
    // exactOptionalPropertyTypes 未开，但这里仍按“有才写键”来塞，避免把 undefined 当值传下去
    return weather === null ? { place } : { place, weather };
  } catch {
    // 两条查询都自带兜底，走到这里只可能是意料外的事：宁可不写，也别让这一句对话挂掉
    return {};
  }
}
