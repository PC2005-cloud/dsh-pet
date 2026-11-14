/**
 * 环境事实的契约测试：UAPI 优先、失败回落自建链路，任何一步失败都只少一段，绝不让对话失败。
 *
 * fetch 用手写替身，不联网；三条链路的缓存都是模块级的，每个用例先清。
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { currentEnvironment, setCityProvider } from './environment.ts';
import { resetCityCache } from './ip-city.ts';
import { resetUapiCache } from './uapi.ts';
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

/** UAPI 不可用（回落链路用的第一步）。 */
const UAPI_DOWN = (): Response => new Response('', { status: 500 });

/** UAPI 的成功报文（字段照抄线上响应）。 */
const UAPI_OK = {
  province: '江西省',
  city: '南昌市',
  district: '东湖区',
  adcode: '360102',
  weather: '小雨',
  weather_icon: '305',
  temperature: 17,
  wind_direction: '西风',
  wind_power: '2级',
  humidity: 82,
  feels_like: 17,
  report_time: '7 分钟前发布',
};

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

/** 不吃真实等待的重试间隔。 */
const NO_SLEEP = async (): Promise<void> => {};

/** 每个用例都要清的三份模块级缓存。 */
function resetAll(): void {
  resetUapiCache();
  resetCityCache();
  resetWeatherCache();
}

describe('currentEnvironment —— UAPI 首选', () => {
  test('UAPI 成功：一次请求就拿到省市与天气，不再碰自建链路', async () => {
    resetAll();
    const fake = fakeFetch([() => json(UAPI_OK)]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(facts.region, '江西省');
    assert.equal(facts.city, '南昌市');
    assert.equal(facts.weather?.summary, '小雨');
    assert.equal(facts.weather?.temperatureC, 17);
    assert.equal(fake.calls.length, 1, 'UAPI 命中时不该再走 IP 定位与地名搜索');
    assert.ok(fake.calls[0]?.includes('uapis.cn'), '第一次请求应打 UAPI');
  });

  test('UAPI 字段不全：整份判失败，回落到自建链路', async () => {
    resetAll();
    const fake = fakeFetch([
      () => json({ city: '南昌市' }), // 缺天气与温度
      () => json(IP_API_OK),
      () => json(GEOCODE_OK),
      () => json(CURRENT_OK),
    ]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(facts.city, '南昌市');
    assert.equal(facts.weather?.summary, '阴', '应来自 Open-Meteo 的回落结果');
    assert.ok(fake.calls[1]?.includes('ip-api'), 'UAPI 判失败后才该去打 ip-api');
  });
});

describe('currentEnvironment —— 回落链路（UAPI 不可用）', () => {
  test('城市与天气都拿到：省、市、天气三段齐全', async () => {
    resetAll();
    const fake = fakeFetch([UAPI_DOWN, () => json(IP_API_OK), () => json(GEOCODE_OK), () => json(CURRENT_OK)]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(facts.region, '江西省');
    assert.equal(facts.city, '南昌市', '省市分开给，拼成一句话是消费方的事');
    assert.equal(facts.weather?.summary, '阴');
    assert.equal(facts.weather?.temperatureC, 13.1);
    assert.equal(fake.calls.length, 4, 'UAPI 一次 + 两次定位 + 一次天气里成功的那次');
  });

  test('两条链路都失败：返回空对象', async () => {
    resetAll();
    const fake = fakeFetch([UAPI_DOWN]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(facts, {});
    assert.equal(fake.calls.length, 3, 'UAPI + ip-api + ipwho.is，没有城市就不查天气');
  });

  test('城市查到但天气查不到：只返回省市，不给 weather 键', async () => {
    resetAll();
    const fake = fakeFetch([UAPI_DOWN, () => json(IP_API_OK), () => json({ results: [] })]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(facts, { region: '江西省', city: '南昌市' });
    assert.equal('weather' in facts, false, '没有数据时不该出现 weather 键');
  });

  test('IP 库没给省：结果里不出现 region 键', async () => {
    resetAll();
    const fake = fakeFetch([
      UAPI_DOWN,
      () => json({ status: 'success', city: '南昌市', regionName: '', country: '中国' }),
      () => json({ results: [] }),
    ]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(facts, { city: '南昌市' });
  });
});

describe('currentEnvironment —— 强制刷新', () => {
  test('force：UAPI 也跳过缓存重查，成功后覆盖缓存', async () => {
    resetAll();
    const fake = fakeFetch([() => json(UAPI_OK), () => json({ ...UAPI_OK, city: '九江市' })]);
    let clock = 1_700_000_000_000;
    const now = () => clock;

    const first = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });
    clock += 60_000;
    const cached = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });
    const forced = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP, now, force: true });

    assert.equal(first.city, '南昌市');
    assert.equal(cached.city, '南昌市', '10 分钟内应命中缓存');
    assert.equal(forced.city, '九江市', 'force 必须绕过缓存拿到新结果');
    assert.equal(fake.calls.length, 2, '缓存命中那次不该发请求');
  });
});

describe('currentEnvironment —— 配置的天气城市', () => {
  // 城市读取口是模块级的：每个用例自己设，用例后恢复默认，免得串到别的用例
  afterEach(() => setCityProvider(() => undefined));

  test('配了城市：请求带 city，且不再走 IP 定位', async () => {
    resetAll();
    setCityProvider(() => '扬州');
    const fake = fakeFetch([() => json({ ...UAPI_OK, province: '江苏省', city: '扬州市' })]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(facts.city, '扬州市');
    assert.equal(facts.region, '江苏省');
    assert.ok(decodeURIComponent(fake.calls[0] ?? '').includes('city=扬州'), 'UAPI 请求必须带配置的城市');
    assert.equal(fake.calls.length, 1, 'UAPI 命中时不该再打 ip-api');
  });

  test('配了城市但 UAPI 失败：直接按城市名查，跳过 IP 定位', async () => {
    resetAll();
    setCityProvider(() => '扬州');
    const fake = fakeFetch([
      UAPI_DOWN,
      () => json({ results: [] }),
      () => json({ results: [{ name: '扬州市', latitude: 32.39722, longitude: 119.43583 }] }),
      () => json(CURRENT_OK),
    ]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(facts.city, '扬州市');
    assert.equal(facts.weather?.temperatureC, 13.1);
    assert.equal(
      fake.calls.some((call) => call.includes('ip-api')),
      false,
      '配了城市就不该再问 IP 归属地库',
    );
  });

  test('配了城市但两条链路都查不到：仍返回城市，只是没有天气', async () => {
    resetAll();
    setCityProvider(() => '不存在的地方');
    const fake = fakeFetch([UAPI_DOWN, () => json({ results: [] })]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(facts, { city: '不存在的地方' });
  });

  test('deps.city 优先于注入的读取口', async () => {
    resetAll();
    setCityProvider(() => '扬州');
    const fake = fakeFetch([() => json({ ...UAPI_OK, city: '九江市', province: '江西省' })]);

    const facts = await currentEnvironment({ fetchImpl: fake.impl, sleep: NO_SLEEP, city: '九江' });

    assert.equal(facts.city, '九江市');
    assert.ok(decodeURIComponent(fake.calls[0] ?? '').includes('city=九江'));
  });
});
