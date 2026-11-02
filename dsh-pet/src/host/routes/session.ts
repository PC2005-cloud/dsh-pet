/**
 * 会话跳转：桌面宠物点击气泡后，请网页端切到对应会话。
 * @module dsh-pet/src/host/routes/session
 */
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/**
 * 会话领域路由：POST /focus-session。
 * @param deps - 路由依赖。
 * @param input - 本次请求。
 * @returns 命中则应答，否则 undefined。
 */
export async function handleSessionRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method, body } = input;
  if (rest !== 'focus-session') return undefined;
  if (method !== 'POST') return methodNotAllowed();
  let payload: { sessionId?: unknown };
  try {
    payload = JSON.parse(body ?? '') as { sessionId?: unknown };
  } catch {
    return invalidJson();
  }
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!sessionId || sessionId === 'unknown') {
    return failResult('bad-request', 'sessionId 必填');
  }
  deps.state.writeSection('focusSession', { sessionId, ts: Date.now() });
  return okResult({ ok: true, sessionId });
}
