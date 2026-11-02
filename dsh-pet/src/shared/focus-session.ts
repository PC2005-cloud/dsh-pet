/**
 * 跳会话指令的解析：把 `sections.focusSession` 的 data 收窄成「该跳」或「跳过」。
 *
 * 这是一次性信号，两条判据缺一不可：`ts` 必须新于本地水位（否则同一条会重复跳），
 * 且不能太旧（页面隔很久才打开时，不该被一条早已过时的点击拽走）。
 * @module dsh-pet/src/shared/focus-session
 */

/** 重放窗口（ms）：超过这个时长的旧信号不再补跳。 */
export const FOCUS_REPLAY_WINDOW_MS = 10_000;

/** 该执行的跳转：目标会话与它的写入时刻。 */
export interface FocusCue {
  /** 目标会话 id。 */
  readonly sessionId: string;
  /** 写入时刻（毫秒），作为下一次判重的水位。 */
  readonly ts: number;
}

/**
 * 解析一条跳会话信号。
 *
 * @param raw - 叶子的 `data`；形状非法时返回 null。
 * @param now - 当前时刻（ms）；由调用方注入，便于测试。
 * @param lastTs - 本地已处理过的最大 `ts`；小于等于它的一律跳过。
 * @returns 该执行的跳转；不该跳时为 null。
 */
export function readFocusSession(raw: unknown, now: number, lastTs: number): FocusCue | null {
  if (!raw || typeof raw !== 'object') return null;
  const { sessionId, ts } = raw as { sessionId?: unknown; ts?: unknown };
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  // 同一条信号只处理一次：页面首拉补跳与随后那一拍增量读到的是同一个 ts。
  if (ts <= lastTs) return null;
  if (now - ts > FOCUS_REPLAY_WINDOW_MS) return null;
  return { sessionId, ts };
}
