// 工作状态联动（workStatus）——浏览器侧纯逻辑（src/shared 单一来源）。
// host 侧（src/host/work-status.ts）有自己的自包含实现（DSH 单文件加载约束，host 不 import 本目录），
// 负责监听 session/event 聚合成快照并写进 /state 的 sections.workStatus；本模块只做：
//   档位常量（WORK_STATUS_STATES / WORK_STATUS_INDEX，与 events.workStatus 数组索引一致）+ 叶子解析。
//   气泡文案不在代码里：浏览器直接读配置 events.workStatusTexts（host 不内置文案）。
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

/** 工作状态快照（= /state 里 sections.workStatus 的 data，与 host 的 WorkStatusSnapshot 同构）。
 *  没有 ts：「变了没有」由叶子的 counter 承担（ts 是改造前的第二信号，已删）。
 *  text 不在此：气泡文案由客户端读配置 events.workStatusTexts，host 不生成。 */
export interface WorkStatusSnapshot {
  state: WorkStatusState | null; // null = 空闲
  task: string | null; // 当前任务详情（todo/write 提供，可 null）
}

/** 快照解析：档位不认识 → 归一成 null（空闲）；形状非法 → null（消费端跳过这一拍，不抛） */
export function toWorkStatus(raw: unknown): WorkStatusSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { state?: unknown; task?: unknown };
  const state: WorkStatusState | null =
    r.state === null || (typeof r.state === 'string' && (WORK_STATUS_STATES as readonly string[]).includes(r.state))
      ? (r.state as WorkStatusState | null)
      : null;
  return { state, task: typeof r.task === 'string' ? r.task : null };
}
