/**
 * 待办事项路由：`GET/POST /todos` 与 `PATCH/DELETE /todos/{id}`。
 *
 * 只解析与校验输入，存取全走 `deps.todos`；写盘失败归一成 `internal-error`，不把路径带进响应。
 * 业务结论一律 200（与其余动作端点一致），只有协议错误（方法、JSON、体超限）保留真实状态码。
 * @module dsh-pet/src/host/routes/todos
 */
import { failResult, invalidJson, methodNotAllowed, okResult, payloadTooLarge } from './result.ts';
import { normalizeTodoDueAt, normalizeTodoText, TODO_BODY_MAX_BYTES, TODO_TEXT_MAX } from '../todo/types.ts';
import type { RouteResult } from '../http.ts';
import type { TodoPatch } from '../todo/store.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 路径前缀：`todos` 或 `todos/<id>`。 */
const PREFIX = 'todos';

/** Object.prototype.hasOwnProperty 的短别名：PATCH 要把「没传」与「传了 null」分开。 */
const has = (source: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(source, key);

/** 解析请求体：不是 JSON 对象 → null。 */
function parseObjectBody(body: string | undefined): Record<string, unknown> | null {
  if (body === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * PATCH 的字段校验：出现的键逐个校验，任一非法整包拒绝。
 *
 * @param raw - 已解析的请求体。
 * @returns 待写入的字段集合；没有可写字段时返回空对象。
 */
function readPatch(raw: Record<string, unknown>): TodoPatch | null {
  const patch: TodoPatch = {};
  if (has(raw, 'text')) {
    const text = normalizeTodoText(raw.text);
    if (text === null) return null;
    patch.text = text;
  }
  if (has(raw, 'dueAt')) {
    const due = normalizeTodoDueAt(raw.dueAt);
    if (!due.ok) return null;
    patch.dueAt = due.value;
  }
  if (has(raw, 'done')) {
    if (typeof raw.done !== 'boolean') return null;
    patch.done = raw.done;
  }
  return patch;
}

/** 待办领域：未命中返回 undefined，命中返回应答。 */
export async function handleTodoRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { body, method, rest } = input;
  if (rest !== PREFIX && !rest.startsWith(PREFIX + '/')) return undefined;
  const { log, todos } = deps;

  try {
    if (rest === 'todos') {
      if (method === 'GET') return okResult({ ok: true, todos: await todos.list() });
      if (method !== 'POST') return methodNotAllowed();
      if (Buffer.byteLength(body ?? '', 'utf8') > TODO_BODY_MAX_BYTES) return payloadTooLarge();
      const raw = parseObjectBody(body);
      if (raw === null) return invalidJson();
      const text = normalizeTodoText(raw.text);
      if (text === null) return failResult('bad-request', `text 必须是非空字符串，最多 ${TODO_TEXT_MAX} 个字符`);
      const due = normalizeTodoDueAt(raw.dueAt);
      if (!due.ok) return failResult('bad-request', 'dueAt 必须是毫秒时间戳或 null');
      return okResult({ ok: true, todo: await todos.create({ text, dueAt: due.value }) });
    }

    // /todos/{id}：id 是实例内标识，不是文件路径；只做形状校验。
    const id = rest.slice(PREFIX.length + 1);
    if (id === '' || id.includes('/')) return failResult('bad-request', 'todo id 不合法');

    if (method === 'PATCH') {
      if (Buffer.byteLength(body ?? '', 'utf8') > TODO_BODY_MAX_BYTES) return payloadTooLarge();
      const raw = parseObjectBody(body);
      if (raw === null) return invalidJson();
      const patch = readPatch(raw);
      if (patch === null) return failResult('bad-request', 'text / dueAt / done 至少一个字段不合法');
      if (Object.keys(patch).length === 0) return failResult('bad-request', '没有可更新的字段');
      const todo = await todos.update(id, patch);
      if (todo === null) return failResult('todo-not-found', '没有这条待办');
      return okResult({ ok: true, todo });
    }

    if (method === 'DELETE') return okResult({ ok: true, removed: await todos.remove(id) });

    return methodNotAllowed();
  } catch (error) {
    // 写盘失败（磁盘满 / 权限）：真实原因只进日志，响应里只回分类文案。
    log.warn(`[dsh-pet] 待办读写失败：${error instanceof Error ? error.message : String(error)}`);
    return failResult('internal-error', 'dsh-pet: 待办读写失败');
  }
}
