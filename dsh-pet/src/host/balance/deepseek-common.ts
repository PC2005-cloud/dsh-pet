/**
 * DeepSeek 两条路由（官方 API Key / DSH 账号）共用的**业务口径**。
 *
 * 这里的两个东西都是 DeepSeek 自己的事实，不属于展示层：展示层只认「数据带出来的档位与基准」
 * （见 ./types.ts 的 MoneyBalance），所以它们住在 host 侧、由 provider 随数据一起带出。
 */
import type { PricingTier } from './types';

/**
 * 余额档位基准（¥）：余额 ≥ 该值视为 100%（未消耗），据此把余额折算成「已用百分比」驱动档位动画。
 * 余额 20 元 → 0%，10 元 → 50%，0 元 → 100%。
 *
 * 为什么是 ¥20：DeepSeek 充值以 10 元为最小档，20 元是「余量充足」的常用参照；低于它才开始示警。
 */
export const DEEPSEEK_FULL_BALANCE = '20';

/**
 * DeepSeek 峰谷计价档位（北京时间）：
 * - 高峰：工作日 9:00–12:00、14:00–18:00；其余为空闲（低谷）
 * - 周六/周日全天按低谷价计费（自 2026-08-23 起，周末不再区分峰谷）
 *
 * 在**取数时刻**算好后随数据带出（而不是展示时刻）：气泡只在刷新后显示 ≤10 秒（客户端 1s 轮询
 * 拉取），与显示时刻的偏差只有 1~2 秒。换来的是展示层完全不需要知道任何计价规则。
 */
export function deepseekPricingTier(now: Date = new Date()): PricingTier {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23', // h23 避免午夜被格式化为 "24:00"
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const hour = Number(pick('hour'));
  if (weekday === 'Sat' || weekday === 'Sun') return 'idle'; // 周末全天低谷
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'idle';
}
