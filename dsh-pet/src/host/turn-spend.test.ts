import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnSpendStore, isDeepseekPeak, type SpendEvent } from './turn-spend.ts';
import { createPricingManager, parsePricingCatalogHtml, calculateTokenCost } from './pricing-catalog.ts';

const monday = (clock: string) => Date.parse(`2026-09-28T${clock}:00+08:00`);
const session = {
  id: 'A',
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
};
const usage = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 4000 };

test('高峰边界、午休、周末不依赖系统时区', () => {
  for (const clock of ['09:00', '11:59', '14:00', '17:59']) assert.equal(isDeepseekPeak(monday(clock)), true);
  for (const clock of ['08:59', '12:00', '13:59', '18:00']) assert.equal(isDeepseekPeak(monday(clock)), false);
  assert.equal(isDeepseekPeak(Date.parse('2026-09-27T10:00:00+08:00')), false);
  assert.equal(isDeepseekPeak(Date.parse('2026-10-01T10:00:00+08:00')), false);
  assert.equal(isDeepseekPeak(Date.parse('2026-10-08T10:00:00+08:00')), true);
});

test('累计本轮多次调用，按请求开始时间分档，缓存互不重复，重复事件去重', () => {
  const store = createTurnSpendStore(createPricingManager());
  const emit = (type: string, data: SpendEvent['data'], time = monday('12:01')) =>
    store.consume(session, { type, data, time });
  emit('turn/start', { turn: 1 });
  emit('step/start', { turn: 1, step: 1 }, monday('11:59'));
  emit('assistant/message', { turn: 1, step: 1, usage });
  emit('assistant/message', { turn: 1, step: 1, usage });
  emit('step/start', { turn: 1, step: 2 });
  emit('assistant/message', { turn: 1, step: 2, usage });
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.ok(Math.abs(store.get('A')!.amount - 0.03918) < 1e-10);
  assert.equal(store.get('B'), null);
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(store.get('A')!.count, 1);
});

