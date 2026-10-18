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

/**
 * 展示优先级（与 host 侧 WORK_STATUS_PRIORITY 同口径）：waiting > error > working >
 * thinking > result > success。客户端自持一份，避免为了一个数字把 host 逻辑搬进浏览器。
 */
export const WORK_STATUS_PRIORITY: Record<WorkStatusState, number> = {
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20,
};

/** 已播档位至少驻留这么久才允许被「降档」顶掉（升档与终态即时，不受此限） */
export const WORK_MIN_HOLD_MS = 1200;

/** 降档候选必须连续出现的拍数（/state 1s 一拍 ⇒ 约 2s 的稳定驻留才认） */
export const WORK_DEMOTE_TICKS = 2;

export type WorkTierDecision = 'accept' | 'hold';

export interface WorkTierInput {
  /** 当前正在播的档位（null = 空闲/首次） */
  shown: WorkStatusState | null;
  /** 当前档位起播时刻（ms，Date.now 口径） */
  shownAt: number;
  /** 这一拍上报的档位 */
  candidate: WorkStatusState;
  /** 候选档位连续出现的拍数（含本拍） */
  candTicks: number;
  now: number;
}

/**
 * 工作状态演出的滞回决策：把轮询拿到的「瞬时真相」整形为「可播出的档位」。
 *
 * 为什么需要它：后台工具密集调用时 tool/call 与 tool/result 会交替上报，照搬成换片就是
 * 每秒硬切一段 10s 的 webm —— 观感是闪烁与抖动。这里的规则只有三条：
 *   1. 空闲 → 任意、任意 → 终态（success/error）、升档：立即接受（反馈不能迟到）；
 *   2. 降档：候选必须连续出现 WORK_DEMOTE_TICKS 拍，且当前档已驻留 WORK_MIN_HOLD_MS；
 *   3. 其余一律 hold —— 调用方保持当前片段继续演，只更新气泡文本。
 * 这样 working↔result 的 1s 毛刺会被吞掉，而「工具真的跑完、开始整理」仍会在约 2s 内体现。
 */
export function decideWorkTier(input: WorkTierInput): WorkTierDecision {
  const { shown, shownAt, candidate, candTicks, now } = input;
  if (shown === candidate) return 'hold'; // 同档位：没有可换的东西（调用方通常已短路，这里兜底）
  if (shown === null) return 'accept'; // 空闲 → 任意：立刻起播
  if (candidate === 'success' || candidate === 'error') return 'accept'; // 终态是一次性反馈
  if (WORK_STATUS_PRIORITY[candidate] > WORK_STATUS_PRIORITY[shown]) return 'accept'; // 升档插队
  if (now - shownAt < WORK_MIN_HOLD_MS) return 'hold'; // 刚切过去，别马上又切走
  return candTicks >= WORK_DEMOTE_TICKS ? 'accept' : 'hold';
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
