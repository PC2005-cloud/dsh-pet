/**
 * 环境气泡的视图模型：把 `sections.env` 的读数折成两端都能直接渲染的行。
 *
 * 只做格式化与取舍（标题、图标、大字温度、三行键值、脚注），不碰 DOM、不读时钟；
 * 网页端映射成 React 节点、桌面端映射成 DOM 节点，两份渲染共用这里，文案不会漂。
 * @module dsh-pet/src/shared/env-view
 */
import { envIconShapes, type EnvIconShape } from './env-icon.ts';
import type { EnvState } from './state.ts';

/** 一行键值：左标签右数值。 */
export interface EnvBubbleRow {
  /** 左侧标签（体感 / 湿度 / 风速）。 */
  readonly label: string;
  /** 右侧数值，已带单位。 */
  readonly value: string;
}

/** 环境气泡要画的东西；查不到时只有 `emptyText`。 */
export interface EnvBubbleView {
  /** 标题：省 + 市；都没有时是「天气」。 */
  readonly title: string;
  /** 天气图标几何；查不到时缺省。 */
  readonly icon?: readonly EnvIconShape[];
  /** 大字气温（带 °C）；查不到时缺省。 */
  readonly temperature?: string;
  /** 中文天气短语（阴 / 晴 / 雷阵雨）；查不到时缺省。 */
  readonly summary?: string;
  /** 键值行；查不到时为空数组。 */
  readonly rows: readonly EnvBubbleRow[];
  /** 脚注：观测时刻；缺省表示上游没给时间。 */
  readonly footer?: string;
  /** 查不到时的一句话；有天气数据时缺省。 */
  readonly emptyText?: string;
}

/** 数值转口语：整数不带小数点，非整数留一位（与时间行同一口径）。 */
function numText(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 观测时刻取时分：`2026-11-12T08:45` → `08:45`；形状不对时 undefined。 */
function observedTimeOf(raw: string): string | undefined {
  if (!raw.includes('T')) return undefined;
  const time = raw.split('T')[1] ?? '';
  return time.slice(0, 5) === '' ? undefined : time.slice(0, 5);
}

/**
 * 折出环境气泡的视图。
 *
 * @param state - `sections.env` 的读数。
 * @returns 标题、图标、温度、短语、三行键值与脚注；没有天气时退化成一句「暂时查不到天气」。
 */
export function envBubbleView(state: EnvState): EnvBubbleView {
  // 省市分开给，这里按「省 + 市」拼标题；两段都没有时退回中性的「天气」
  const place = [state.region ?? '', state.city ?? ''].filter((part) => part !== '').join('');
  const title = place === '' ? '天气' : place;
  const weather = state.weather;
  if (weather === undefined) return { title, rows: [], emptyText: '暂时查不到天气' };
  const observed = observedTimeOf(weather.observedAt);
  return {
    title,
    icon: envIconShapes(weather.code),
    temperature: numText(weather.temperatureC) + '°C',
    summary: weather.summary,
    rows: [
      { label: '体感', value: numText(weather.apparentC) + '°C' },
      { label: '湿度', value: numText(weather.humidityPercent) + '%' },
      { label: '风速', value: numText(weather.windKph) + ' km/h' },
    ],
    ...(observed === undefined ? {} : { footer: '观测 ' + observed }),
  };
}
