/**
 * 本机会话用量：定时把当前工作状态会话的 token 累计写进 sections.usage。
 * 不查商家余额；自定义模型也能显示。
 * @module dsh-pet/src/host/plugin/local-usage
 */
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { readSessionUsage } from '../local-usage.ts';
import type { PollStateStore } from '../state.ts';
import type { WorkStatusStore } from '../work-status.ts';
import type { HostContext } from './context.ts';

/** 刷新间隔（ms）：用量文件由宿主会话进程写，不必跟工作状态同频。 */
const USAGE_POLL_MS = 15_000;

/** 本机用量轮询的输入。 */
export interface LocalUsageInput {
  /** 宿主上下文。 */
  ctx: HostContext;
  /** 轮询快照。 */
  state: PollStateStore;
  /** 工作状态（取当前展示会话）。 */
  workStatus: WorkStatusStore;
}

/**
 * 注册本机用量轮询。
 * @param deps - store 与 ctx。
 */
export function registerLocalUsage(deps: LocalUsageInput): void {
  const { ctx, state, workStatus } = deps;
  const dshHome = resolveDshHome();
  let lastSession: string | null = null;

  const publish = (sessionId: string | null | undefined): void => {
    const id = sessionId && sessionId !== 'unknown' ? sessionId : lastSession;
    if (id) lastSession = id;
    const usage = readSessionUsage(dshHome, id);
    if (usage) state.writeSection('usage', usage);
  };

  ctx.effect(() => {
    let disposed = false;
    const timer = setInterval(() => {
      if (disposed) return;
      try {
        publish(workStatus.snapshot().sessionId);
      } catch {
        /* 读盘失败静默，下一拍再试 */
      }
    }, USAGE_POLL_MS);
    try {
      publish(workStatus.snapshot().sessionId);
    } catch {
      /* 启动时没有会话文件是正常的 */
    }
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, 'dsh-pet: local usage poll');
}
