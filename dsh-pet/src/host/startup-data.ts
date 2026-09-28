import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UpdateStatus {
  source: 'online' | 'cache' | 'default' | 'unavailable';
  checkedAt: number | null;
  updatedAt: number | null;
  error: string | null;
}

/** 启动必刷新（缓存仅兜底，不跳过网络），单飞、超时、中止、逐项成功缓存。 */
export function createStartupData<T>(options: {
  keys: () => string[];
  fetch: (key: string, signal: AbortSignal) => Promise<T>;
  valid: (value: unknown, key: string) => value is T;
  fallback: (key: string) => T | undefined;
  cacheFile?: string;
}) {
  const entries = new Map<string, { value: T; updatedAt: number }>();
  const states = new Map<string, UpdateStatus>();
  let controller = new AbortController();
  let flight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (options.cacheFile) {
    try {
      const saved = JSON.parse(readFileSync(options.cacheFile, 'utf8'));
      if (saved.version === 1 && saved.entries && typeof saved.entries === 'object') {
        for (const [key, raw] of Object.entries(saved.entries)) {
          const entry = raw as { value: unknown; updatedAt: number };
          if (entry && Number.isFinite(entry.updatedAt) && options.valid(entry.value, key)) {
            entries.set(key, { value: entry.value, updatedAt: entry.updatedAt });
            states.set(key, { source: 'cache', checkedAt: null, updatedAt: entry.updatedAt, error: null });
          }
        }
      }
    } catch {
      /* 首次启动/缓存损坏：走明确兜底，仍尝试联网。 */
    }
  }
  const status = (key: string): UpdateStatus =>
    states.get(key) ?? {
      source: options.fallback(key) ? 'default' : 'unavailable',
      checkedAt: null,
      updatedAt: null,
      error: null,
    };
  const refresh = (): Promise<void> => {
    if (flight) return flight;
    const signal = controller.signal;
    flight = Promise.all(
      options.keys().map(async (key) => {
        const checkedAt = Date.now();
        try {
          const value = await options.fetch(key, signal);
          if (signal.aborted) return;
          if (!options.valid(value, key)) throw new Error('响应数据不完整或格式不匹配');
          const updatedAt = Date.now();
          entries.set(key, { value, updatedAt });
          states.set(key, { source: 'online', checkedAt, updatedAt, error: null });
        } catch (error) {
          if (signal.aborted) return;
          states.set(key, { ...status(key), checkedAt, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    )
      .then(() => {
        if (signal.aborted || !options.cacheFile || !entries.size) return;
        try {
          mkdirSync(dirname(options.cacheFile), { recursive: true });
          const temporary = options.cacheFile + '.' + process.pid + '.tmp';
          writeFileSync(temporary, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }), 'utf8');
          renameSync(temporary, options.cacheFile);
        } catch (error) {
          console.warn('[dsh-pet] 计价数据缓存写入失败', error instanceof Error ? error.message : error);
        }
      })
      .finally(() => {
        flight = null;
      });
    return flight;
  };
  return {
    current: (key: string) => entries.get(key)?.value ?? options.fallback(key),
    status,
    refresh,
    start(): Promise<void> {
      if (controller.signal.aborted) controller = new AbortController();
      if (!timer) {
        timer = setInterval(() => void refresh(), 6 * 3600_000);
        timer.unref?.();
      }
      return refresh();
    },
    dispose() {
      controller.abort();
      clearInterval(timer);
      timer = undefined;
    },
  };
}

/** 禁用 HTTP 缓存；请求和读取响应体共用 15 秒超时，卸载即取消。 */
export async function fetchFresh(url: string, signal: AbortSignal): Promise<string> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 15000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.any([signal, timeout.signal]),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
