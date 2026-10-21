/**
 * host 侧系统通知帧生成（自包含，不 import src/shared —— DSH 单文件加载约束）。
 *
 * 背景：DSH 0.1.5 删除了浏览器侧 `api.events.mux / events.host` 两条 SSE 事件流
 * （0.1.1 时代的契约，dsh-pet 的 shared/notify.ts 帧映射正是按它写的），改用
 * `ctx.remote.$on('approval/request')` 等回调订阅——事件名与帧形状都变了。
 * 为不依赖 DSH 版本间变化的事件 API，这里改为 host 侧直接监听 DSH 宿主事件，
 * 生成**与 shared/notify.ts 完全同契约**的通知帧（帧形状零改动），写进 S 的
 * sections.notify，浏览器统一轮询 /state 后弹 toast（与其余叶子同族；单槽，后到覆盖先到）。
 *
 * 事件源（全部来自 `session/event` 宿主事件 + `agent/error` 宿主事件）：
 *   - turn/end（completed → 对话完成 / error → 生成失败 / max-tokens → 输出截断；
 *     aborted 等不弹，与 shared 的过滤语义一致）
 *   - approval/asked（权限申请：toolName / reason）
 *   - tool/call（ask_user_question 工具：解析 arguments 里的 questions → 用户选择）
 *   - agent/error（无回合位置的生成失败，0.1.5 新增；旧版无此事件 = 少一条通知，不报错）
 *
 * 会话门（issue #82）：`session/event` 的四类事件先过 shouldNotifySession——
 * 子代理 / 委派会话（origin=subagent、delegationDepth>0）不发，否则每路子代理跑完都弹一条。
 * 活动门（issue #114）：`turn/end completed`（「对话完成」）在**推帧前**还要确认这条会话确实没有
 * 在跑的活——在跑的下属 / 团队成员、后台任务、活跃提醒任一非空则丢弃这一帧（见 hasBlockingActivity）。
 * 判据由调用方延迟后经 `workspace/session-activity` 取得，拿不到就放行。
 * 注意 `agent/error` **过不了这道门**：它的载荷只有 { turn, step, error }，不带任何会话标识，
 * 宿主的 throwError 也没有传会话进来（dsh-agent-loop）。子代理的生成失败若走这条路径仍会弹，
 * 要根治得让宿主把会话带进载荷。
 */

/** 通知帧（与 shared/notify.ts 的 NotifyFrame 同形状；host 侧自包含定义，避免跨端 import） */
export interface HostNotifyFrame {
  type: string;
  [key: string]: unknown;
}

/** 会话参数（`ctx.on('session/event')` 第一个实参）里与本判定相关的字段，全部宽松读取 */
interface NotifySessionLike {
  id?: unknown;
  header?: { id?: unknown; origin?: unknown; delegationDepth?: unknown } | null;
}

/**
 * 这条会话的事件该不该变成通知。
 *
 * 子代理（`origin === 'subagent'`）与更深层委派（`delegationDepth > 0`）一律不发：
 * 你等的是父对话，不是某一路子代理跑完。实测 3 个子代理会连弹 3 条「对话完成」，
 * 而宿主的 298 条会话里 198 条是子代理——通知直接变刷屏（issue #82）。
 *
 * **判据必须是 `origin`，绝不能用 `parentSession`。** 宿主 `parentSession` 的语义是
 * "fork 自哪条会话"（SessionHeader 注释原文：*the session this one was forked from*），
 * 普通 fork 也带它——本机实测正在对话的那条主会话就是 fork，`parentSession` 有值而
 * `origin` 为空。用它判子代理会把主对话一起静音。官方 dsh-subagent 的归档准入是同一套判据：
 * *"A fork shares the lineage field without the origin"*（archive-admission.js）。
 *
 * 判据不可用（session / header 缺失或形状不对）→ **放行**：宁可多弹一条，
 * 也不能因为宿主换了字段形状就让通知整体失效。
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
 * 把会话 id 附到通知帧上 —— 点击通知时网页据此跳到那条会话（客户端 `uiWorkspace.openSession`）。
 *
 * `sessionIdOf` 的兜底值是字符串 `'unknown'`（它同时是活动门定时器的 Map 键，必须有值），
 * 但那不是一条真会话，不能拿去跳转：只有真 id 才写进帧，取不到就原样返回，点击退化成
 * 「只把窗口叫回前台」——与「判据不可用时放行」同一条兜底原则。
 */
