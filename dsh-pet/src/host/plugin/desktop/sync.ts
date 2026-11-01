/**
 * 桌面侧重启：同一时刻只允许一次「停旧 → 起新」，连续请求排队而非交错。
 *
 * 两种形态走同一条入口：双进程（插件 / 独立模式）重启子进程；单进程（打包应用）没有
 * 子进程可重启，改让内嵌 helper 按新配置重建窗口。
 * 不自己停拉进程（归 ./spawn），不重算配置（归 ./pets）。
 * 依赖显式传入（见输入类型），模块内只读一个进程级事实：DSH_PET_IN_PROCESS。
 * @module dsh-pet/src/host/plugin/desktop/sync
 */
import type { DesktopHelperDeps } from './types.ts';
import type { DesktopPets } from './pets.ts';
import type { DesktopSpawn } from './spawn.ts';

/** DesktopSync的输入。 */
export type DesktopSyncInput = Pick<DesktopHelperDeps, 'log'> &
  Pick<DesktopPets, 'logDesktopDecision' | 'desktopPetList'> &
  Pick<DesktopSpawn, 'startHelper' | 'stopHelperAndWait'>;

/** 应用模式下由内嵌 helper 注册的重建钩子；双进程模式下不存在。 */
type RebuildHook = (() => Promise<void>) | undefined;

/**
 * 创建DesktopSync。
 */
export function createDesktopSync(deps: DesktopSyncInput) {
  const { log, logDesktopDecision, desktopPetList, startHelper, stopHelperAndWait } = deps;

  /** 同进程内跑 helper（打包应用）：没有子进程可重启，只能让 helper 自己重建窗口。 */
  const inProcessHost = process.env.DSH_PET_IN_PROCESS === '1';

  let desktopSyncQueue: Promise<void> = Promise.resolve();

  const restartDesktop = (): Promise<void> => {
    desktopSyncQueue = desktopSyncQueue
      .then(async () => {
        // 判定是现读的（pets 不持有状态），这里只补一行诊断日志。
        logDesktopDecision();
        if (inProcessHost) {
          // 先把新列表喂给渲染侧，再让它关窗重建：只动窗口、不动宿主进程，
          // 位置与运行状态都留着（整应用重启会把它们一起清掉）。
          process.env.DSH_PET_PETS = JSON.stringify(desktopPetList());
          await (globalThis as { __dshPetRebuildUi?: RebuildHook }).__dshPetRebuildUi?.();
          return;
        }
        await stopHelperAndWait('desktop-config-change');
        startHelper();
      })
      .catch((e: unknown) => {
        log.warn(`[dsh-pet] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
      });
    return desktopSyncQueue;
  };

  return { requestRestart: restartDesktop };
}

/** DesktopSync的产出。 */
export type DesktopSync = ReturnType<typeof createDesktopSync>;
