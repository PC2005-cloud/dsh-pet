import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStartupData } from './startup-data.ts';
import { createHolidayManager, peakAt, validHolidayCalendar } from './holidays.ts';
import { createPricingManager } from './pricing-catalog.ts';

test('每次启动必刷新，重启离线保留上次成功值及时间，失败不污染缓存', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cacheFile = join(dir, 'cache.json');
  let calls = 0;
  let fail = false;
  const options = {
    cacheFile,
    keys: () => ['CNY', 'USD'],
    fallback: () => 1,
    valid: (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v),
    fetch: async () => {
      calls++;
      if (fail) throw new Error('offline');
      return calls + 10;
    },
  };
  const first = createStartupData(options);
  await first.start();
  assert.equal(calls, 2);
  assert.equal(first.current('CNY'), 11);
  assert.equal(first.status('CNY').source, 'online');
  const at = first.status('CNY').updatedAt;
  first.dispose();
  fail = true;
  const second = createStartupData(options);
  assert.equal(second.status('CNY').source, 'cache');
  await second.start();
  assert.equal(calls, 4, '有缓存也必须联网');
  assert.equal(second.current('CNY'), 11);
  assert.equal(second.status('CNY').updatedAt, at);
  assert.equal(second.status('CNY').error, 'offline');
  second.dispose();
  const persisted = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.equal(persisted.entries.CNY.value, 11);
  writeFileSync(cacheFile, '{broken');
  const third = createStartupData(options);
  assert.equal(third.current('CNY'), 1);
  await third.start();
  assert.equal(calls, 6);
  third.dispose();
});

test('并发刷新单飞，卸载中止后不接纳迟到响应', async () => {
  let complete!: (value: number) => void;
  let calls = 0;
  const store = createStartupData({
    keys: () => ['year'],
    fallback: () => 1,
    valid: (v: unknown): v is number => typeof v === 'number',
    fetch: () => {
      calls++;
      return new Promise<number>((resolve) => {
        complete = resolve;
      });
    },
  });
  const first = store.start();
  const second = store.refresh();
  assert.equal(first, second);
  store.dispose();
  complete(42);
  await first;
  assert.equal(calls, 1);
  assert.equal(store.current('year'), 1);
});

const calendar = (year: number, dates: Array<[string, boolean]>) => ({
  year,
  papers: ['https://www.gov.cn/example.htm'],
  days: dates.map(([date, isOffDay]) => ({ date, isOffDay, name: '测试节假日' })),
});

test('启动下载当年/次年并按北京时间判定，年度切换、调休周末、失败缓存均正确', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-holiday-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const priorFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  let now = Date.parse('2026-12-31T15:00:00Z');
  const urls: string[] = [];
  let fail = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.cache, 'no-store');
    urls.push(String(url));
    if (fail) throw new Error('offline');
    const year = Number(String(url).match(/(\d{4})\.json/)![1]);
    const data =
      year === 2026
        ? calendar(year, [
            ['2026-10-01', true],
            ['2026-10-10', false],
          ])
        : calendar(year, [
            ['2027-01-01', true],
            ['2026-12-31', true],
          ]);
    return { ok: true, text: async () => JSON.stringify(data) } as Response;
  };
  const file = join(dir, 'holidays.json');
  const manager = createHolidayManager(file, () => now);
  await manager.start();
  assert.equal(urls.length, 2);
  assert.equal(manager.isHoliday(Date.parse('2026-12-31T10:00:00+08:00')), true, '次年公告可修订本年日期');
  assert.equal(peakAt(Date.parse('2026-10-10T10:00:00+08:00'), manager.isHoliday), false, '调休周末仍为谷价');
  now = Date.parse('2026-12-31T16:01:00Z');
  assert.equal(manager.status().date, '2027-01-01');
  assert.equal(peakAt(Date.parse('2027-01-01T10:00:00+08:00'), manager.isHoliday), false);
  manager.dispose();
  fail = true;
  const restarted = createHolidayManager(file, () => now);
  await restarted.start();
  assert.ok(urls[urls.length - 1]?.endsWith('2028.json'));
  assert.equal(restarted.status().years[2027].source, 'cache');
  assert.equal(restarted.status().isHoliday, true);
  assert.equal(peakAt(Date.parse('2030-01-01T10:00:00+08:00'), restarted.isHoliday), undefined);
  restarted.dispose();
});

test('拒绝空年度、错误年份、无公告或无效日期，不把抓取失败认作无节假日', () => {
  assert.equal(validHolidayCalendar(calendar(2026, [['2026-10-01', true]]), '2026'), true);
  for (const value of [
    calendar(2025, [['2025-10-01', true]]),
    calendar(2026, []),
    calendar(2026, [['2026-02-30', true]]),
    { ...calendar(2026, [['2026-10-01', true]]), papers: [] },
  ]) {
    assert.equal(validHolidayCalendar(value, '2026'), false);
  }
});

test('价格启动请求两个官网，单币种失败保留兜底并记录错误', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(init?.cache, 'no-store');
    if (String(url).includes('zh-cn')) throw new Error('CNY offline');
    const html =
      '<table><tr><td>MODEL</td><td>deepseek-flash</td></tr>' +
      ['CACHE HIT|OFF-PEAK|$0.005', 'CACHE MISS|OFF-PEAK|$0.2', '1M OUTPUT TOKENS|OFF-PEAK|$0.7', '|PEAK|$1.4']
        .map(
          (r) =>
            '<tr>' +
            r
              .split('|')
              .map((c) => '<td>' + c + '</td>')
              .join('') +
            '</tr>',
        )
        .join('') +
      '</table>';
    return { ok: true, text: async () => html } as Response;
  };
  const manager = createPricingManager();
  await manager.start();
  assert.equal(urls.length, 2);
  assert.equal(manager.current('deepseek-flash', 'USD')!.output, 0.7);
  assert.equal(manager.source('deepseek-flash', 'USD'), 'official');
  assert.equal(manager.source('deepseek-flash', 'CNY'), 'default');
  assert.match(manager.status().CNY.error!, /offline/);
  manager.dispose();
});
