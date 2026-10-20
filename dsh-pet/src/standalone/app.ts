/**
 * 独立模式的可编程入口 —— 把「起服务 + 跑插件宿主半边 + 收尾」封装成一个函数。
 *
 * 为什么需要它：`./cli.ts` 是**可执行入口**，被 import 就会跑参数解析并 `process.exit`，
 * 打包后的 Electron 主进程没法复用它（那里 `process.argv` 里带着应用自己的角色参数）。
 * 本文件不碰 `process.argv`、不注册信号、不调用 `process.exit` —— 何时退出由调用方决定：
 *   - CLI（`./cli.ts`）解析参数后调用它，并在信号/POST /shutdown 时退出进程；
 *   - 打包后的宿主角色（`desktop/main.mjs`）在 Electron 主进程里调用它，由 Electron 决定生命周期。
 *
 * 启动顺序与原来的 CLI `run()` 完全一致（先监听拿到端口，再 `apply`）：插件的
 * `launchHelper` 依赖 `ctx.webServer.port > 0`，端口为 0 时它只会延迟重试、永不拉起桌面窗口。
 */
import { existsSync } from 'node:fs';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir, packageRoot as defaultPackageRoot } from '../host/helper-process';
import { apply } from '../host/index';
import { createStandaloneAi } from './ai-provider';
import { packageVersion } from './check';
import {
  createStandaloneContext,
  createStandaloneLogger,
  type RegisteredRoute,
  type StandaloneLogger,
} from './context';
import { configPathsFor, describePets, isDesktopVisible } from './options';
import { createRequestSecurity } from './request-security';
import { writeStandaloneRuntime } from './runtime-state';
import { listenStandaloneServer } from './server';

/** 包内默认配置缺失（源码形态直接跑、或安装包损坏）。CLI 据此保持原有的诊断与退出码。 */
export class MissingPackageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingPackageConfigError';
  }
}

export interface StartStandaloneOptions {
  /** 日志器；默认写控制台（与 CLI 同一格式） */
  logger?: StandaloneLogger;
  /** 监听端口（默认 3080，被占用时向后顺延）；0 = 由系统分配（测试/嵌入式调用用） */
  port?: number;
  /** 是否由系统登录项拉起：当前只影响启动横幅（延迟启动见 ticket 09） */
  autostart?: boolean;
  /** 插件包根（默认由构建产物位置反推）。测试或嵌入方可以指向别的包目录。 */
  packageRoot?: string;
  /**
   * POST /shutdown 到达时的处理。默认只做收尾（嵌入式调用方自己决定是否退出进程）；
   * CLI 传入自己的实现，在收尾完成后 `process.exit`。
   */
  onShutdownRequested?: (reason: string, shutdown: () => Promise<void>) => void;
}

export interface StandaloneHandle {
  /** 实际监听端口（可能因占用而顺延） */
  port: number;
  /** 带一次性 token 的设置页 URL（能力令牌，不得写日志） */
  settingsUrl: string;
  /** 释放插件 effect、关服务、清理运行时状态文件；幂等 */
  shutdown(reason?: string): Promise<void>;
}

