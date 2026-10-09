import { createStartupData, fetchFresh, type UpdateStatus } from './startup-data';
/**
 * DeepSeek 官方定价目录（host 半侧）。
 *
 * 分别抓取官方中文 CNY / 英文 USD 价格，每页一次解析全部模型，不做汇率换算。
 * 抓取失败时只对内置已知模型使用明确的默认价；未知模型返回 undefined，
 * 调用方据此跳过结算，绝不静默套用另一模型的价格。
 */

export type SpendCurrency = 'CNY' | 'USD';
export const SPEND_CURRENCIES: SpendCurrency[] = ['CNY', 'USD'];
const PRICING_DOC_URL = {
  CNY: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  USD: 'https://api-docs.deepseek.com/quick_start/pricing/',
};

/** 一个模型的一档价格（指定币种 / 百万 tokens） */
export interface Pricing {
  /** 输入（缓存未命中；缓存写入也按此档） */
  input: number;
  /** 输入（缓存命中） */
  cacheRead: number;
  /** 输出 */
  output: number;
  /** 高峰相对空闲的倍率 */
  peakMultiplier: number;
  currency: SpendCurrency;
}

export type PricingCatalog = Record<string, Pricing>;

/** 官方中文价格快照（2026-09-28），单位 CNY / 百万 tokens，空闲价。 */
export const DEFAULT_PRICING_BY_MODEL: PricingCatalog = {
  'deepseek-flash': { input: 1, cacheRead: 0.02, output: 4, peakMultiplier: 2, currency: 'CNY' },
  'deepseek-v4-flash': { input: 1, cacheRead: 0.02, output: 4, peakMultiplier: 2, currency: 'CNY' },
  'deepseek-v4-pro': { input: 4.5, cacheRead: 0.15, output: 13.5, peakMultiplier: 2, currency: 'CNY' },
  'deepseek-v4-flash-vision-exp': {
    input: 1,
    cacheRead: 0.02,
    output: 4,
    peakMultiplier: 2,
    currency: 'CNY',
  },
};

export const DEFAULT_PRICING: Pricing = DEFAULT_PRICING_BY_MODEL['deepseek-v4-flash'];

/** 官方英文美元价快照（2026-09-28）：直接按美元定价，绝不从人民币折算。 */
const USD_FLASH: Pricing = { input: 0.15, cacheRead: 0.003, output: 0.6, peakMultiplier: 2, currency: 'USD' };
export const DEFAULT_USD_PRICING_BY_MODEL: PricingCatalog = {
  'deepseek-flash': USD_FLASH,
  'deepseek-v4-flash': USD_FLASH,
  'deepseek-v4-flash-vision-exp': USD_FLASH,
  'deepseek-v4-pro': { input: 0.66, cacheRead: 0.022, output: 1.98, peakMultiplier: 2, currency: 'USD' },
};
const defaults = (currency: SpendCurrency): PricingCatalog =>
  currency === 'USD' ? DEFAULT_USD_PRICING_BY_MODEL : DEFAULT_PRICING_BY_MODEL;
const isModelHeader = (row: string[]) => row[0] === '模型' || row[0]?.toUpperCase() === 'MODEL';

const normalizeModelId = (modelId: string): string => modelId.trim().toLowerCase();
const canonicalModel = (modelId: string): string => {
  const key = normalizeModelId(modelId);
  return key === 'deepseek-v4-flash' || key === 'deepseek-v4-flash-vision-exp' ? 'deepseek-flash' : key;
};

function plainText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&yen;|&#165;/gi, '¥')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function cellText(row: string): string[] {
  return [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => plainText(m[1])).filter(Boolean);
}

function toNum(value: string): number {
  const normalized = value.replace(/[¥$,\s元]/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : Number.NaN;
}

/** 找到真正包含 DeepSeek 模型价格的表格 */
function pricingRows(html: string): string[][] {
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  for (const table of tables) {
    const rows = [...table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)]
      .map((m) => cellText(m[0]))
      .filter((row) => row.length > 0);
    const header = rows.find(isModelHeader);
    if (header && header.slice(1).some((cell) => normalizeModelId(cell).startsWith('deepseek-'))) return rows;
  }
  return [];
}

