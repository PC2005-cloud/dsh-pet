/**
 * 出口 IP → 城市的契约测试：首选 ip-api、失败回落 ipwho.is、两家都没给城市就返回 null；
 * 缓存 6 小时内不重复打端点，并发调用共享同一次请求。
 *
 * fetch 用手写替身，不联网；时钟由 now 注入，缓存判定可精确控制。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { locateCity, resetCityCache } from './ip-city.ts';

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

describe('locateCity —— 端点顺序', () => {
  test('ip-api 成功：直接返回它的中文城市名', async () => {
    resetCityCache();
    const fake = fakeFetch([() => json({ status: 'success', city: '南昌市', regionName: '江西省', country: '中国' })]);

    const location = await locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(location, { city: '南昌市', region: '江西省', country: '中国' });
    assert.equal(fake.calls.length, 1, '首选命中时不该再问 ipwho.is');
    assert.ok(fake.calls[0].startsWith('http://ip-api.com/json/'), '首选端点应是 ip-api');
  });

  test('ip-api 返回 500：回落到 ipwho.is', async () => {
    resetCityCache();
    const fake = fakeFetch([
      () => new Response('', { status: 500 }),
      () => json({ success: true, city: 'Nanchang', region: 'Jiangxi', country: 'China' }),
    ]);

    const location = await locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.deepEqual(location, { city: 'Nanchang', region: 'Jiangxi', country: 'China' });
    assert.equal(fake.calls.length, 2, '首选失败后应问兜底端点');
    assert.ok(fake.calls[1].startsWith('https://ipwho.is/'), '兜底端点应是 ipwho.is');
  });

  test('ip-api 没给城市字段：也算没查到，继续问兜底', async () => {
    resetCityCache();
    const fake = fakeFetch([
      () => json({ status: 'success', country: '中国' }),
      () => json({ success: true, city: 'Nanchang', region: 'Jiangxi', country: 'China' }),
    ]);

    const location = await locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(location?.city, 'Nanchang');
  });

  test('两家都失败：返回 null，不编一个城市', async () => {
    resetCityCache();
    const fake = fakeFetch([() => new Response('', { status: 500 })]);

    const location = await locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP });

    assert.equal(location, null);
  });
});

describe('locateCity —— 缓存与并发', () => {
  test('6 小时内第二次调用不再发请求', async () => {
    resetCityCache();
    const fake = fakeFetch([() => json({ status: 'success', city: '南昌市', regionName: '江西省', country: '中国' })]);
    const now = () => 1_700_000_000_000;

    await locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });
    const second = await locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });

    assert.equal(second?.city, '南昌市');
    assert.equal(fake.calls.length, 1, '缓存命中的第二次调用不该打端点');
  });

  test('超过 6 小时：重新查一次', async () => {
    resetCityCache();
    const fake = fakeFetch([() => json({ status: 'success', city: '南昌市', regionName: '江西省', country: '中国' })]);
    let clock = 1_700_000_000_000;
    const now = () => clock;

    await locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });
    clock += 7 * 60 * 60 * 1000;
    await locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP, now });

    assert.equal(fake.calls.length, 2, '缓存过期后应重新查询');
  });

  test('并发调用共享同一次请求，只打一次端点', async () => {
    resetCityCache();
    const fake = fakeFetch([() => json({ status: 'success', city: '南昌市', regionName: '江西省', country: '中国' })]);

    const [first, second] = await Promise.all([
      locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP }),
      locateCity({ fetchImpl: fake.impl, sleep: NO_SLEEP }),
    ]);

    assert.equal(first?.city, '南昌市');
    assert.equal(second?.city, '南昌市');
    assert.equal(fake.calls.length, 1, '并发调用应共享进行中的请求');
  });
});