/** 启动独立模式：先起服务拿到端口，再 `apply`（插件据此拼桌面 Helper 的 configUrl） */
export async function startStandalone(options: StartStandaloneOptions = {}): Promise<StandaloneHandle> {
  const logger = options.logger ?? createStandaloneLogger();
  const root = options.packageRoot ?? defaultPackageRoot;
  const home = dshHomeDir();
  const paths = configPathsFor(root, home);

  // 预检：包内默认配置读不到时宿主半边必然每请求失败；早给可操作的诊断，别让用户对着空桌面猜
  if (!existsSync(paths.defaultFile)) {
    throw new MissingPackageConfigError(
      `包内默认配置缺失：${paths.defaultFile}。若你是在直接跑源码（包根被解析成了 src/），` +
        '请改用构建产物：npm run bundle 后 node lib/standalone.js（或 npm run standalone）。',
    );
  }

  const routes: RegisteredRoute[] = [];
  const portRef = { value: options.port ?? 0 };
  const ai = createStandaloneAi(home, logger);
  const security = createRequestSecurity();
  const context = createStandaloneContext({
    port: () => portRef.value,
    logger,
    routes,
    ai,
    authenticatedUrl: security.authenticatedUrl,
  });
  // /shutdown 的回调要在服务构造时给出去，而停机函数要在服务之后定义：
  // 用一个可替换的转发器解耦（服务构造时只拿到"将来会是谁"）。
  let forwardShutdown: () => void = () => {};
  const server = await listenStandaloneServer({
    routes,
    logger,
    port: options.port,
    security,
    ai,
    status: () => ({
      name: 'dsh-pet-standalone',
      pid: process.pid,
      pluginRoot: root,
      plugin: { root, version: packageVersion(root) },
      port: portRef.value,
      uptimeSec: Math.round(process.uptime()),
    }),
    onShutdown: () => forwardShutdown(),
  });
  portRef.value = server.port;
  const settingsUrl = security.authenticatedUrl(`http://127.0.0.1:${server.port}`);
  let releaseRuntime: () => void;
  try {
    releaseRuntime = writeStandaloneRuntime(home, {
      port: server.port,
      token: security.token,
      settingsUrl,
      pluginRoot: root,
    });
  } catch (error) {
    await context.dispose();
    await server.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收尾（${reason}）…`);
    // 先释放插件注册的 effect（停桌面 Helper、清周期定时器），再关服务
    try {
      await context.dispose();
    } finally {
      await server.close();
      releaseRuntime();
    }
    logger.info('已退出。');
  };
  forwardShutdown = () => {
    const requested = options.onShutdownRequested;
    // 默认只做收尾：嵌入式调用方（Electron 宿主）自己决定进程何时退出
    if (requested) requested('POST /shutdown', () => shutdown('POST /shutdown'));
    else void shutdown('POST /shutdown');
  };

  // 起插件宿主半边：路由表、状态仓、桌面 Helper（含 bridge 管道）都在这一句里
  try {
    apply(context.ctx);
  } catch (error) {
    await shutdown('apply-failed');
    throw error;
  }

  let pets: Record<string, unknown>[] = [];
  let configSource = paths.userFile;
  try {
    pets = flattenPetList(readAllConfig(paths));
    if (!existsSync(paths.userFile)) configSource = `${paths.userFile}（不存在 → 用包内默认）`;
  } catch (error) {
    logger.warn(
      `读配置失败（服务照常运行，相关端点会显式报错）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const desktopVisible = pets.filter(isDesktopVisible);
  for (const line of [
    '',
    '===== dsh-pet 独立模式（不需要 DSH）=====',
    `  插件        dsh-pet@${packageVersion(root)}  ${root}`,
    `  路由        http://127.0.0.1:${server.port}/dsh-pet-7340/`,
    `  配置        ${configSource}`,
    `  宠物        ${describePets(pets)}`,
    desktopVisible.length === 0
      ? '  桌面小窗    0 只：display 需要 desktop 或 both 才会出现透明小窗（服务仍在运行）'
      : `  桌面小窗    ${desktopVisible.length} 只`,
    // 自启标记已解析进 options：静默/延迟启动由打包形态的宿主实现（ticket 09），
    // 独立模式目前只把状态告知用户，不改变启动时序。
    ...(options.autostart ? ['  自启        是（由系统登录项拉起）'] : []),
    ai.isReady()
      ? '  AI          本机 API 已启用；自动碎碎念遵循设置页开关'
      : '  AI          未配置或未启用，不发送模型请求；右键“打开 AI 设置”后在本机填写',
    '  不可用      余额 / 会话工作状态 / DSH 系统通知',
    '  退出        Ctrl+C，或 POST /shutdown',
    '',
  ]) {
    logger.info(line);
  }
  if (context.failures.length > 0) {
    logger.warn(`初始化期间有 ${context.failures.length} 项失败（见上方日志）；路由仍可用，相关端点会显式报错`);
  }

  return {
    port: server.port,
    settingsUrl,
    shutdown: (reason = 'shutdown') => shutdown(reason),
  };
}
