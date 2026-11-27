/**
 * 把 DSH 桌面主窗口叫回前台（点系统通知时用）。
 *
 * 为什么不在渲染进程里 `window.focus()`、也不自己调 `SetForegroundWindow`：通知的点击由系统投递给
 * 宿主，宿主是**后台进程**，Windows 前台锁会拒绝它的前台请求——`SetForegroundWindow` 返回成功、
 * 窗口却纹丝不动。实测：窗口可见但被别的窗口盖住时 `show()` + `focus()` 完全不生效，只有从最小化
 * `restore()` 才带得起来。唯一稳定的是把激活交回 shell：explorer 用 `ShellExecute` 打开 `dsh://open`，
 * 协议处理器就是 DSH 自己，第二实例把 `second-instance` 事件转给首实例 → `focusPrimaryWindow()`；
 * 前台权限由 shell 转交，合法。
 *
 * 所以这里只做一件事：按平台起一个「打开该协议」的进程。不碰窗口、不查句柄、不写诊断日志——
 * 那些都是绕后台锁的旧路子，绕不过去。
 * @module dsh-pet/src/host/reveal
 */
import { spawn } from 'node:child_process';

/** DSH 桌面应用自注册的协议：只把主窗口叫回前台、不新开页面（桌面端 `focusPrimaryWindow`）。 */
export const REVEAL_URL = 'dsh://open';

/** 一次唤起尝试的结论：`revealed:false` 是结论不是异常，调用方一律按 200 处理。 */
export type RevealOutcome =
  { revealed: true; command: string } | { revealed: false; reason: 'not-desktop' | 'spawn-failed'; message?: string };

/**
 * 唤起用到的平台命令。
 *
 * win32 只能是 explorer（见模块头）：`cmd /c start` 与 PowerShell 都是宿主的子进程，继承不到前台
 * 权限；explorer 走 shell 的 `ShellExecute`，把请求交给已运行的 shell 处理。
 *
 * @param platform - `process.platform` 的取值。
 * @returns 可执行文件名与参数（URL 就是唯一参数）。
 */
export function revealCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'explorer.exe', args: [REVEAL_URL] };
  if (platform === 'darwin') return { command: 'open', args: [REVEAL_URL] };
  return { command: 'xdg-open', args: [REVEAL_URL] };
}

/**
 * 宿主是不是 DSH 桌面应用。
 *
 * 桌面宿主自己被 `ELECTRON_RUN_AS_NODE` 以纯 Node 模式拉起，但 `process.versions.electron` 仍在；
 * `dsh web` 是纯 Node，没有这个字段。
 */
export function isDesktopHost(): boolean {
  return Boolean(process.versions.electron);
}

/** 记日志用的最小接口：`FileLogger` 满足它，测试替身也满足。 */
export interface RevealLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

/**
 * 组装给 opener 用的环境：去掉 `ELECTRON_RUN_AS_NODE`。
 *
 * 宿主自己就是被这个变量以纯 Node 模式拉起来的；透传下去，协议处理器（DSH 的 exe）会以 node 模式
 * 跑、开不了窗口，然后立刻退出——协议空转，连日志都没有（与 issue #63 同一个坑）。
 *
 * @param base - 起始环境（通常是 `process.env`）。
 * @returns 副本；`base` 本身不被修改。
 */
export function openerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * 起一个进程去打开协议，`spawn` 事件到达即算成功。
 *
 * `detached: true` 不是可选项：explorer 只在**没有控制台**时才把参数当「协议打开」转发给已运行的
 * shell；跟着宿主继承控制台时它启动完就退，窗口一次都不会被叫醒（实测最小化后 5s 纹丝不动，
 * 去掉 detached 立刻失效）。这与「PowerShell 不能 detached」不矛盾——那条是 `DETACHED_PROCESS`
 * 撞上 `CREATE_NO_WINDOW` 导致进程根本起不来，边界按子进程类型定。
 *
 * @param spec - 命令与参数（{@link revealCommand} 的产物）。
 * @param logger - 可选日志出口；只记失败。
 * @returns 唤起结论，永不 reject。
 */
export function spawnOpener(spec: { command: string; args: string[] }, logger?: RevealLogger): Promise<RevealOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
        env: openerEnv(process.env),
      });
    } catch (e: unknown) {
      resolve({ revealed: false, reason: 'spawn-failed', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    child.once('error', (e) => {
      logger?.warn?.(`[dsh-pet] 唤起桌面窗口失败（${spec.command}）：${e.message}`);
      resolve({ revealed: false, reason: 'spawn-failed', message: e.message });
    });
    child.once('spawn', () => {
      // unref 之后父进程不再等它：explorer 会把请求转给 shell 再自己退出，与我们无关。
      child.unref();
      resolve({ revealed: true, command: spec.command });
    });
  });
}

/**
 * 把 DSH 桌面主窗口叫回前台。
 *
 * @param logger - 可选日志出口；只记结论，不刷屏。
 * @returns 唤起结论；非桌面宿主直接给 `not-desktop`，不 spawn 任何进程。
 */
export async function revealDesktopWindow(logger?: RevealLogger): Promise<RevealOutcome> {
  if (!isDesktopHost()) return { revealed: false, reason: 'not-desktop' };
  const outcome = await spawnOpener(revealCommand(process.platform), logger);
  if (outcome.revealed) logger?.info?.(`[dsh-pet] 唤起桌面窗口：ok（${outcome.command}）`);
  return outcome;
}
