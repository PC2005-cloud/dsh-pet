/**
 * 工作状态联动：档位常量与快照解析。
 * 宿主半侧有自包含的实现（DSH 单文件加载约束，宿主不 import 本目录），负责监听 DSH 会话事件
 * 聚合成快照并写进 /state 的 sections.workStatus；本模块只有档位常量与叶子解析。
 * 气泡文案不在代码里：浏览器半侧直接读配置的 events.workStatusTexts。纯函数无副作用，不依赖 React / DOM。
 * @module dsh-pet/src/shared/work-status
 */

/** 工作状态档位（对应 animations.events.workStatus 数组索引，顺序即档位，勿在中间插入新档）。 */
export const WORK_STATUS_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const;
export type WorkStatusState = (typeof WORK_STATUS_STATES)[number];

/** 档位 → workStatus 数组索引（与 events.workStatus 的顺序严格一致）。 */
export const WORK_STATUS_INDEX: Record<WorkStatusState, number> = {
  thinking: 0, // turn/start → 思考
  working: 1, // tool/call → 工作
  result: 2, // tool/result → 整理
  waiting: 3, // approval/asked → 等待
  success: 4, // turn/end completed → 完成
  error: 5, // turn/end error/max-tokens → 出错
};

/** 工作状态快照（= /state 里 sections.workStatus 的 data，与宿主半侧的同构）。
 *  没有 ts：「变了没有」由叶子的 counter 承担；text 不在此——气泡文案由客户端读配置，宿主不生成。 */
export interface WorkStatusSnapshot {
  state: WorkStatusState | null; // null = 空闲
  task: string | null; // 当前任务详情（todo/write 提供，可 null）
  /** 当前展示条目所属会话；空闲 / 外部槽 / 老版本宿主缺该字段时都不出现，气泡因此不可点。 */
  sessionId?: string | null;
}

/** 快照解析：档位不认识 → 归一成 null（空闲）；形状非法 → null，消费端跳过这一拍。 */
export function toWorkStatus(raw: unknown): WorkStatusSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { state?: unknown; task?: unknown; sessionId?: unknown };
  const state: WorkStatusState | null =
    r.state === null || (typeof r.state === 'string' && (WORK_STATUS_STATES as readonly string[]).includes(r.state))
      ? (r.state as WorkStatusState | null)
      : null;
  const sessionId =
    typeof r.sessionId === 'string' && r.sessionId !== '' && r.sessionId !== 'unknown' ? r.sessionId : null;
  return { state, task: typeof r.task === 'string' ? r.task : null, sessionId };
}
