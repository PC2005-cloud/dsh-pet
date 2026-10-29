/**
 * 宿主半侧的系统通知帧生成（自包含，不 import src/shared——DSH 单文件加载约束）。
 *
 * 监听 DSH 宿主事件（`session/event` 的 turn/end、approval/asked、tool/call，以及 `agent/error`），
 * 生成与 shared/notify.ts 同契约的帧写进 S 的 sections.notify，浏览器轮询 /state 后弹 toast
 * （与其余叶子同族：单槽，后到覆盖先到）。不负责去重与展示。
 * 必须始终成立：推帧前先过两道门——会话门（子代理与深层委派不发）与活动门（还有活在跑时
 * 「对话完成」不发）；判据拿不到一律放行，宁可多弹一条，也不能让通知整体失效。
 * 契约见 API.md 与 openapi.yaml。
 * @module dsh-pet/src/host/notify-events
 */

/** 通知帧（与 shared/notify.ts 的 NotifyFrame 同形状；宿主半侧自包含定义，避免跨端 import）。 */
export interface HostNotifyFrame {
  type: string;
  [key: string]: unknown;
}

/** 会话参数（`ctx.on('session/event')` 第一个实参）里与本判定相关的字段，全部宽松读取。 */
interface NotifySessionLike {
  id?: unknown;
  header?: { id?: unknown; origin?: unknown; delegationDepth?: unknown } | null;
}

/**
 * 这条会话的事件该不该变成通知。
 *
 * 子代理（`origin === 'subagent'`）与更深层委派（`delegationDepth > 0`）一律不发：你等的是父对话，
 * 不是某一路子代理跑完（实测 3 个子代理会连弹 3 条「对话完成」）。
 * 判据必须是 `origin`，绝不能用 `parentSession`——后者的语义是「fork 自哪条会话」，普通 fork 也带
 * 它，用它判子代理会把主对话一起静音（官方 dsh-subagent 的归档准入是同一套判据）。
 * 判据不可用（session / header 缺失或形状不对）→ 放行：宿主换字段形状不该让通知整体失效。
 */
export function shouldNotifySession(session: unknown): boolean {
  const header = (session as NotifySessionLike | null)?.header;
  if (!header || typeof header !== 'object') return true;
  if (header.origin === 'subagent') return false;
  const depth = header.delegationDepth;
  if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return false;
  return true;
}

/** 会话 id（活动门的定时器以它为键）：`header.id` 优先，回落顶层 `id`，都取不到用 'unknown'
 *  （与 index.ts work-status 侧的取法一致）。 */
export function sessionIdOf(session: unknown): string {
  const s = session as { id?: unknown; header?: { id?: unknown } | null } | null;
  return String(s?.header?.id ?? s?.id ?? 'unknown');
}

/**
 * 把会话 id 附到通知帧上——点击通知时网页据此跳到那条会话（客户端 `uiWorkspace.openSession`）。
 *
 * 回落值 `'unknown'` 不是真会话，不能拿去跳转：只有真 id 才写进帧，取不到就原样返回，点击退化成
 * 「只把窗口叫回前台」。`'unknown'` 仍是活动门定时器的 Map 键，必须存在。
 */
export function withSessionId(frame: HostNotifyFrame, sessionId: string): HostNotifyFrame {
  return sessionId === 'unknown' ? frame : { ...frame, sessionId };
}

/**
 * 这一条事件是不是「对话完成」——活动门只拦它。
 *
 * 只认 `turn/end` + `reason.kind === 'completed'`：生成失败 / 输出截断是「真出事了」，权限申请与
 * 用户选择是在等人操作，都不该因为还有活在跑而静默。
 */
export function isCompletionTurnEnd(event: unknown): boolean {
  const e = event as { type?: unknown; data?: { reason?: { kind?: unknown } } } | null;
  return e?.type === 'turn/end' && e.data?.reason?.kind === 'completed';
}

/**
 * 活动门：这条会话还有没有在跑的活——入参是宿主 `workspace/session-activity` waterfall 的答案
 * （各族条目的数组）。
 *
 * 只看 `job`（后台任务）、`subagent`（在跑的子代理与 Agent Teams 团队成员，成员按血缘记在这一族）、
 * `schedule`（活跃的定时提醒）。故意不看 `turn`：触发这一帧的就是该会话回合的结束，而 `turn` 读的是
 * 活 Agent 的 `status`，那时它自己仍是 running，算进来会把每一条「对话完成」都自己挡掉。
 * 形状不对 / 空 / 非数组 / 未知族 → 放行：宿主加一族或改字段不该让通知整体失效。
 */