/** 从官方 HTML 一次解析全部模型价格 */
export function parsePricingCatalogHtml(html: string, currency: SpendCurrency = 'CNY'): PricingCatalog {
  const rows = pricingRows(html);
  const header = rows.find(isModelHeader);
  if (!header) return {};

  // 官网表头带脚注 <sup>(1)</sup>，不能让脚注成为模型 ID 的一部分。
  const models = header.slice(1).map((cell) => cell.toLowerCase().match(/deepseek-[a-z0-9-]+/)?.[0] ?? '');
  const prices = models.map(() => ({
    cacheHit: {} as Partial<Record<'offPeak' | 'peak', number>>,
    cacheMiss: {} as Partial<Record<'offPeak' | 'peak', number>>,
    output: {} as Partial<Record<'offPeak' | 'peak', number>>,
  }));
  let metric: 'cacheHit' | 'cacheMiss' | 'output' | null = null;

  for (const row of rows) {
    const joined = row.join(' ').toUpperCase();
    if (joined.includes('缓存未命中') || joined.includes('CACHE MISS')) metric = 'cacheMiss';
    else if (joined.includes('缓存命中') || joined.includes('CACHE HIT')) metric = 'cacheHit';
    else if (/百万\s*TOKENS\s*输出|1M\s+OUTPUT\s+TOKENS/.test(joined)) metric = 'output';

    const tagIndex = row.findIndex((cell) => /空闲时段|高峰时段|^(?:OFF-)?PEAK$/i.test(cell));
    if (!metric || tagIndex < 0) continue;
    const tier = row[tagIndex].includes('高峰') || row[tagIndex].toUpperCase() === 'PEAK' ? 'peak' : 'offPeak';
    // 币种标记与目标不符时拒绝整页，避免把美元数字误标为人民币（或反之）。
    const cells = row.slice(tagIndex + 1);
    if (cells.some((cell) => (currency === 'CNY' ? cell.includes('$') : /[¥元]/.test(cell)))) return {};
    const values = row.slice(tagIndex + 1).map(toNum);
    for (let i = 0; i < models.length; i += 1) {
      const value = values[i];
      if (Number.isFinite(value)) prices[i][metric][tier] = value;
    }
  }

  const catalog: PricingCatalog = {};
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const p = prices[i];
    const input = p.cacheMiss.offPeak;
    const cacheRead = p.cacheHit.offPeak;
    const output = p.output.offPeak;
    if (!model || ![input, cacheRead, output].every((n) => Number.isFinite(n) && Number(n) >= 0)) continue;
    const outputPeak = p.output.peak;
    const peakMultiplier = Number.isFinite(outputPeak) && output && output > 0 ? Number(outputPeak) / output : 2;
    catalog[model] = {
      input: Number(input),
      cacheRead: Number(cacheRead),
      output: Number(output),
      peakMultiplier: Number.isFinite(peakMultiplier) && peakMultiplier > 0 ? peakMultiplier : 2,
      currency,
    };
  }
  return catalog;
}

/** 找不到指定模型时返回 null，不再错误回落到表格第一列 */
export function parsePricingHtml(html: string, modelId = 'deepseek-v4-flash'): Pricing | null {
  return (
    parsePricingCatalogHtml(html)[canonicalModel(modelId)] ??
    parsePricingCatalogHtml(html)[normalizeModelId(modelId)] ??
    null
  );
}

export async function fetchOfficialPricingCatalog(
  signal = new AbortController().signal,
  currency: SpendCurrency = 'CNY',
): Promise<PricingCatalog> {
  return parsePricingCatalogHtml(await fetchFresh(PRICING_DOC_URL[currency], signal), currency);
}

export type PricingSource = 'official' | 'cache' | 'default' | 'unavailable';
export interface PricingManager {
  current(modelId: string, currency?: SpendCurrency): Pricing | undefined;
  source(modelId: string, currency?: SpendCurrency): PricingSource;
  snapshot(currency?: SpendCurrency): PricingCatalog;
  status(): Record<string, UpdateStatus>;
  start(): Promise<void>;
  dispose(): void;
  refresh(): Promise<void>;
}

function validCatalog(value: unknown, key: string): value is PricingCatalog {
  if (!value || typeof value !== 'object' || !['CNY', 'USD'].includes(key)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([model, p]) =>
        model.startsWith('deepseek-') &&
        p &&
        p.currency === key &&
        [p.input, p.cacheRead, p.output, p.peakMultiplier].every(
          (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
        ) &&
        p.peakMultiplier > 0,
    )
  );
}

/** 每次 start 都联网；双币种独立更新，失败不覆盖最近的有效缓存。 */
export function createPricingManager(cacheFile?: string): PricingManager {
  const store = createStartupData<PricingCatalog>({
    cacheFile,
    keys: () => SPEND_CURRENCIES,
    valid: validCatalog,
    fallback: (key) => (['CNY', 'USD'].includes(key) ? defaults(key as SpendCurrency) : undefined),
    fetch: (key, signal) => fetchOfficialPricingCatalog(signal, key as SpendCurrency),
  });
  return {
    current(modelId, currency = 'CNY') {
      return store.current(currency)?.[canonicalModel(modelId)] ?? defaults(currency)[canonicalModel(modelId)];
    },
    source(modelId, currency = 'CNY') {
      const key = canonicalModel(modelId);
      if (!store.current(currency)?.[key]) return defaults(currency)[key] ? 'default' : 'unavailable';
      const source = store.status(currency).source;
      return source === 'online' ? 'official' : source;
    },
    snapshot(currency = 'CNY') {
      return { ...defaults(currency), ...store.current(currency) };
    },
    status: () => Object.fromEntries(SPEND_CURRENCIES.map((c) => [c, store.status(c)])),
    start: store.start,
    refresh: store.refresh,
    dispose: store.dispose,
  };
}
/** cacheWrite 按缓存未命中输入计价 */
export function calculateTokenCost(
  usage: { input: number; output: number; cacheRead: number; cacheWrite?: number },
  pricing: Pricing,
  isPeak: boolean,
): number {
  const multiplier = isPeak ? pricing.peakMultiplier : 1;
  return (
    (((usage.input + (usage.cacheWrite ?? 0)) * pricing.input +
      usage.cacheRead * pricing.cacheRead +
      usage.output * pricing.output) /
      1_000_000) *
    multiplier
  );
}
