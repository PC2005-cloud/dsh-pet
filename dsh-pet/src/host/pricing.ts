/**
 * DeepSeek 官方定价爬取（host 半侧）
 *
 * 从官方中文定价文档 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 抓取
 * 当前模型的单价（人民币元/百万 tokens），解析出 空闲时段 / 高峰时段 两档价格，
 * 供每轮对话的 token 成本计算使用。
 *
 * 设计：
 * - 启动时抓取一次，之后每 6 小时刷新一次（定价变化不频繁，避免高频打官方站）；
 * - 抓取失败时回落内置默认价（deepseek-v4-flash 官方人民币价，见 DEFAULT_PRICING）；
 * - 解析策略：在 HTML 中定位「价格」表格 → 按表头（模型行）找到目标模型列 →
 *   读取该列「百万tokens输入（缓存命中/未命中）/输出」的 空闲时段/高峰时段 值；
 * - 抓取结果与默认价结构一致：{ input, cacheRead, output, peakMultiplier }（元/百万折算，币种 CNY）。
 */

/** 官方中文定价文档地址（人民币计价） */
const PRICING_DOC_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';

/** 抓取间隔（ms）：6 小时 */
const PRICING_REFRESH_MS = 6 * 60 * 60 * 1000;

/** 内置默认价（deepseek-v4-flash，人民币元/百万 tokens，官方 2026-08 峰谷价） */
export interface Pricing {
  /** 输入（缓存未命中）单价，元/百万 tokens */
  input: number;
  /** 输入（缓存命中）单价，元/百万 tokens */
  cacheRead: number;
  /** 输出单价，元/百万 tokens */
  output: number;
  /** 高峰时段倍率（官方 高峰/空闲 比值，空闲 = 1） */
  peakMultiplier: number;
  /** 币种：官方中文价为人民币，展示/计费按此币种 */
  currency: string;
}

/** 内置默认价（deepseek-v4-flash 官方人民币价） */
export const DEFAULT_PRICING: Pricing = {
  input: 1.5,
  cacheRead: 0.05,
  output: 4.5,
  peakMultiplier: 2,
  currency: 'CNY',
};

/** 从 HTML 表格文本行解析一行（去标签、归一化空白、去货币符号转数字） */
function cellText(row: string): string[] {
  const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&yen;/g, '¥').trim(),
  );
  return cells.filter(Boolean);
}

