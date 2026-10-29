/**
 * 待办提醒循环：定时挑一条到点的待办，让当前可见的桌宠说一句。
 *
 * 不决定节奏与文案（归 ../todo/policy），也不读写文件（归 ../todo/store）。
 * 每拍最多说一条，避免多条同时到期时刷屏；写进 S 之后才记 lastRemindedAt，重启不会重复。
 * 没有可见宠物或被第三方占用时跳过且不推进——条件满足后的下一拍立刻补上，这次提醒不会丢。
 * @module dsh-pet/src/host/plugin/todo-reminders
 */
import { pickReminder, reminderText } from '../todo/policy.ts';
import type { TodoStore } from '../todo/store.ts';
import type { LockStore } from '../lock.ts';
import type { PollStateStore } from '../state.ts';
import type { HostSetup } from './setup.ts';
import type { PetLookup } from './pet-lookup.ts';
import type { HostContext } from './context.ts';

/** 巡检查找间隔（ms）：比最短提醒间隔（5 分钟）小一档即可，不必更密。 */
const TICK_MS = 60 * 1000;

/** 提醒气泡停留时长（ms）：比默认 10 秒久一点，欠着的事值得多看两眼。 */
const BUBBLE_DURATION_MS = 15 * 1000;

/** 一拍所需的最小能力（与完整输入同形，便于测试替身）。 */
export interface TodoReminderTickDeps {
  /** 待办存储：读清单、记提醒时刻。 */
  todos: Pick<TodoStore, 'list' | 'markReminded'>;
  /** 当前生效的宠物列表（成品配置拍平）。 */
  effectivePetList: () => Record<string, unknown>[];
  /** 占用锁：被第三方占用的宠物这一拍不打扰。 */
  lock: Pick<LockStore, 'locked'>;
  /** 轮询状态：提醒写进 `pets.<id>.say`。 */
  state: Pick<PollStateStore, 'writePet'>;
  /** 日志出口。 */
  log: Pick<HostSetup['log'], 'info' | 'warn'>;
  /** 时间源；测试注入固定时钟。 */
  now?: () => number;
  /** 是否有端在线（长轮询在挂）。没有就不提醒：写进 S 也没人看见，还白白推进了排期。 */
  hasListener?: () => boolean;
}

/** 提醒循环的输入。 */
export type TodoReminderInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
  /** 当前挂着长轮询的端数量：>0 表示有人能看到这次提醒。 */
  waiterCount: () => number;
} & Pick<PetLookup, 'lock'> &
  Pick<TodoReminderTickDeps, 'todos' | 'effectivePetList' | 'state' | 'log'>;

/**
 * 挑一个承担这次提醒的宠物：优先网页端可见的，其次桌面端；被第三方占用的跳过。
 *
 * @param pets - 成品配置拍平后的宠物列表。
 * @param isLocked - 该宠物是否正被占用。
 * @returns 宠物 id；没有可用的返回 null。
 * @internal
 */
export function pickReminderSpeaker(
  pets: readonly Record<string, unknown>[],
  isLocked: (petId: string) => boolean,
): string | null {
  let desktopOnly: string | null = null;
  for (const pet of pets) {
    const petId = String(pet.id ?? '');
    if (petId === '') continue;
    if (pet.display === 'none') continue;
    if (isLocked(petId)) continue;
    if (pet.display === 'web' || pet.display === 'both') return petId;
    desktopOnly ??= petId;
  }
  return desktopOnly;
}

/**
 * 跑一拍：最多提醒一条，成功后记下提醒时刻。
 *
 * @param deps - 存储、宠物列表、锁与状态写入。
 * @returns 无返回值；没有到点或没有可开口的宠物时静默返回。
 */
export async function tickTodoReminders(deps: TodoReminderTickDeps): Promise<void> {
  // 没有端在线时整拍跳过、不推进 lastRemindedAt：下一次有人连上时还是「到点」状态。
  if (deps.hasListener !== undefined && !deps.hasListener()) return;
  const now = deps.now?.() ?? Date.now();
  const due = pickReminder(await deps.todos.list(), now);
  if (due === null) return;
  const speaker = pickReminderSpeaker(deps.effectivePetList(), (petId) => deps.lock.locked(petId));
  if (speaker === null) return;
  deps.state.writePet(speaker, 'say', { text: reminderText(due.todo, now), duration: BUBBLE_DURATION_MS });
  await deps.todos.markReminded(due.todo.id, now);
  // 只记 id 与剩余时长：待办正文是用户内容，不进日志。
  const remainingSec = due.todo.dueAt === null ? 0 : Math.round((due.todo.dueAt - now) / 1000);
  deps.log.info(`[dsh-pet] 待办提醒 todo=${due.todo.id} pet=${speaker} 剩余=${remainingSec}s`);
}

/**
 * 注册提醒循环；返回的清理函数由 ctx.effect 收集。
 *
 * @param deps - 宿主上下文与一拍所需的能力。
 */
export function registerTodoReminders(deps: TodoReminderInput): void {
  const { ctx, effectivePetList, lock, log, state, todos, waiterCount } = deps;

  /** 一拍：失败只打日志，不让循环停摆。 */
  const tick = async (): Promise<void> => {
    try {
      await tickTodoReminders({
        effectivePetList,
        hasListener: () => waiterCount() > 0,
        lock,
        log,
        state,
        todos,
      });
    } catch (error) {
      log.warn('[dsh-pet] 待办提醒失败：' + (error instanceof Error ? error.message : String(error)));
    }
  };

  ctx.effect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** 排下一拍；已卸载就不再排。 */
    function arm(): void {
      if (disposed) return;
      timer = setTimeout(() => void run(), TICK_MS);
    }

    /** 跑一拍再排下一拍：启动即检查一次，不等第一个周期。 */
    async function run(): Promise<void> {
      timer = null;
      await tick();
      arm();
    }

    void run();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, 'dsh-pet: todo reminders');
}
