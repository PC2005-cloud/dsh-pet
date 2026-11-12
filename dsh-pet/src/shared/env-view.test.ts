/**
 * 环境气泡视图的契约测试：标题、大字气温、三行键值与脚注都只在一处拼（两端共用）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { envBubbleView } from './env-view.ts';
import type { EnvState } from './state.ts';

/** 一份带天气的读数（字段与 /environment 写进 sections.env 的同形）。 */
const WITH_WEATHER: EnvState = {
  region: '江西省',
  city: '南昌市',
  petId: 'main',
  ts: 1,
  weather: {
    city: '南昌',
    summary: '阴',
    temperatureC: 14.5,
    apparentC: 14.5,
    humidityPercent: 76,
    windKph: 0.8,
    code: 3,
    observedAt: '2026-11-12T08:45',
  },
};

describe('envBubbleView —— 有天气', () => {
  test('标题是省 + 市，主区给图标、大字气温与短语', () => {
    const view = envBubbleView(WITH_WEATHER);
    assert.equal(view.title, '江西省南昌市');
    assert.ok((view.icon?.length ?? 0) > 0, '应带上图标几何');
    assert.equal(view.temperature, '14.5°C');
    assert.equal(view.summary, '阴');
    assert.equal(view.emptyText, undefined);
  });

  test('三行键值按体感 / 湿度 / 风速的顺序，数值都带单位', () => {
    assert.deepEqual(envBubbleView(WITH_WEATHER).rows, [
      { label: '体感', value: '14.5°C' },
      { label: '湿度', value: '76%' },
      { label: '风速', value: '0.8 km/h' },
    ]);
  });

  test('脚注取观测时刻的时分', () => {
    assert.equal(envBubbleView(WITH_WEATHER).footer, '观测 08:45');
  });

  test('整数不带小数点', () => {
    const view = envBubbleView({
      ...WITH_WEATHER,
      weather: { ...WITH_WEATHER.weather!, temperatureC: 20, apparentC: 21, humidityPercent: 40, windKph: 3 },
    });
    assert.equal(view.temperature, '20°C');
    assert.deepEqual(view.rows, [
      { label: '体感', value: '21°C' },
      { label: '湿度', value: '40%' },
      { label: '风速', value: '3 km/h' },
    ]);
  });
});

describe('envBubbleView —— 查不到与缺字段', () => {
  test('没有天气：只给一句话，不画空数值', () => {
    const view = envBubbleView({ region: '江西省', city: '南昌市', petId: 'main', ts: 1 });
    assert.equal(view.title, '江西省南昌市');
    assert.equal(view.emptyText, '暂时查不到天气');
    assert.deepEqual(view.rows, []);
    assert.equal(view.temperature, undefined);
    assert.equal(view.icon, undefined);
  });

  test('省市都没有：标题退回「天气」', () => {
    assert.equal(envBubbleView({ petId: 'main', ts: 1 }).title, '天气');
  });

  test('观测时刻形状不对：不给脚注', () => {
    const view = envBubbleView({
      ...WITH_WEATHER,
      weather: { ...WITH_WEATHER.weather!, observedAt: '2026-11-12' },
    });
    assert.equal(view.footer, undefined);
  });
});