test('并发会话分别结算，模型切换按实际路由计算', () => {
  const store = createTurnSpendStore(createPricingManager());
  for (const id of ['A', 'B']) store.consume({ ...session, id }, { type: 'turn/start', data: { turn: 1 } });
  store.consume(session, {
    type: 'request/context',
    data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  });
  for (const id of ['A', 'B']) {
    store.consume({ ...session, id }, { type: 'assistant/message', time: monday('12:00'), data: { step: 1, usage } });
    store.consume({ ...session, id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  }
  assert.ok(Math.abs(store.get('A')!.amount - 0.04995) < 1e-10);
  assert.ok(Math.abs(store.get('B')!.amount - 0.01306) < 1e-10);
});

test('未知模型、第三方路由、缺失/异常 usage、失败回合不伪造完整费用', () => {
  for (const bad of ['unknown', 'provider', 'missing', 'negative', 'aborted', 'stale']) {
    const store = createTurnSpendStore(createPricingManager());
    store.consume(session, { type: 'turn/start', data: { turn: 2 } });
    if (bad === 'unknown' || bad === 'provider')
      store.consume(session, {
        type: 'request/context',
        data: {
          provider: bad === 'provider' ? 'openrouter' : 'deepseek-official',
          model: bad === 'unknown' ? 'unknown' : 'deepseek-flash',
        },
      });
    store.consume(session, {
      type: 'assistant/message',
      data: {
        turn: bad === 'stale' ? 1 : 2,
        step: 1,
        usage: bad === 'missing' ? undefined : { ...usage, inputTokens: bad === 'negative' ? -1 : 1000 },
      },
    });
    store.consume(session, {
      type: 'turn/end',
      data: { turn: 2, reason: { kind: bad === 'aborted' ? 'aborted' : 'completed' } },
    });
    assert.equal(store.get('A'), null, bad);
  }
});

test('官方表头脚注不污染模型 ID，解析所有模型、峰谷价，未知模型无回落', () => {
  const html =
    '<table><tr><th>模型</th><th>deepseek-flash<sup>(1)</sup></th><th>deepseek-v4-pro<sup>(2)</sup></th></tr>' +
    [
      '缓存命中|空闲时段|0.02元|0.15元',
      '|高峰时段|0.04元|0.30元',
      '缓存未命中|空闲时段|1元|4.5元',
      '|高峰时段|2元|9元',
      '百万tokens输出|空闲时段|4元|13.5元',
      '|高峰时段|8元|27元',
    ]
      .map(
        (row) =>
          '<tr>' +
          row
            .split('|')
            .map((c) => '<td>' + c + '</td>')
            .join('') +
          '</tr>',
      )
      .join('') +
    '</table>';
  const catalog = parsePricingCatalogHtml(html);
  assert.equal(catalog['deepseek-flash'].input, 1);
  assert.equal(catalog['deepseek-v4-pro'].output, 13.5);
  assert.equal(catalog['deepseek-flash'].peakMultiplier, 2);
  assert.deepEqual(parsePricingCatalogHtml('<html>error</html>'), {});
  const manager = createPricingManager();
  assert.equal(manager.current('unknown'), undefined);
  assert.deepEqual(manager.current('deepseek-v4-flash'), manager.current('deepseek-flash'));
  assert.equal(calculateTokenCost({ input: 1e6, output: 0, cacheRead: 0 }, catalog['deepseek-flash'], false), 1);
});

test('同一回合 CNY/USD 分别用官方单价，切换后包含全轮缓存/输出和多个请求', () => {
  const store = createTurnSpendStore(createPricingManager());
  store.consume(session, { type: 'turn/start', data: { turn: 1 } });
  for (const [step, time] of [
    [1, monday('10:00')],
    [2, monday('12:00')],
  ]) {
    store.consume(session, { type: 'step/start', time, data: { step } });
    store.consume(session, { type: 'assistant/message', data: { step, usage } });
  }
  store.consume(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  const cny = store.get('A', 'CNY')!;
  const usd = store.get('A', 'USD')!;
  assert.ok(Math.abs(cny.amount - 0.03918) < 1e-10);
  assert.ok(Math.abs(usd.amount - 0.005877) < 1e-10);
  assert.equal(usd.currency, 'USD');
  assert.equal(cny.currency, 'CNY');
  assert.equal(cny.count, usd.count);
  assert.equal(store.get('A', 'CNY')!.amount, cny.amount);
  const manager = createPricingManager();
  assert.equal(manager.current('deepseek-v4-pro', 'USD')!.input, 0.66);
  assert.equal(manager.current('deepseek-v4-pro', 'USD')!.output, 1.98);
  assert.equal(manager.current('unknown', 'USD'), undefined);
});

test('英文美元价正确解析，币种不符时拒绝解析，不套用另一币种价格', () => {
  const html =
    '<table><tr><th>MODEL</th><th>deepseek-flash<sup>(1)</sup></th><th>deepseek-v4-pro</th></tr>' +
    [
      '1M INPUT TOKENS (CACHE HIT)|OFF-PEAK|$0.003|$0.022',
      '|PEAK|$0.006|$0.044',
      '1M INPUT TOKENS (CACHE MISS)|OFF-PEAK|$0.15|$0.66',
      '|PEAK|$0.3|$1.32',
      '1M OUTPUT TOKENS|OFF-PEAK|$0.6|$1.98',
      '|PEAK|$1.2|$3.96',
    ]
      .map(
        (row) =>
          '<tr>' +
          row
            .split('|')
            .map((c) => '<td>' + c + '</td>')
            .join('') +
          '</tr>',
      )
      .join('') +
    '</table>';
  const usd = parsePricingCatalogHtml(html, 'USD');
  assert.equal(usd['deepseek-flash'].cacheRead, 0.003);
  assert.equal(usd['deepseek-v4-pro'].output, 1.98);
  assert.equal(usd['deepseek-v4-pro'].currency, 'USD');
  assert.equal(usd['deepseek-flash'].peakMultiplier, 2);
  assert.deepEqual(parsePricingCatalogHtml(html, 'CNY'), {});
  const store = createTurnSpendStore({
    current: (model) => createPricingManager().current(model, 'CNY'),
    source: () => 'default',
  });
  store.consume(session, { type: 'turn/start' });
  store.consume(session, { type: 'assistant/message', data: { usage } });
  store.consume(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  assert.equal(store.get('A', 'USD'), null);
  assert.ok(store.get('A', 'CNY'));
});
