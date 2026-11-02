/**
 * 工作状态联动（host 半侧，自包含，不 import src/shared）。
 *
 * 负责监听 DSH 的 session/event，把会话事件压缩成「当前活动工作状态」并按会话聚合，
 * 由调用方写进 sections.workStatus，两端轮询 /state 后按 counter 变化渲染。
 * 只做聚合与去重：状态无变化不产生新输出（签名比对防刷屏），不调用任何模型。
 * 依赖会话事件与调用方维护的 turn 上下文；不负责档位文案与动画，那些在两端消费侧。
 * 始终成立：档位顺序与 animations.events.workStatus 数组索引严格一致，不在中间插入。
 * 契约见 API.md 与 openapi.yaml。
 *
 * @module dsh-pet/src/host/work-status
 */

/** 工作状态档位（数组索引 = events.workStatus 档位；顺序与 shared/work-status.ts 一致）。 */
export const HOST_WORK_STATUS_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const;
export type HostWorkStatusState = (typeof HOST_WORK_STATUS_STATES)[number];

/**
 * 回合结束原因 → 档位：completed → success，错误系（error / max-tokens / timeout）→ error，
 * blocked → waiting；其余（aborted 等）→ null，由调用方清理会话回空闲——残留上一档会让回合被
 * 打断后永远卡在 working。
 */
function turnEndState(kind: string): HostWorkStatusState | null {
  if (kind === 'completed') return 'success';
  if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error';
  if (kind === 'blocked') return 'waiting';
  return null;
}

/** ask_user_question 工具名：模型在等用户选择题答复 → 归为 waiting（等待确认）而非普通工作。 */
const USER_QUESTION_TOOL = 'ask_user_question';

/** update_goal 工具名：目标工具，action=complete/blocked = 本轮是该目标任务的收尾轮。 */
export const GOAL_UPDATE_TOOL = 'update_goal';

/** 本 turn 的 turn 级标志（goal 续跑轮判定；不参与展示，由调用方维护）。 */
export interface WorkStatusTurnContext {
  /** 本轮是否为自动目标续跑轮（user/message source.kind==='goal' 时置位，turn/start 清零）。 */
  goalRound?: boolean;
  /** 本轮是否调用过 update_goal 收尾（'complete' | 'blocked'；undefined/null = 未收尾）。 */
  closing?: 'complete' | 'blocked' | null;
}

/** 解析 update_goal 的 arguments（原始 JSON 字符串）→ 收尾动作；解析失败 / 非收尾动作返回 null。 */
export function goalUpdateAction(args: string): 'complete' | 'blocked' | null {
  try {
    const o = JSON.parse(args) as { action?: unknown } | null;
    const action = String(o?.action ?? '');
    if (action === 'complete' || action === 'blocked') return action;
  } catch {
    /* 非法 JSON：按未收尾处理 */
  }
  return null;
}

/**
 * turn/end completed 的终局判定：非 goal 轮直接 success；自动续跑轮的中间轮 → result（本轮完成
 * 不等于整个任务完成，不庆祝）；收尾轮 complete → success，blocked → error（目标被阻塞结束，
 * 诚实地表沮丧而非庆祝）。
 */
export function completedState(turn: WorkStatusTurnContext | undefined): HostWorkStatusState {
  if (!turn?.goalRound) return 'success';
  if (turn.closing === 'blocked') return 'error';
  if (turn.closing === 'complete') return 'success';
  return 'result';
}

/** 从会话事件压缩出工作状态；无变化 / 不关心返回 null。
 *  turn 为当前回合上下文（goal 续跑轮判定），只影响 turn/end completed 的终局语义。 */
export function reduceWorkStatus(
  event: {
    type?: string;
    data?: Record<string, unknown> & { reason?: { kind?: string } };
  },
  turn?: WorkStatusTurnContext,
): HostWorkStatusState | null {
  switch (event?.type) {
    case 'turn/start':
      return 'thinking';
    case 'tool/call': {
      // 问用户问题的工具（选择题弹窗）＝ 等用户答复，不是普通干活
      if (String(event?.data?.name ?? '') === USER_QUESTION_TOOL) return 'waiting';
      return 'working';
    }
    case 'tool/result':
      return 'result';
    case 'approval/asked':
      return 'waiting';
    case 'turn/end': {
      // completed→success、错误系→error、blocked→waiting；其余（aborted 等）→null＝清该会话回空闲
      const reason = turnEndState(String(event?.data?.reason?.kind ?? ''));
      // 本轮完成是否等于整个任务完成交给 completedState（goal 续跑轮的中间轮不庆祝）
      if (reason === 'success') return completedState(turn);
      return reason;
    }
    default:
      return null; // todo/write 等：不切动画（详情文案由调用方另行处理）
  }
}

/**
 * 任务详情文案长度上限（按码点计，超出截断加省略号）：气泡最大宽度只有 0.5×宠物宽
 * （默认 size 462 时约 231px，字号 21px 约一行 11 个汉字），而清单原文动辄几十字，不截断会把
 * 气泡撑成好几行、盖住宠物。截断放在 host 这一处，两端天然一致。
 */
export const TASK_TEXT_MAX = 40;

/**
 * todo/write 的 in_progress/pending 项文本 → 任务详情；null = 清单已全部完成。
 *
 * 取最后一个 in_progress 而不是第一个：agent 常把新步骤标成 in_progress 却忘了把上一步标
 * completed，取第一个会永远停在最早那步。没有进行中的项时回落到第一个 pending（下一步要做的）。
 */
