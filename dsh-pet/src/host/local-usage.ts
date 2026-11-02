/**
 * 本机会话用量：从 DSH 的 session_projcache 读 token 累计，不走商家余额 API。
 * 自定义模型也能显示「入 / 出 / 缓存」。缺文件或形状不对返回 null，调用方跳过写入。
 * @module dsh-pet/src/host/local-usage
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 一条本机会话用量（给 sections.usage 与气泡文案）。 */
export interface LocalUsage {
  /** 会话 id（文件名里的那一段）。 */
  sessionId: string;
  /** 未命中缓存的输入 token。 */
  input: number;
  /** 输出 token。 */
  output: number;
  /** 缓存读取 token。 */
  cache: number;
  /** 气泡用的一行中文。 */
  text: string;
}

/** 把 token 数收成短标签：1234 → 1.2k，1_200_000 → 1.2M。 */
export function formatTok(n: number): string {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return '0';
  if (x >= 1e6) return (x / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (x >= 1000) return (x >= 10_000 ? Math.round(x / 1000) : Math.round(x / 100) / 10) + 'k';
  return String(Math.round(x));
}

/**
 * 从会话缓存 JSON 抽出 totals。形状不对返回 null。
 * @param raw - `session-*.json` 根对象。
 */
export function parseSessionTokenTotals(raw: unknown): { input: number; output: number; cache: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const totals = (raw as { record?: { rows?: { tokenUsage?: { val?: { totals?: unknown } } } } }).record?.rows
    ?.tokenUsage?.val?.totals;
  if (!totals || typeof totals !== 'object') return null;
  const t = totals as Record<string, unknown>;
  const input = Number(t.uncachedInputTokens);
  const output = Number(t.outputTokens);
  const cache = Number(t.cacheReadTokens);
  if (![input, output, cache].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return { input, output, cache };
}

/**
 * 读 `$DSH_HOME/storages/session_projcache/sessions/session-<id>.json`。
 * @param dshHome - DSH 数据根。
 * @param sessionId - 会话 id；空 / unknown 返回 null。
 */
export function readSessionUsage(dshHome: string, sessionId: string | null | undefined): LocalUsage | null {
  if (!sessionId || sessionId === 'unknown') return null;
  const dir = join(dshHome, 'storages', 'session_projcache', 'sessions');
  const candidates = [join(dir, 'session-' + sessionId + '.json'), join(dir, sessionId + '.json')];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return null;
  try {
    const parsed = parseSessionTokenTotals(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    if (!parsed) return null;
    const { input, output, cache } = parsed;
    return {
      sessionId,
      input,
      output,
      cache,
      text:
        '用量 入' +
        formatTok(input) +
        ' 出' +
        formatTok(output) +
        (cache > 0 ? ' 缓存' + formatTok(cache) : ''),
    };
  } catch {
    return null;
  }
}
