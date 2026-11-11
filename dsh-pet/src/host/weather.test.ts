/**
 * 城市天气查询的契约测试：地名解析 → 当前天气两跳、字段非法不编数值、查不到返回 null；
 * 天气缓存 10 分钟、坐标缓存 7 天，两级各自生效。
 *
 * fetch 用手写替身，不联网；时钟由 now 注入，缓存过期可精确控制。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { queryWeather, resetWeatherCache } from './weather.ts';

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

/** 深圳的地名搜索结果（字段照抄 Open-Meteo 真实响应）。 */
const SHENZHEN = {
  results: [{ id: 1795565, name: '深圳', latitude: 22.54554, longitude: 114.0683, country: '中国' }],
};

/** 深圳的当前天气（字段照抄 Open-Meteo 真实响应）。 */
const CURRENT = {
  current: {
    time: '2026-11-11T20:30',
    interval: 900,
    temperature_2m: 26.1,
    apparent_temperature: 27,
    relative_humidity_2m: 78,
    wind_speed_10m: 11.2,
    weather_code: 3,
  },
};

/** 不吃真实等待的重试间隔。 */
const NO_SLEEP = async (): Promise<void> => {};

describe('queryWeather —— 查询路径', () => {
  test('城市解析成功：返回温度、体感、湿度、风速与中文天气', async () => {
    resetWeatherCache();
    const fake = fakeFetch([() => json(SHENZHEN), () => json(CURRENT)]);

    const snapshot = await queryWeather('深圳', { fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(snapshot, {
      city: '深圳',
      temperatureC: 26.1,
      apparentC: 27,
      humidityPercent: 78,
      windKph: 11.2,
      code: 3,
      summary: '阴',
      observedAt: '2026-11-11T20:30',
    });
    assert.ok(fake.calls[0].includes('geocoding-api.open-meteo.com'), '第一次应先查地名');
    assert.ok(fake.calls[1].startsWith('https://api.open-meteo.com/v1/forecast'), '第二次再查天气');
  });

  test('城市名带空白：先 trim 再查', async () => {
    resetWeatherCache();
    const fake = fakeFetch([() => json(SHENZHEN), () => json(CURRENT)]);

    const snapshot = await queryWeather('  深圳  ', { fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(snapshot?.city, '深圳');
  });

  test('空城市名：直接返回 null，不发请求', async () => {
    resetWeatherCache();
    const fake = fakeFetch([() => json(SHENZHEN)]);

    const snapshot = await queryWeather('   ', { fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(snapshot, null);
    assert.equal(fake.calls.length, 0, '没给城市就不该打端点');
  });

  test('地名搜索没有结果：返回 null', async () => {
    resetWeatherCache();
    const fake = fakeFetch([() => json({ results: [] })]);

    const snapshot = await queryWeather('不存在的城市', { fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(snapshot, null);
    assert.equal(fake.calls.length, 2, '带“市”字查不到会去掉后缀再试一次，但不该去查天气');
  });

  test('带“市”字查不到：去掉后缀重试，命中后照样取到天气', async () => {
    resetWeatherCache();
    const fake = fakeFetch([() => json({ results: [] }), () => json(SHENZHEN), () => json(CURRENT)]);

    const snapshot = await queryWeather('深圳市', { fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(snapshot?.city, '深圳', '应拿到去掉后缀后的命中结果');
    assert.equal(snapshot?.summary, '阴');
    assert.ok(decodeURIComponent(fake.calls[1]).includes('name=深圳'), '第二次搜索应是不带“市”的名字');
  });

  test('天气字段非法：返回 null，不把非法值当 0', async () => {
    resetWeatherCache();
    const fake = fakeFetch([
      () => json(SHENZHEN),
      () => json({ current: { ...CURRENT.current, temperature_2m: 'abc' } }),
    ]);

    const snapshot = await queryWeather('深圳', { fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(snapshot, null);
  });

  test('上游抓取失败：返回 null', async () => {
    resetWeatherCache();
    const fake = fakeFetch([() => new Response('', { status: 500 })]);

    const snapshot = await queryWeather('深圳', { fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(snapshot, null);
  });
});

describe('queryWeather —— 缓存', () => {
  test('1 小时内重复查同一城市：只打地名与天气各一次', async () => {
    resetWeatherCache();
    const fake = fakeFetch([() => json(SHENZHEN), () => json(CURRENT)]);
    let clock = 1_700_000_000_000;
    const now = () => clock;

    await queryWeather('深圳', { fetchImpl: fake.impl, sleep: NO_SLEEP, now });
    clock += 60_000;
    await queryWeather('深圳', { fetchImpl: fake.impl, sleep: NO_SLEEP, now });

    assert.equal(fake.calls.length, 2, '天气缓存命中时不该再打端点');
  });

  test('天气过期但坐标未过期：只重查天气', async () => {
    resetWeatherCache();
    const fake = fakeFetch([() => json(SHENZHEN), () => json(CURRENT)]);
    let clock = 1_700_000_000_000;
    const now = () => clock;

    await queryWeather('深圳', { fetchImpl: fake.impl, sleep: NO_SLEEP, now });
    clock += 61 * 60 * 1000;
    await queryWeather('深圳', { fetchImpl: fake.impl, sleep: NO_SLEEP, now });

    assert.equal(fake.calls.length, 3, '坐标仍有效，只该重查天气');
    assert.ok(fake.calls[2].startsWith('https://api.open-meteo.com/v1/forecast'), '第三次应是天气请求');
  });
});
