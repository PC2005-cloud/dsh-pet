/**
 * UAPI 适配的契约测试：字段换算（风力级 → km/h、图标码 → WMO）、时间归一、缓存与失败回落。
 *
 * fetch 用手写替身，不联网；缓存是模块级的，每个用例先清。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fetchUapiWeather, resetUapiCache } from './uapi.ts';

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

/** 线上实测返回（字段原样照抄，只把相对时间固定下来）。 */
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

/** 固定时刻：2026-11-13 15:00（本地时区）。 */
const NOW_MS = new Date(2026, 10, 13, 15, 0).getTime();

describe('fetchUapiWeather —— 字段换算', () => {
  test('成功：省市、温度、湿度、风级与中文短语都映射进快照', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json(UAPI_OK)]);

    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now: () => NOW_MS });

    assert.equal(hit?.region, '江西省');
    assert.equal(hit?.city, '南昌市');
    assert.equal(hit?.weather.summary, '小雨');
    assert.equal(hit?.weather.temperatureC, 17);
    assert.equal(hit?.weather.apparentC, 17);
    assert.equal(hit?.weather.humidityPercent, 82);
    assert.equal(hit?.weather.city, '南昌市');
  });

  test('风力按蒲福级换算成 km/h：2 级 → 8.5', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json(UAPI_OK)]);
    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now: () => NOW_MS });
    assert.equal(hit?.weather.windKph, 8.5);
  });

  test('英文风力写法也能认：「Level 1」→ 3 km/h', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json({ ...UAPI_OK, wind_power: 'Level 1' })]);
    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now: () => NOW_MS });
    assert.equal(hit?.weather.windKph, 3);
  });

  test('图标码映射成既有 WMO 码：305（小雨）→ 61；未知码回落成 3（阴）', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json(UAPI_OK)]);
    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now: () => NOW_MS });
    assert.equal(hit?.weather.code, 61);

    resetUapiCache();
    const unknown = fakeFetch([() => json({ ...UAPI_OK, weather_icon: '12345' })]);
    const odd = await fetchUapiWeather({ fetchImpl: unknown.impl, sleep: NO_SLEEP, now: () => NOW_MS });
    assert.equal(odd?.weather.code, 3);
  });

  test('相对更新时间按当前时刻倒推：「7 分钟前发布」→ 14:53', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json(UAPI_OK)]);
    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now: () => NOW_MS });
    assert.equal(hit?.weather.observedAt, '14:53');
  });

  test('绝对更新时间只取时分：「2026-11-13 15:00」→ 15:00', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json({ ...UAPI_OK, report_time: '2026-11-13 15:00' })]);
    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now: () => NOW_MS });
    assert.equal(hit?.weather.observedAt, '15:00');
  });

  test('体感缺失时按气温兜底', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json({ ...UAPI_OK, feels_like: undefined })]);
    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now: () => NOW_MS });
    assert.equal(hit?.weather.apparentC, 17);
  });
});

describe('fetchUapiWeather —— 失败与缓存', () => {
  test('上游 500：返回 null（调用方回落），不抛', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => new Response('', { status: 500 })]);
    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP });
    assert.equal(hit, null);
  });

  test('缺关键字段（没有天气文本）：整份判失败', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json({ ...UAPI_OK, weather: undefined })]);
    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP });
    assert.equal(hit, null);
  });

  test('10 分钟内命中缓存：不再发请求', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json(UAPI_OK)]);
    let clock = NOW_MS;
    const now = () => clock;

    await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });
    clock += 9 * 60 * 1000;
    await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });

    assert.equal(fake.calls.length, 1, '缓存命中的第二次不该打上游');
  });

  test('超过 10 分钟：重新查一次', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json(UAPI_OK)]);
    let clock = NOW_MS;
    const now = () => clock;

    await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });
    clock += 11 * 60 * 1000;
    await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });

    assert.equal(fake.calls.length, 2, '缓存过期后应重新查询');
  });

  test('force：跳过缓存重查', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json(UAPI_OK)]);
    const now = () => NOW_MS;

    await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });
    await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, now, force: true });

    assert.equal(fake.calls.length, 2);
  });
});

describe('fetchUapiWeather —— 空数值字段', () => {
  for (const key of ['temperature', 'humidity'] as const) {
    for (const blank of ['', '  ']) {
      test(`${key} 返回空字符串 ${JSON.stringify(blank)}：按缺失处理`, async () => {
        resetUapiCache();
        const fake = fakeFetch([() => json({ ...UAPI_OK, [key]: blank })]);
        assert.equal(await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP }), null);
      });
    }
  }
  test('真实的零温度与零湿度仍保留', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json({ ...UAPI_OK, temperature: '0', humidity: 0 })]);
    const hit = await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP });
    assert.equal(hit?.weather.temperatureC, 0);
    assert.equal(hit?.weather.humidityPercent, 0);
  });
  test('空体感温度回落到实际气温', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json({ ...UAPI_OK, feels_like: ' ' })]);
    assert.equal((await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP }))?.weather.apparentC, 17);
  });
});

describe('fetchUapiWeather —— 配置的城市', () => {
  test('带 city：请求 URL 拼上 city 参数（不再由上游按 IP 定位）', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json(UAPI_OK)]);

    await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, city: '扬州' });

    assert.ok(decodeURIComponent(fake.calls[0] ?? '').includes('city=扬州'), '请求必须带 city：' + fake.calls[0]);
  });

  test('city 只有空白：等同于没配，URL 里不出现 city 参数', async () => {
    resetUapiCache();
    const fake = fakeFetch([() => json(UAPI_OK)]);

    await fetchUapiWeather({ fetchImpl: fake.impl, sleep: NO_SLEEP, city: '   ' });

    assert.equal(fake.calls[0]?.includes('city='), false, '空白 city 不该拼进 URL');
  });
});
