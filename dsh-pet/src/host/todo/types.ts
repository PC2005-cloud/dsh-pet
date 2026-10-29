/**
 * 待办的落盘形状与字段校验：宿主侧读写待办时唯一的一份口径。
 *
 * 不做 IO、不读时钟：解析失败的条目一律整条丢弃（不让脏数据进内存），由 ./store 决定何时落盘。
 * 与 shared/todo/types 的 wire 字段同名；宿主不 import 共享层（DSH 单文件加载约束）。
 * @module dsh-pet/src/host/todo/types
 */

/** 单条待办：磁盘与 HTTP 响应共用。 */
export interface TodoRecord {
  /** 实例内唯一；只含 `[A-Za-z0-9_-]`，会出现在 URL 路径里。 */
  id: string;
  /** 正文：已 trim，1–200 个码点。 */
  text: string;
  /** 到期时刻（epoch ms）；null = 无期限，永不提醒。 */
  dueAt: number | null;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  /** 完成时刻；未完成为 null。 */
  completedAt: number | null;
  /** 上次提醒时刻；null = 尚未提醒。改期限或重新打开会清空它，让提醒重新排期。 */
  lastRemindedAt: number | null;
}

/** 待办文件版本：形状变更时递增，读取侧据此决定要不要迁移。 */
export const TODO_FILE_VERSION = 1;

/** 正文上限（码点数）：够写清一件事，又不至于把气泡与面板撑爆。 */
export const TODO_TEXT_MAX = 200;

/** 请求体上限（字节）：待办读写只接受短正文，防止一次塞进整本书。 */
export const TODO_BODY_MAX_BYTES = 16 * 1024;

/** 落盘文件的根。 */
export interface TodoFile {
  version: number;
  todos: TodoRecord[];
}

/** 到期时刻的校验结论：ok=false 表示显式给了非法值，调用方回 bad-request。 */
export type DueAtParse = { ok: true; value: number | null } | { ok: false };

/**
 * 校验并归一化正文。
 *
 * @param raw - 请求体里的原文。
 * @returns trim 后的正文；非字符串、空白或超过 {@link TODO_TEXT_MAX} 个码点时返回 null。
 */
export function normalizeTodoText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;
  if (Array.from(text).length > TODO_TEXT_MAX) return null;
  return text;
}

/**
 * 校验到期时刻。
 *
 * `null` / 缺省都表示「没有期限」；数字必须是有限的 epoch 毫秒，且落在 Date 能表示的范围内。
 *
 * @param raw - 请求体或磁盘里的原值。
 * @returns 归一化后的值，或 `ok: false`。
 */
export function normalizeTodoDueAt(raw: unknown): DueAtParse {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false };
  // 8.64e15 = Date 的最大时间戳；再大就不是一个真实存在的时刻了。
  if (Math.abs(raw) > 8.64e15) return { ok: false };
  return { ok: true, value: raw };
}

/** 读一个有限数字，非法时回落。 */
function finiteOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

/**
 * 读一条记录：任一字段不合格都返回 null（整条丢弃，不修补也不猜）。
 *
 * @param raw - 磁盘或请求体里的单条原值。
 * @returns 已校验的记录，或 null。
 */
export function parseTodoRecord(raw: unknown): TodoRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(record.id)) return null;
  const text = normalizeTodoText(record.text);
  if (text === null) return null;
  const due = normalizeTodoDueAt(record.dueAt);
  if (!due.ok) return null;
  const createdAt = finiteOr(record.createdAt, 0);
  const updatedAt = finiteOr(record.updatedAt, createdAt);
  const done = record.done === true;
  const completedAt = done ? finiteOr(record.completedAt, updatedAt) : null;
  const lastRemindedAt =
    typeof record.lastRemindedAt === 'number' && Number.isFinite(record.lastRemindedAt) ? record.lastRemindedAt : null;
  return { id: record.id, text, dueAt: due.value, done, createdAt, updatedAt, completedAt, lastRemindedAt };
}

/**
 * 读整个文件：根不是对象、`todos` 不是数组都按空清单处理；重复 id 只留第一条。
 *
 * @param raw - `JSON.parse` 的结果。
 * @returns 已校验的记录列表（保持文件顺序，排序交给调用方）。
 */
export function parseTodoFile(raw: unknown): TodoRecord[] {
  const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(root.todos) ? root.todos : [];
  const out: TodoRecord[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const todo = parseTodoRecord(item);
    if (todo === null || seen.has(todo.id)) continue;
    seen.add(todo.id);
    out.push(todo);
  }
  return out;
}

/** 复制一条记录：消费端拿到的是副本，改它不会污染缓存。 */
export function cloneTodo(todo: TodoRecord): TodoRecord {
  return { ...todo };
}

/**
 * 展示顺序：未完成在前（到期越近越靠前，无期限垫底），已完成在后（最近完成的在上）。
 *
 * @param list - 任意顺序的记录。
 * @returns 排好序的新数组，不改原数组。
 */
export function sortTodos(list: readonly TodoRecord[]): TodoRecord[] {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done) return (b.completedAt ?? 0) - (a.completedAt ?? 0);
    const aDue = a.dueAt ?? Number.POSITIVE_INFINITY;
    const bDue = b.dueAt ?? Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return a.createdAt - b.createdAt;
  });
}
