import { calculateTokenCost, SPEND_CURRENCIES, type SpendCurrency, type PricingManager } from './pricing-catalog';
import { createHolidayManager, peakAt } from './holidays';

type Route = { provider?: string; model?: string };
export interface SpendEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: {
    turn?: number;
    step?: number;
    provider?: string;
    model?: string;
    header?: { config?: Route };
    reason?: { kind?: string };
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  };
}
export interface SpendSession {
  id?: string;
  header?: { id?: string };
  requestHeader?: () => { config?: Route } | undefined;
}
export interface TurnSpend {
  count: number;
  amount: number;
  currency: SpendCurrency;
  at: number;
  models: string[];
  source: string[];
  estimated: true;
}

/** 无网络的默认判定供独立调用使用；宿主注入启动时自动更新的日历。 */
const fallbackCalendar = createHolidayManager();
export function isDeepseekPeak(time: number): boolean | undefined {
  return peakAt(time, fallbackCalendar.isHoliday);
}
/** 每个 assistant/message 是一次请求的最终 usage；不累计 chunk，防止重复收费。 */
export function createTurnSpendStore(
  prices: Pick<PricingManager, 'current' | 'source'>,
  peak: (time: number) => boolean | undefined = isDeepseekPeak,
) {
  type Turn = {
    turn?: number;
    route?: Route;
    requestTime?: number;
    seen: Set<number>;
    amounts: Record<SpendCurrency, number>;
    unavailable: Set<SpendCurrency>;
    incomplete: boolean;
    calls: number;
    models: Set<string>;
    sources: Record<SpendCurrency, Set<string>>;
  };
  const turns = new Map<string, Turn>();
  const results = new Map<string, Partial<Record<SpendCurrency, TurnSpend>>>();
  let sequence = 0;
  let latestSession = '';
  const trim = <T>(map: Map<string, T>) => {
    while (map.size > 200) map.delete(map.keys().next().value!);
  };
  return {
    get: (id: string, currency: SpendCurrency = 'CNY') => results.get(id)?.[currency] ?? null,
    latestSession: () => latestSession,
    consume(session: SpendSession, event: SpendEvent) {
      const id = session.header?.id ?? session.id;
      if (!id) return;
      const data = event.data;
      if (event.type === 'turn/start') {
        latestSession = id;
        turns.set(id, {
          turn: data?.turn,
          route: session.requestHeader?.()?.config,
          seen: new Set(),
          amounts: { CNY: 0, USD: 0 },
          unavailable: new Set(),
          calls: 0,
          incomplete: false,
          models: new Set(),
          sources: { CNY: new Set(), USD: new Set() },
        });
        trim(turns);
        return;
      }
      const turn = turns.get(id);
      if (!turn || (data?.turn !== undefined && turn.turn !== undefined && data.turn !== turn.turn)) return;
      if (event.type === 'step/start') turn.requestTime = event.time ?? Date.now();
      if (event.type === 'request/header') turn.route = data?.header?.config;
      if (event.type === 'request/context') turn.route = { provider: data?.provider, model: data?.model };
      if (event.type === 'assistant/message') {
        const key = data?.step ?? event.seq;
        if (key !== undefined && turn.seen.has(key)) return;
        if (key !== undefined) turn.seen.add(key);
        const usage = data?.usage;
        const route = turn.route ?? session.requestHeader?.()?.config;
        const values = [
          usage?.inputTokens,
          usage?.outputTokens,
          usage?.cacheReadTokens ?? 0,
          usage?.cacheWriteTokens ?? 0,
        ];
        if (
          !usage ||
          !values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) ||
          route?.provider !== 'deepseek-official' ||
          !route.model
        ) {
          turn.incomplete = true;
          return;
        }
        const [input, output, cacheRead, cacheWrite] = values as number[];
        const isPeak = peak(turn.requestTime ?? event.time ?? Date.now());
        if (isPeak === undefined) {
          turn.incomplete = true;
          return;
        }
        // 每次请求同时留存两套官方价格的计算结果；设置切换时整轮一致，不混币种、不按汇率折算。
        for (const currency of SPEND_CURRENCIES) {
          const price = prices.current(route.model, currency);
          if (!price || price.currency !== currency) {
            turn.unavailable.add(currency);
            continue;
          }
          turn.amounts[currency] += calculateTokenCost({ input, output, cacheRead, cacheWrite }, price, isPeak);
          turn.sources[currency].add(prices.source(route.model, currency));
        }
        turn.calls++;
        turn.models.add(route.model!);
      }
      if (event.type !== 'turn/end') return;
      turns.delete(id);
      if (data?.reason?.kind !== 'completed' || turn.incomplete || !turn.calls) return;
      results.delete(id);
      const count = ++sequence;
      const at = Date.now();
      const settled: Partial<Record<SpendCurrency, TurnSpend>> = {};
      for (const currency of SPEND_CURRENCIES) {
        if (turn.unavailable.has(currency)) continue;
        settled[currency] = {
          count,
          amount: turn.amounts[currency],
          currency,
          at,
          models: [...turn.models],
          source: [...turn.sources[currency]],
          estimated: true,
        };
      }
      results.set(id, settled);
      trim(results);
    },
  };
}
