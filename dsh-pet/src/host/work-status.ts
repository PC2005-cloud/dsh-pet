/**
 * host 侧工作状态联动核心（自包含，不 import src/shared —— DSH 单文件加载约束）。
 *
 * 职责：监听 DSH `session/event`，把 6 类会话事件压缩成"当前活动工作状态"，供
 * `/dsh-pet-7340/work-status` 端点给浏览器轮询（与 balance/whisper 轮询同族）。
 * 只做聚合与去重：状态无变化不产生新输出（签名比对防刷屏）；不调用任何模型。
 *
 * 档位与 animations.events.workStatus 数组索引严格一致（顺序勿在中间插入）：
 *   0 thinking / 1 working / 2 result / 3 waiting / 4 success / 5 error
 */

/** 工作状态档位（数组索引 = events.workStatus 档位） */
export type HostWorkStatusState = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error';

/**
 * turn/end reason.kind → 状态：
 *   completed → success、错误系（error/max-tokens/timeout）→ error、blocked → waiting（回合被阻塞，等用户确认）；
 *   其余（aborted 等）→ null＝该会话回合已结束，由调用方清理会话回空闲——绝不残留上一档
 *   （否则回合被打断后会永远卡在 working，即当年"这一步正在进行中哦"挂死的根因）。
 */
function turnEndState(kind: string): HostWorkStatusState | null {
  if (kind === 'completed') return 'success';
  if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error';
  if (kind === 'blocked') return 'waiting';
  return null;
}

/** ask_user_question 工具名：模型在等用户选择题答复 → 归为 waiting（等待确认）而非普通工作 */
const USER_QUESTION_TOOL = 'ask_user_question';

/** update_goal 工具名：目标工具，action=complete/blocked = 本轮是该目标任务的收尾轮 */
export const GOAL_UPDATE_TOOL = 'update_goal';

/** 本 turn 的 turn 级标志（goal 续跑轮判定；不参与展示，由 index.ts 维护） */
export interface WorkStatusTurnContext {
  /** 本轮是否为自动目标续跑轮（user/message source.kind==='goal' 时置位，turn/start 清零） */
  goalRound?: boolean;
  /** 本轮是否调用过 update_goal 收尾（'complete' | 'blocked'；undefined/null = 未收尾） */
  closing?: 'complete' | 'blocked' | null;
}

/** 解析 update_goal 的 arguments（原始 JSON 字符串）→ 收尾动作；解析失败/非收尾动作 → null */
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
 * turn/end reason=completed 的终局判定：
 *   - 非 goal 轮（默认）→ success（原行为：一轮答完即成功）；
 *   - 自动续跑轮中间轮（goalRound && 未收尾）→ result：本轮完成 ≠ 整个任务完成，不庆祝；
 *   - 收尾轮 complete → success（整个目标达成，庆祝）；
 *   - 收尾轮 blocked → error（目标被阻塞结束，诚实地表沮丧而非庆祝）。
 */
export function completedState(turn: WorkStatusTurnContext | undefined): HostWorkStatusState {
  if (!turn?.goalRound) return 'success';
  if (turn.closing === 'blocked') return 'error';
  if (turn.closing === 'complete') return 'success';
  return 'result';
}

/** 从会话事件压缩出工作状态；无变化/不关心返回 null。
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
      // completed=本轮完成：是否等于整个任务完成交给 completedState 判定
      // （goal 自动续跑轮的中间轮 → result 不庆祝，避免"任务没完成却播成功"）
      if (reason === 'success') return completedState(turn);
      return reason;
    }
    default:
      return null; // todo/write 等：不切动画（详情文案由调用方另行处理）
  }
}

/** todo/write 的 in_progress/pending 项文本 → 任务详情；null = 无 */
export function currentTaskFromTodo(event: {
  data?: { todos?: Array<{ status?: string; content?: string }> };
}): string | null {
  const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
  const current = todos.find((t) => t?.status === 'in_progress') ?? todos.find((t) => t?.status === 'pending');
  const content = String(current?.content ?? '').trim();
  return content || null;
}

/** 工作状态快照（/work-status 端点响应体）：state 为主状态；task 为 todo 详情（可 null） */
export interface WorkStatusSnapshot {
  state: HostWorkStatusState | null; // null = 尚无会话活动（空闲）
  task: string | null; // 当前任务详情（todo/write 提供，可 null）
  ts: number; // 最近一次变化的时间戳（轮询侧检测变化用）
}