export function currentTaskFromTodo(event: {
  data?: { todos?: Array<{ status?: string; content?: string }> };
}): string | null {
  const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
  let current: { status?: string; content?: string } | undefined;
  for (const t of todos) {
    if (t?.status === 'in_progress') current = t;
  }
  if (!current) current = todos.find((t) => t?.status === 'pending');
  const content = String(current?.content ?? '').trim();
  if (!content) return null;
  // 按码点切，避免把代理对（emoji 等）截成半个字符
  const points = Array.from(content);
  return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join('')}…` : content;
}

/** 工作状态快照（= /state 里 sections.workStatus 的 data）：state 为主状态；task 为 todo 详情（可 null）。 */
export interface WorkStatusSnapshot {
  state: HostWorkStatusState | null; // null = 尚无会话活动（空闲）
  task: string | null; // 当前任务详情（todo/write 提供，可 null）
  /** 当前展示条目所属会话；空闲或外部槽（`api`）时为 null，客户端据此决定气泡能不能点。 */
  sessionId: string | null;
  ts: number; // 最近一次变化的时间戳（轮询侧据此检测变化）
}

/** 每会话聚合条目。 */
export interface SessionWorkEntry {
  /** 该会话当前档位。 */
  state: HostWorkStatusState;
  /** 该会话最近事件的序号，同档位时按它取最近。 */
  seq: number;
  /** 任务详情文案；null = 该会话没有清单。 */
  task: string | null;
  /** 该条目所属会话；`pickDisplayed` 只遍历 values，所以带着它才能知道展示的是哪一条。 */
  sessionId: string;
}

/** 展示优先级：waiting > error > working > thinking > result > success。
 *  result 高于 success：任何会话的进行中过渡态都不被别处已完成态压过，防中途庆祝；同档按最近更新优先。 */
export const WORK_STATUS_PRIORITY: Record<HostWorkStatusState, number> = {
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20,
};

/** 展示用条目：所有会话里优先级最高者（同优先级取 seq 更大者）；无会话返回 undefined。 */
export function pickDisplayed(entries: Iterable<SessionWorkEntry>): SessionWorkEntry | undefined {
  let best: SessionWorkEntry | undefined;
  for (const entry of entries) {
    if (
      !best ||
      WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] ||
      (WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq)
    ) {
      best = entry;
    }
  }
  return best;
}

/**
 * 工作状态聚合（纯逻辑，可单测）：按会话维护 state / task，对外只暴露一个展示快照。
 *
 * task 必须挂在会话条目上：挂成全局单值就没有独立于 todo/write 的生命周期，写过一次会跟着此后
 * 所有会话活动一直显示，连配置里的 workStatusTexts 档位文案也被永久屏蔽。挂进条目后文案与它的
 * 会话同生共死：条目被清、新一轮 turn/start、清单里再无进行中项，文案都会消失。
 * 展示时 state 与 task 取自同一个 best 会话，因此不会出现 A 会话的状态配 B 会话的文案。
 */
export class WorkStatusStore {
  // 类字段一律 declare + 构造器赋值：带初始化器的类字段在 target es2020 下要被降级，
  // 降级产物会 import 未声明的 @oxc-project/runtime helper——宿主加载插件树时直接
  // ERR_MODULE_NOT_FOUND，整个 profile 起不来（scripts/prepack-check.js 第 8 项守着这条）。
  declare private readonly sessions: Map<string, SessionWorkEntry>;
  declare private readonly snap: WorkStatusSnapshot;

  constructor() {
    this.sessions = new Map();
    this.snap = { state: null, task: null, sessionId: null, ts: 0 };
  }

  /** 该会话当前是否有活动条目（决定 todo/write 是否还值得更新它的文案）。 */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** 该会话当前档位（无条目 / 已清返回 undefined）。 */
  stateOf(sessionId: string): HostWorkStatusState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /** 该会话当前任务详情（无条目返回 null）。 */
  taskOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.task ?? null;
  }

  /** 写会话状态（保留该会话已有的 task）；同状态且 seq 不更新则不写并返回 false（防刷屏）。 */
  setState(sessionId: string, state: HostWorkStatusState, seq = 0): boolean {
    const prev = this.sessions.get(sessionId);
    if (prev?.state === state && prev.seq >= seq) return false;
    this.sessions.set(sessionId, { state, seq, task: prev?.task ?? null, sessionId });
    this.refresh();
    return true;
  }

  /** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动（它不会被展示）。 */
  setTask(sessionId: string, task: string | null): boolean {
    const prev = this.sessions.get(sessionId);
    if (!prev || prev.task === task) return false;
    this.sessions.set(sessionId, { ...prev, task });
    this.refresh();
    return true;
  }

  /** 清掉某会话（回合结束 / 终态过期）：它的 task 一并消失，不会残留到后续活动里。 */
  clear(sessionId: string): boolean {
    if (!this.sessions.delete(sessionId)) return false;
    this.refresh();
    return true;
  }

  /** 展示快照（对象引用稳定，供 /work-status 直接序列化）。 */
  snapshot(): WorkStatusSnapshot {
    return this.snap;
  }

  /** 重算展示：state / task / sessionId 任一变化才更新 ts（轮询侧据此触发，两端都靠它刷新）。 */
  private refresh(): void {
    const best = pickDisplayed(this.sessions.values());
    const nextState = best?.state ?? null;
    const nextTask = best?.task ?? null;
    const nextSession = best?.sessionId ?? null;
    if (nextState === this.snap.state && nextTask === this.snap.task && nextSession === this.snap.sessionId) return;
    this.snap.state = nextState;
    this.snap.task = nextTask;
    this.snap.sessionId = nextSession;
    this.snap.ts = Date.now();
  }
}
