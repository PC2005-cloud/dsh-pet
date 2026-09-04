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

/** 从会话事件压缩出工作状态；无变化/不关心返回 null */
export function reduceWorkStatus(event: {
  type?: string;
  data?: Record<string, unknown> & { reason?: { kind?: string } };
}): HostWorkStatusState | null {
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
      return turnEndState(String(event?.data?.reason?.kind ?? ''));
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
