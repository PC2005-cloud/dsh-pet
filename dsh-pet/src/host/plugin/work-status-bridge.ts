/**
 * 工作状态联动：把 store 里的活动状态按 5s 间隔压扁后写进轮询快照。
 *
 * 不监听会话事件（归会话监听器），不渲染气泡。
 * 依赖由 apply 显式传入（见输入类型），模块内不读全局、不建单例。
 * @module dsh-pet/src/host/plugin/work-status-bridge
 */
import type { HostSetup } from './setup.ts';

/** 工作状态桥的输入：轮询快照、工作状态 store，以及判定「外部槽」用的哨兵会话 id。 */
export type WorkStatusBridgeInput = Pick<HostSetup, 'state' | 'workStatus' | 'EXTERNAL_WORK_SESSION'>;

/**
 * 创建工作状态桥。
 */
export function createWorkStatusBridge(deps: WorkStatusBridgeInput) {
  const { state, workStatus, EXTERNAL_WORK_SESSION } = deps;
  // 工作状态快照写进 S：内容真的变了才写（每次写都推进 counter，前端据此重播档位动画）。
  // 只压「距上次写入不足 WORK_STATE_GAP_MS 的 working → result」——工具秒回时会来回切十几次，
  // 每切一次前端就把片段从第 0 帧重播；反向不压（开工迟到比多换一次片更糟），终态不压。
  const WORK_STATE_GAP_MS = 5000;

  let publishedWork = '\u0000';

  let publishedState: string | null = null;

  let publishedWorkAt = 0;

  let workFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const publishWorkStatus = (): void => {
    const snap = workStatus.snapshot();
    // 会话也算内容：同档同文案换了会话，页面必须知道，否则点气泡会跳到上一条会话。
    const key = String(snap.state) + '\u0000' + String(snap.task) + '\u0000' + String(snap.sessionId ?? '');
    if (key === publishedWork) return;
    // 抖动判定：只压 working → result 这一个方向（同档只换文案不算抖动，照常立即写；
    // 反向 result → working 立即写）
    const busyFlip = publishedState === 'working' && snap.state === 'result';
    const wait = WORK_STATE_GAP_MS - (Date.now() - publishedWorkAt);
    if (busyFlip && wait > 0) {
      // 整条不写（档位与文案一起压住）：到点再取最新快照补写
      // （不要在这里缓存 snap——期间可能又变了）
      workFlushTimer ??= setTimeout(() => {
        workFlushTimer = null;
        publishWorkStatus();
      }, wait);
      return;
    }
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
    publishedWork = key;
    publishedState = snap.state;
    publishedWorkAt = Date.now();
    // 外部槽（`api`）不是真实 DSH 会话：这里写成 null，客户端才不会把气泡做成一个点了没反应的入口。
    const sessionId = snap.sessionId === null || snap.sessionId === EXTERNAL_WORK_SESSION ? null : snap.sessionId;
    state.writeSection('workStatus', { state: snap.state, task: snap.task, sessionId });
  };

  /** 停掉挂起的补写定时器（插件卸载时调用）。 */
  const stopWorkStatusFlush = (): void => {
    if (workFlushTimer !== null) {
      clearTimeout(workFlushTimer);
      workFlushTimer = null;
    }
  };
  return { publishWorkStatus, stopWorkStatusFlush };
}
/** 工作状态桥的产出（供下游工厂按需 Pick）。 */
export type WorkStatusBridge = ReturnType<typeof createWorkStatusBridge>;