export function hasBlockingActivity(activity: unknown): boolean {
  if (!Array.isArray(activity)) return false;
  for (const item of activity) {
    const kind = (item as { kind?: unknown } | null)?.kind;
    if (kind === 'job' || kind === 'subagent' || kind === 'schedule') return true;
  }
  return false;
}

/** 回复开头在会话状态里的缓存上限：只用于一条 toast，留太长没有意义。 */
const MAX_REPLY_TEXT = 200;

/**
 * 从一条 `assistant/message` 事件里取最后一段文本，压平空白并截断。
 *
 * 只认 `data.message.content[]` 里最后一个 `{ type: 'text' }` 块：reasoning 块与工具块不是给用户看的，
 * 混进来只会把内部过程推上锁屏。取不到、形状不对一律返回 null（放行而不是报错）。
 */
export function lastAssistantText(event: { type?: string; data?: Record<string, unknown> }): string | null {
  if (event?.type !== 'assistant/message') return null;
  const content = (event.data as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (!Array.isArray(content)) return null;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i] as { type?: unknown; text?: unknown } | null;
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const text = block.text.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    return text.length > MAX_REPLY_TEXT ? text.slice(0, MAX_REPLY_TEXT) : text;
  }
  return null;
}

/** turn/end reason.kind → 通知类别；不弹的分支返回 null（与 shared/notify.ts 过滤一致）。 */
export function turnEndNotifyKind(kind: string | undefined): 'completed' | 'error' | 'max-tokens' | null {
  if (kind === 'completed') return 'completed';
  if (kind === 'error' || kind === 'max-tokens') return kind;
  // aborted（用户/父代理取消）、interrupted（崩溃恢复）、blocked（等确认）等不弹
  return null;
}

/** ask_user_question 工具名（与 work-status.ts 同源；该工具触发时模型在等用户答复）。 */
const USER_QUESTION_TOOL = 'ask_user_question';

/** 解析 tool/call 的 arguments（JSON 字符串）→ questions 数组；解析失败或非数组 → null。 */
export function parseToolQuestions(args: unknown): Array<{ question?: string }> | null {
  if (typeof args !== 'string') return null;
  try {
    const parsed = JSON.parse(args) as { questions?: unknown } | null;
    const questions = parsed?.questions;
    if (!Array.isArray(questions)) return null;
    return questions as Array<{ question?: string }>;
  } catch {
    return null;
  }
}

/**
 * 把一条 session/event 子事件压缩成通知帧；不关心或被过滤的事件返回 null。
 * 帧形状与 shared/notify.ts 的 frameToToast 期望完全一致（浏览器侧映射零改动）。
 * data 按宽松 Record 接收（approval/asked 的 reason 是字符串、turn/end 的是对象），内部各自安全取值。
 *
 * @param event - 会话子事件。
 * @param replyText - 本回合最后一段回复的开头；只在 completed 时挂进帧，缺省则不写该字段。
 */
export function reduceNotifyFrame(
  event: { type?: string; data?: Record<string, unknown> },
  replyText?: string,
): HostNotifyFrame | null {
  if (!event?.type) return null;
  switch (event.type) {
    case 'turn/end': {
      const reason = event.data?.reason as { kind?: string; error?: { message?: string } } | undefined;
      const kind = turnEndNotifyKind(reason?.kind);
      if (!kind) return null;
      return {
        type: 'session/event',
        event: {
          type: 'turn/end',
          // 完成时把最后一条回复的开头一并带走：通知正文因此能显示内容而不是只有状态。
          data: kind === 'completed' && replyText ? { reason, text: replyText } : { reason },
        },
      };
    }
    case 'approval/asked': {
      const data = event.data ?? {};
      return {
        type: 'approval/requested',
        ...(typeof data.toolName === 'string' && data.toolName ? { toolName: data.toolName } : {}),
        ...(typeof data.reason === 'string' && data.reason ? { reason: data.reason } : {}),
      };
    }
    case 'tool/call': {
      if (String(event.data?.name ?? '') !== USER_QUESTION_TOOL) return null;
      const questions = parseToolQuestions(event.data?.arguments);
      if (!questions || questions.length === 0) return null;
      return { type: 'question/requested', questions };
    }
    default:
      return null;
  }
}

/**
 * agent/error（无回合位置的失败）→ host/agent-error 帧（与 shared 期望的 message 字段一致）。
 * 它的载荷只有 { turn, step, error }，不带会话标识，过不了会话门——子代理的生成失败仍会弹；
 * 要根治得让宿主把会话带进载荷。
 */
export function agentErrorFrame(error: unknown): HostNotifyFrame {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '');
  return { type: 'host/agent-error', message };
}
