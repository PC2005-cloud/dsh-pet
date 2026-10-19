// 只记录已呈现的动画名与本地时间；不触及对话、账户或宿主接口。
import type { MenuNode } from './menu';

export interface ActionHistoryEntry {
  name: string;
  at: number;
}
export interface HistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export const ACTION_HISTORY_LIMIT = 100;
const MAX_JSON_LENGTH = 100000;

function validEntry(value: unknown): value is ActionHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as ActionHistoryEntry;
  return (
    typeof e.name === 'string' &&
    e.name.trim().length > 0 &&
    e.name.length <= 200 &&
    Number.isSafeInteger(e.at) &&
    e.at > 0 &&
    e.at <= 8640000000000000
  );
}

/** 每只宠物独立保存最近记录；禁用/占满存储时仍能在当前会话回看。entries 最新在前。 */
export function createActionHistory(petId: string, storage?: HistoryStorage | null) {
  let target = storage;
  if (target === undefined) {
    try {
      target = globalThis.localStorage;
    } catch {
      target = null;
    }
  }
  const key = 'dsh-pet:action-history:v1:' + encodeURIComponent(petId);
  let rows: ActionHistoryEntry[] = [];
  try {
    const raw = target?.getItem(key);
    if (raw && raw.length <= MAX_JSON_LENGTH) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        rows = parsed
          .filter(validEntry)
          .map((e) => ({ name: e.name, at: e.at }))
          .slice(-ACTION_HISTORY_LIMIT);
    }
  } catch {
    /* 本地记录损坏或存储不可用，不阻断宠物播放。 */
  }
  return {
    record(name: string, at = Date.now()): void {
      const entry = { name, at };
      if (!validEntry(entry)) return;
      // 播放壳以 generation 防止重复提交；不按名字/时间去重，以免吞掉真实快速重播。
      rows.push(entry);
      if (rows.length > ACTION_HISTORY_LIMIT) rows.splice(0, rows.length - ACTION_HISTORY_LIMIT);
      try {
        target?.setItem(key, JSON.stringify(rows));
      } catch {
        /* 继续使用内存记录。 */
      }
    },
    entries(): ActionHistoryEntry[] {
      return rows
        .slice()
        .reverse()
        .map((e) => ({ ...e }));
    },
  };
}

export function formatActionHistoryTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 历史项只供阅读，不带 anim/action，绝不会因查看而再次点播。 */
export function buildActionHistoryMenu(entries: ActionHistoryEntry[]): MenuNode[] {
  const rows = entries.filter(validEntry).slice(0, ACTION_HISTORY_LIMIT);
  return [
    {
      label: '动作历史' + (rows.length ? `（${rows.length}）` : ''),
      children: rows.length
        ? rows.map((e) => ({
            label: `${formatActionHistoryTime(e.at).slice(5)} · ${e.name}`,
            title: `${formatActionHistoryTime(e.at)} · ${e.name}`,
            disabled: true,
          }))
        : [{ label: '暂无记录，启用后开始记录', disabled: true }],
    },
  ];
}
