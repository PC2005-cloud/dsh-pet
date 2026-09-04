// 工作状态联动（workStatus）——浏览器侧纯逻辑（src/shared 单一来源）。
// host 侧（src/host/work-status.ts）有自己的自包含实现（DSH 单文件加载约束，host 不 import 本目录），
// 负责监听 session/event 并通过 /dsh-pet-7340/work-status 端点提供聚合状态；本模块只做：
//   档位常量（WORK_STATUS_STATES / WORK_STATUS_INDEX，与 events.workStatus 数组索引一致）+ 轮询解析
//   （fetchWorkStatus）。气泡文案不在代码里：浏览器直接读配置 events.workStatusTexts（host 不内置文案）。
// 纯函数无副作用；不依赖 React/DOM。

/** 工作状态档位（对应 animations.events.workStatus 数组索引，顺序即档位，勿在中间插入新档） */
export const WORK_STATUS_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const;
export type WorkStatusState = (typeof WORK_STATUS_STATES)[number];

/** 档位 → workStatus 数组索引（与 events.workStatus 数组顺序严格一致） */
export const WORK_STATUS_INDEX: Record<WorkStatusState, number> = {
  thinking: 0, // turn/start → 思考
  working: 1, // tool/call → 工作
  result: 2, // tool/result → 整理
  waiting: 3, // approval/asked → 等待
  success: 4, // turn/end completed → 完成
  error: 5, // turn/end error/max-tokens → 出错
};

/** /dsh-pet-7340/work-status 响应（与 host 的 WorkStatusSnapshot 同构；两端按此结构校验）。
 *  text 不在此：气泡文案由浏览器读配置 events.workStatusTexts，host 不生成。 */
export interface WorkStatusSnapshot {
  state: WorkStatusState | null; // null = 空闲
  task: string | null; // 当前任务详情（todo/write 提供，可 null）
  ts: number; // 最近一次变化的时间戳（轮询侧检测变化用）
}

const TIMEOUT_MS = 10000;

/** 拉取当前工作状态快照；解析/网络失败显式抛错（上层决定，绝不静默伪造） */
export async function fetchWorkStatus(baseUrl: string = '/dsh-pet-7340/work-status'): Promise<WorkStatusSnapshot> {
  const res = await fetch(baseUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('dsh-pet: work-status HTTP ' + res.status);
  const raw: WorkStatusSnapshot = await res.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: work-status 响应非法');
  const state: WorkStatusState | null =
    raw.state === null || (WORK_STATUS_STATES as readonly string[]).includes(raw.state as string)
      ? (raw.state as WorkStatusState | null)
      : null;
  return {
    state,
    task: typeof raw.task === 'string' ? raw.task : null,
    ts: Number(raw.ts) || 0,
  };
}