/** 去货币符号/元字/千分位后转数字；非法返回 NaN */
function toNum(s: string): number {
  const n = Number(String(s).replace(/[¥$,\s元]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 从官方中文定价文档 HTML 解析指定模型的价格。
 * 表格结构（每行 cell 数组，中文版）：
 *   row: [模型, deepseek-v4-flash, deepseek-v4-pro, ...]
 *   row: [价格(1)(2), 百万tokens输入（缓存命中）, 空闲时段, 0.05元, 0.15元, ...]
 *   row: [高峰时段, 0.10元, ...]
 *   row: [百万tokens输入（缓存未命中）, 空闲时段, 1.5元, ...]
 *   row: [百万tokens输出, 空闲时段, 4.5元, ...]
 * 定位策略：找行内「空闲时段/高峰时段」标签，标签之后的值按模型列顺序取（模型数 = 表头列数）。
 * @param html 定价文档 HTML
 * @param modelId 目标模型列名（如 deepseek-v4-flash），缺省取第一列
 * @returns 解析出的 Pricing（币种 CNY）；解析失败返回 null
 */
export function parsePricingHtml(html: string, modelId?: string): Pricing | null {
  // 定位价格表格起点（中文页第一个 table 即价格表）
  const tableStart = html.indexOf('<table');
  if (tableStart < 0) return null;
  const table = html.slice(tableStart, tableStart + 12000);

  const rows = table.split('</tr>').map(cellText).filter((r) => r.length > 0);
  if (rows.length === 0) return null;

  // 表头行：找到包含「模型」的行，确定目标列索引
  const headerRow = rows.find((r) => r[0]?.includes('模型'));
  if (!headerRow) return null;
  const models = headerRow.slice(1);
  if (models.length === 0) return null;
  let mIdx = -1;
  if (modelId) {
    mIdx = models.findIndex((c) => c.trim().toLowerCase() === modelId.trim().toLowerCase());
  }
  if (mIdx < 0) mIdx = 0; // 缺省/未找到取第一个模型列

  // 逐行解析：当前指标（cacheHit/cacheMiss/output）+ 空闲/高峰档
  const prices: Record<'cacheHit' | 'cacheMiss' | 'output', Record<string, number>> = {
    cacheHit: {},
    cacheMiss: {},
    output: {},
  };
  let metric: 'cacheHit' | 'cacheMiss' | 'output' | null = null;
  for (const r of rows) {
    const joined = r.join(' ');
    if (joined.includes('缓存命中')) metric = 'cacheHit';
    else if (joined.includes('缓存未命中')) metric = 'cacheMiss';
    else if (joined.includes('输出')) metric = 'output';

    // 定位「空闲时段/高峰时段」标签，标签后的值按模型列顺序排列
    const tagIdx = r.findIndex((c) => c.includes('空闲时段') || c.includes('高峰时段'));
    if (metric && tagIdx >= 0) {
      const after = r.slice(tagIdx + 1).map(toNum);
      if (after[mIdx] !== undefined && Number.isFinite(after[mIdx])) {
        const isPeak = r[tagIdx].includes('高峰');
        const key = isPeak ? 'peak' : 'offPeak';
        prices[metric][key] = after[mIdx];
      }
    }
  }

  // 组装
  const input = prices.cacheMiss.offPeak;
  const cacheRead = prices.cacheHit.offPeak;
  const output = prices.output.offPeak;
  if (input === undefined || cacheRead === undefined || output === undefined) return null;
  // 高峰倍率：取输出高峰/空闲比值（官方各档均为 2），兜底 2
  const peakMult =
    prices.output.peak !== undefined && output > 0 ? Math.round((prices.output.peak / output) * 100) / 100 : 2;
  return {
    input,
    cacheRead,
    output,
    peakMultiplier: Number.isFinite(peakMult) && peakMult > 0 ? peakMult : 2,
    currency: 'CNY',
  };
}

/** 抓取官方定价文档并解析；失败返回 null */
export async function fetchOfficialPricing(modelId?: string): Promise<Pricing | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(PRICING_DOC_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    return parsePricingHtml(html, modelId);
  } catch {
    return null;
  }
}

/**
 * 定价管理器（工厂对象形态）：持有当前定价，启动时抓取 + 周期刷新，失败回落默认。
 * 每次读取都是当前最新值（异步抓取完成后自动更新）。
 * 用普通对象而非 class：避免构建产物引入 oxc 类字段 helper（@oxc-project/runtime），
 * 该运行时非显式依赖，缺失会导致 DSH 加载失败。
 */
export interface PricingManager {
  current(): Pricing;
  start(): void;
  dispose(): void;
  refresh(): Promise<void>;
}

export function createPricingManager(modelId?: string): PricingManager {
  let pricing: Pricing = { ...DEFAULT_PRICING };
  let timer: ReturnType<typeof setInterval> | null = null;
  let fetching = false;

  async function refresh(): Promise<void> {
    if (fetching) return;
    fetching = true;
    try {
      const next = await fetchOfficialPricing(modelId);
      if (next) {
        pricing = next;
        console.log(
          '[dsh-pet] 官方定价已更新(CNY): input=' +
            next.input +
            '元/M cacheRead=' +
            next.cacheRead +
            '元/M output=' +
            next.output +
            '元/M peak x' +
            next.peakMultiplier,
        );
      }
    } finally {
      fetching = false;
    }
  }

  return {
    current(): Pricing {
      return pricing;
    },
    start(): void {
      void refresh();
      if (timer === null) {
        timer = setInterval(() => void refresh(), PRICING_REFRESH_MS);
      }
    },
    dispose(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    refresh,
  };
}