export function withSessionId(frame: HostNotifyFrame, sessionId: string): HostNotifyFrame {
  return sessionId === 'unknown' ? frame : { ...frame, sessionId };
}

/**
 * 这一条事件是不是「对话完成」——活动门（issue #114）只拦它。
 *
 * 只认 `turn/end` + `reason.kind === 'completed'`：生成失败 / 输出截断（error / max-tokens）是
 * "真出事了"的信息，权限申请与用户选择是等人操作的提醒——都不该因为还有活在跑而静默。
 */
export function isCompletionTurnEnd(event: unknown): boolean {
  const e = event as { type?: unknown; data?: { reason?: { kind?: unknown } } } | null;
  return e?.type === 'turn/end' && e.data?.reason?.kind === 'completed';
}

/**
 * 活动门（issue #114）：这条会话还有没有在跑的活——入参是宿主 `workspace/session-activity`
 * waterfall 的答案（各族条目的数组）。
 *
 * 只看三族：
 *   - `job`      该会话名下运行中 / 停止中的后台任务
 *   - `subagent` 在跑的下属子代理，**以及 Agent Teams 的团队成员**（成员走子代理通道创建，
 *                按血缘记在这一族里——团队会话的误报正是它）
 *   - `schedule` 活跃的定时提醒
 *
 * **故意不看 `turn`**：触发这一帧的就是该会话回合的结束，而 `turn` 族读的是活 Agent 的 `status`
 * ——`turn/end` 在回合体的 finally 里追加时它自己仍是 running，算进来会把每一条「对话完成」都
 * 自己挡掉（调用方为此必须**延迟**再查）。语义上也不吃亏：同一会话不会有第二个回合。
 *
 * 形状不对 / 空 / 非数组 / 未知族 → false＝放行：与「判据不可用时放行」同一策略，宁可多弹一条，
 * 也不能因为宿主加了一族或改了字段就让通知整体失效。
 */
export function hasBlockingActivity(activity: unknown): boolean {
  if (!Array.isArray(activity)) return false;
  for (const item of activity) {
    const kind = (item as { kind?: unknown } | null)?.kind;
    if (kind === 'job' || kind === 'subagent' || kind === 'schedule') return true;
  }
  return false;
}

/** turn/end reason.kind → 通知类别；不弹的分支返回 null（与 shared/notify.ts 过滤一致） */
export function turnEndNotifyKind(kind: string | undefined): 'completed' | 'error' | 'max-tokens' | null {
  if (kind === 'completed') return 'completed';
  if (kind === 'error' || kind === 'max-tokens') return kind;
  // aborted（用户/父代理取消）、interrupted（崩溃恢复）、blocked（等确认）等：不弹
  return null;
}

/** ask_user_question 工具名（与 work-status.ts 同源；该工具触发时模型在等用户选择题答复） */
const USER_QUESTION_TOOL = 'ask_user_question';

/** 解析 tool/call 的 arguments（JSON 字符串）→ questions 数组；解析失败/非数组 → null */
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
 * 把一条 session/event 子事件压缩成通知帧；不关心/过滤型事件返回 null。
 * 帧形状与 shared/notify.ts 的 frameToToast 期望完全一致（浏览器侧映射零改动）。
 * data 按宽松 Record 接收（approval/asked 的 reason 是字符串、turn/end 的是对象），内部各自安全取值。
 */
export function reduceNotifyFrame(event: { type?: string; data?: Record<string, unknown> }): HostNotifyFrame | null {
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
          data: { reason },
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

/** agent/error（无回合位置的失败）→ host/agent-error 帧（与 shared 期望的 message 字段一致） */
export function agentErrorFrame(error: unknown): HostNotifyFrame {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '');
  return { type: 'host/agent-error', message };
}
