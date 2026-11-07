/** 魔兽面板的同源 API 边界；请求共享宿主认证，卸载时统一取消。 */

/** 面板支持的游戏分区。 */
export type WowGame = 'retail' | 'forever' | 'classic';
/** 界面与知识社区语言。 */
export type WowLocale = 'zh-CN' | 'en';
/** 跨 API 边界的 JSON 对象。 */
export type JsonObject = Record<string, unknown>;
/** 面板所需的认证 API，测试可注入内存替身。 */
export interface WowApi {
  state(game: WowGame): Promise<JsonObject>;
  action(action: string, game: WowGame, data?: unknown): Promise<unknown>;
}

/** 读取 JSON 对象，缺失字段使用空对象。 */
export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

/** 读取 JSON 列表。 */
export function list(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(object) : [];
}

/** 将仅供显示的原始字段转换成文本。 */
export function text(value: unknown, fallback = '—'): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

/** 取出领域操作的数据，同时保留未包装的返回值。 */
export function data(value: unknown): unknown {
  const row = object(value);
  return row.ok === true && 'data' in row ? row.data : value;
}

/** 创建有超时与卸载取消的同源客户端；认证令牌不进入日志或 URL。 */
export function createWowApi(signal: AbortSignal): WowApi {
  const request = async (path: string, payload?: unknown): Promise<unknown> => {
    const action = text(object(payload).action, '');
    const timeoutMs = action === 'macro.import' ? 210_000 : action.startsWith('addons.install') ? 180_000 : 30_000;
    const response = await fetch(`/dsh-pet-7340/wow/${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      ...(payload === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
    const result: unknown = await response.json();
    const row = object(result);
    if (!response.ok || row.ok === false) {
      throw new Error(text(row.message ?? row.error ?? row.code, `HTTP ${response.status}`));
    }
    return result;
  };
  return {
    state: async (game) => object(await request(`state?game=${game}`)),
    action: (action, game, payload) => request('action', { action, game, data: payload }),
  };
}
