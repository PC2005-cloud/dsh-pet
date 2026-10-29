/**
 * 待办持久化：单个 JSON 文件的读与原子写，全部操作在同一队列里串行。
 *
 * 不负责校验 HTTP 输入（归 ../routes/todos）与提醒节奏（归 ./policy）。
 * 缓存只是磁盘的副本：每次落盘成功后才替换缓存，因此读不到写了一半的状态。
 * 任何一步失败都原样抛出，由路由归一成内部错误；不静默丢用户的待办。
 * @module dsh-pet/src/host/todo/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cloneTodo, parseTodoFile, sortTodos, TODO_FILE_VERSION, type TodoFile, type TodoRecord } from './types.ts';
import type { LoggerLike } from '../log-file.ts';

/** 一次更新的字段：没出现的键保持不变。 */
export interface TodoPatch {
  text?: string;
  dueAt?: number | null;
  done?: boolean;
}

/** 构造入参。 */
export interface TodoStoreOptions {
  /** 待办文件绝对路径（父目录不存在时自动创建）。 */
  file: string;
  /** 读取与写盘失败的告警出口。 */
  log: LoggerLike;
  /** 时间源；测试注入固定时钟。 */
  now?: () => number;
}

/** 异常 → 一行可读原因（日志用，不外泄给 HTTP 响应）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class TodoStore {
  declare private readonly file: string;
  declare private readonly log: LoggerLike;
  declare private readonly now: () => number;
  /** 串行队列：所有读写排队，避免读改写交错。 */
  declare private queue: Promise<void>;
  /** 磁盘内容的进程内副本；null = 还没读过。 */
  declare private cached: TodoRecord[] | null;
  /** 同一毫秒内建多条时的序号。 */
  declare private seq: number;

  constructor(options: TodoStoreOptions) {
    this.file = options.file;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
    this.queue = Promise.resolve();
    this.cached = null;
    this.seq = 0;
  }

  /** 全部待办（排序后的副本）。 */
  list(): Promise<TodoRecord[]> {
    return this.run(async () => {
      await this.ensureLoaded();
      return sortTodos(this.cached ?? []).map(cloneTodo);
    });
  }

  /**
   * 新建一条。
   *
   * id 由时间戳 + 进程内序号生成：重启后时间戳不同，旧 id 不会撞。
   *
   * @param input - 已校验的正文与到期时刻。
   * @returns 落盘成功后的记录副本。
   */
  create(input: { text: string; dueAt: number | null }): Promise<TodoRecord> {
    return this.run(async () => {
      await this.ensureLoaded();
      const at = this.now();
      this.seq += 1;
      const todo: TodoRecord = {
        id: `todo-${at.toString(36)}-${this.seq.toString(36)}`,
        text: input.text,
        dueAt: input.dueAt,
        done: false,
        createdAt: at,
        updatedAt: at,
        completedAt: null,
        lastRemindedAt: null,
      };
      await this.persist([...(this.cached ?? []), todo]);
      return cloneTodo(todo);
    });
  }

  /**
   * 更新一条。
   *
   * 改期限或重新打开都会清空 `lastRemindedAt`：提醒按新的到期时刻重新排期。
   *
   * @returns 更新后的记录；id 不存在返回 null。
   */
  update(id: string, patch: TodoPatch): Promise<TodoRecord | null> {
    return this.run(async () => {
      await this.ensureLoaded();
      const list = this.cached ?? [];
      const index = list.findIndex((todo) => todo.id === id);
      if (index < 0) return null;
      const prev = list[index]!;
      const at = this.now();
      const next: TodoRecord = { ...prev, updatedAt: at };
      if (patch.text !== undefined) next.text = patch.text;
      if (patch.dueAt !== undefined) {
        next.dueAt = patch.dueAt;
        next.lastRemindedAt = null;
      }
      if (patch.done !== undefined) {
        next.done = patch.done;
        next.completedAt = patch.done ? (prev.completedAt ?? at) : null;
        if (!patch.done) next.lastRemindedAt = null;
      }
      const updated = [...list];
      updated[index] = next;
      await this.persist(updated);
      return cloneTodo(next);
    });
  }

  /**
   * 删除一条。
   *
   * @returns 删掉的条数；0 表示本来就没有（幂等，不当成错误）。
   */
  remove(id: string): Promise<number> {
    return this.run(async () => {
      await this.ensureLoaded();
      const list = this.cached ?? [];
      const next = list.filter((todo) => todo.id !== id);
      if (next.length === list.length) return 0;
      await this.persist(next);
      return 1;
    });
  }

  /** 记下一次提醒时刻：只动 `lastRemindedAt`，不推进 `updatedAt`（那不是用户修改）。 */
  markReminded(id: string, at: number): Promise<void> {
    return this.run(async () => {
      await this.ensureLoaded();
      const list = this.cached ?? [];
      const index = list.findIndex((todo) => todo.id === id);
      if (index < 0) return;
      const next = [...list];
      next[index] = { ...list[index]!, lastRemindedAt: at };
      await this.persist(next);
    });
  }

  /** 队列：上一个任务结束后执行下一个；失败不影响后续任务。 */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cached !== null) return;
    this.cached = await this.readDisk();
  }

  private async readDisk(): Promise<TodoRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn?.(`[dsh-pet] 待办文件读取失败，按空清单继续：${messageOf(error)}`);
      }
      return [];
    }
    try {
      return parseTodoFile(JSON.parse(raw));
    } catch (error) {
      // 坏文件不备份、不改写：先按空清单跑，下一次写入自然覆盖。
      this.log.warn?.(`[dsh-pet] 待办文件解析失败，按空清单继续：${messageOf(error)}`);
      return [];
    }
  }

  /** 原子写：临时文件写完再 rename，进程中途退出不会留下半个 JSON。 */
  private async persist(next: readonly TodoRecord[]): Promise<void> {
    const file: TodoFile = { version: TODO_FILE_VERSION, todos: [...next] };
    await mkdir(dirname(this.file), { recursive: true });
    const temp = this.file + '.tmp';
    await writeFile(temp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    await rename(temp, this.file);
    this.cached = [...next];
  }
}
