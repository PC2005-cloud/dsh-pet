/**
 * 环境事实的契约测试：城市与天气能拿到几段给几段，任何一步失败都只少一段，绝不让对话失败。
 *
 * fetch 用手写替身，不联网；两条查询的缓存都是模块级的，每个用例先清。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { currentEnvironment } from './environment.ts';
import { resetCityCache } from './ip-city.ts';
import { resetWeatherCache } from './weather.ts';

/** 造一个按调用次序回应的 fetch 替身；步数用尽后一直复用最后一步。 */
function fakeFetch(steps: (() => Response | Promise<Response>)[]): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(String(url));
    return step();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 造一个 JSON 响应。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 不吃真实等待的重试间隔。 */
const NO_SLEEP = async (): Promise<void> => {};

/** ip-api 的成功报文（字段照抄线上响应）。 */
const IP_API_OK = { status: 'success', city: '南昌市', regionName: '江西省', country: '中国' };

/** Open-Meteo 的地名搜索结果。 */
const GEOCODE_OK = { results: [{ name: '南昌', latitude: 28.6828, longitude: 115.8581 }] };

/** Open-Meteo 的当前天气。 */
const CURRENT_OK = {
  current: {
    time: '2026-11-11T20:30',
    temperature_2m: 13.1,
    apparent_temperature: 12.9,
    relative_humidity_2m: 84,
    wind_speed_10m: 2,
    weather_code: 3,
  },
};

describe('currentEnvironment —— 能拿到什么就给什么', () => {
  test('城市与天气都拿到：省、市、天气三段齐全', async () => {
    resetCityCache();
    resetWeatherCache();
    const fake = fakeFetch([() => json(IP_API_OK), () => json(GEOCODE_OK), () => json(CURRENT_OK)]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(facts.region, '江西省');
    assert.equal(facts.city, '南昌市', '省市分开给，拼成一句话是消费方的事');
    assert.equal(facts.weather?.summary, '阴');
    assert.equal(facts.weather?.temperatureC, 13.1);
    assert.equal(fake.calls.length, 3, '两次定位 + 两次天气里的一次成功，共三次');
  });

  test('IP 定位全失败：返回空对象，且不再去查天气', async () => {
    resetCityCache();
    resetWeatherCache();
    const fake = fakeFetch([() => new Response('', { status: 500 })]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(facts, {});
    assert.equal(fake.calls.length, 2, 'ip-api 与 ipwho.is 各一次，没有城市就不查天气');
  });

  test('城市查到但天气查不到：只返回省市，不给 weather 键', async () => {
    resetCityCache();
    resetWeatherCache();
    const fake = fakeFetch([() => json(IP_API_OK), () => json({ results: [] })]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(facts, { region: '江西省', city: '南昌市' });
    assert.equal('weather' in facts, false, '没有数据时不该出现 weather 键');
  });

  test('IP 库没给省：结果里不出现 region 键', async () => {
    resetCityCache();
    resetWeatherCache();
    const fake = fakeFetch([
      () => json({ status: 'success', city: '南昌市', regionName: '', country: '中国' }),
      () => json({ results: [] }),
    ]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(facts, { city: '南昌市' });
  });
});

describe('currentEnvironment —— 强制刷新', () => {
  test('force：跳过缓存再打一次端点，成功后覆盖缓存', async () => {
    resetCityCache();
    resetWeatherCache();
    const fake = fakeFetch([
      () => json(IP_API_OK),
      () => json(GEOCODE_OK),
      () => json(CURRENT_OK),
      () => json({ ...IP_API_OK, city: '九江市', regionName: '江西省' }),
      () => json(GEOCODE_OK),
      () => json(CURRENT_OK),
    ]);

    const first = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });
    const forced = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP, force: true });

    assert.equal(first.city, '南昌市');
    assert.equal(forced.city, '九江市', 'force 必须绕过缓存拿到新结果');
    assert.equal(fake.calls.length, 6, '两次都该真实打三个端点');
  });
});
