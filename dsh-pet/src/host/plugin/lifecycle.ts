/**
 * 卸载清理：摘监听、停定时器、结束挂起等待，顺序不可调换。
 *
 * 不做启动（装配末尾单独 startHelper），不持有资源句柄。
 * @module dsh-pet/src/host/plugin/lifecycle
 */
import type { PetLookup } from './pet-lookup.ts';
import type { DesktopHelper } from './desktop-helper.ts';
import type { DownloadReport } from './download-report.ts';
import type { WorkStatusBridge } from './work-status-bridge.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';

/** 卸载清理的输入。 */
export type LifecycleInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
  disposeWow?: () => Promise<void>;
} & Pick<PetLookup, 'lock'> &
  Pick<DesktopHelper, 'markDisposed'> &
  Pick<HostSetup, 'playback'> &
  Pick<HostSetup, 'state'> &
  Pick<DownloadReport, 'stopDownloadSlotTimer'> &
  Pick<DesktopHelper, 'stopHelper'> &
  Pick<WorkStatusBridge, 'stopWorkStatusFlush'>;

/** 注册卸载清理；返回的清理函数由 ctx.effect 收集。 */
export function registerLifecycle(deps: LifecycleInput): void {
  const { ctx, lock, markDisposed, playback, state, stopDownloadSlotTimer, stopHelper, stopWorkStatusFlush } = deps;
  // 随插件生命周期清理：桌面 Helper 回收（异步下载完成后不再拉起）+ 结束所有挂起的等待
  // （回执与 /state 长轮询不结束的话，插件重载会留下一批悬挂响应，各自要等到超时才收尾）。
  ctx.effect(() => async () => {
    const wowDisposal = deps.disposeWow?.();
    markDisposed();
    // 工作状态的补写定时器：卸载后它到点已经没有意义（叶子连同长轮询一起收尾），清掉免得挂着
    stopWorkStatusFlush();
    // 下载日志的「清槽」定时器：同上，卸载后它到点已经没有意义
    stopDownloadSlotTimer();
    // 占用锁：卸载时把锁全撤掉并写一次叶子——不写的话渲染端要等 TTL 到点才解除静止
    // （写叶子必须在 state.cancelAll() 之前：那之后挂起的等待者已经收尾了）。
    lock.releaseAll();
    playback.cancelAll();
    state.cancelAll();
    stopHelper('dsh-host-stop');
    await wowDisposal;
  });
}
