/**
 * 事件周期（秒）的解析：把配置里的原始值收窄成能安全交给 setTimeout 的秒数。
 *
 * 不读配置、不排定时器：兜底值由调用方各自决定（余额 1800、碎碎念 300、梦话 60）。
 * 上限来自 setTimeout 的延时上限 2^31-1 ms——超过它的延时会被 Node 当成 1 ms，
 * 于是「周期设得太大」反而变成每秒一次，比不设还糟。
 * @module dsh-pet/src/host/plugin/period
 */

/** setTimeout 能接受的最大延时（ms）。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** 周期上限（秒）：超过它的配置按它算，避免延时溢出成 1 ms。 */
export const MAX_PERIOD_SEC = Math.floor(MAX_TIMEOUT_MS / 1000);

/**
 * 把配置里的周期收窄成可用秒数。
 *
 * @param raw - 配置原始值；非数字、0、负数都算非法。
 * @param fallbackSec - 非法时用的兜底周期（秒）。
 * @returns 合法时为原值（不超过 {@link MAX_PERIOD_SEC}），非法时为 `fallbackSec`。
 */
export function clampPeriodSec(raw: unknown, fallbackSec: number): number {
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) return fallbackSec;
  return Math.min(sec, MAX_PERIOD_SEC);
}
