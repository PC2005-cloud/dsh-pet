#!/usr/bin/env node
/**
 * dsh-pet 独立模式入口 —— 不打开 DSH 也能养桌宠。
 *
 * 它把三件事串起来（每一步都复用插件自己的实现，没有第二份业务逻辑）：
 *   1. `./context` 造一个伪 Cordis ctx，把插件的宿主半边（`src/host/index.ts` 的 `apply`）跑起来；
 *   2. `./server` 起一个真正的 `node:http` 服务，把 `apply` 注册的 prefix handler 接上去
 *      （路由表仍然只有插件那一份）；
 *   3. 插件自己的 `launchHelper` 因此照常探测 Electron、按配置拉起透明置顶小窗，
 *      并与宿主经 bridge 管道通信 —— 与 DSH 内运行完全同一条路径。
 *
 * 用法：
 *   npx dsh-pet-standalone              # 插件装好后直接跑（package.json 的 bin）
 *   npm run standalone                  # 仓库里跑（先 npm install：prepare 会构建 lib/）
 *   node lib/standalone.js --port 3081
 *   node lib/standalone.js --check      # 只体检，不开窗口
 *
 * 独立模式的边界：动画、物理拖拽、右键菜单、多开、自定义素材与宠物种类全部可用；
 * 余额、碎碎念、对话、系统通知依赖 DSH 的凭证/模型/会话，在独立模式下明确不可用
 * （结构化失败 + 日志，不假装成功）。详见 README 的「独立运行（不打开 DSH）」一节。
 */
import { existsSync } from 'node:fs';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir, packageRoot } from '../host/helper-process';
import { apply } from '../host/index';
import { runCheck, packageVersion } from './check';
import {
  createStandaloneContext,
  createStandaloneLogger,
  type RegisteredRoute,
  type StandaloneLogger,
} from './context';
import { configPathsFor, describePets, isDesktopVisible, parseArgs, USAGE } from './options';
import { listenStandaloneServer } from './server';

/** 启动独立模式：先起服务拿到端口，再 `apply`（插件据此拼桌面 Helper 的 configUrl） */
async function run(logger: StandaloneLogger, options: { port: number }): Promise<void> {
  const home = dshHomeDir();
  const paths = configPathsFor(packageRoot, home);

  // 预检：包内默认配置读不到时宿主半边必然每请求失败；早给可操作的诊断，别让用户对着空桌面猜
  if (!existsSync(paths.defaultFile)) {
    logger.error(
      `包内默认配置缺失：${paths.defaultFile}。若你是在直接跑源码（包根被解析成了 src/），` +
        '请改用构建产物：npm run bundle 后 node lib/standalone.js（或 npm run standalone）。',
    );
    process.exitCode = 1;
    return;
  }

  const routes: RegisteredRoute[] = [];
  const portRef = { value: options.port };
  const context = createStandaloneContext({ port: () => portRef.value, logger, routes });
  // /shutdown 的回调要在服务构造时给出去，而停机函数要在服务之后定义：
  // 用一个可替换的转发器解耦（服务构造时只拿到"将来会是谁"）。
  let forwardShutdown: () => void = () => {};
  const server = await listenStandaloneServer({
    routes,
    logger,
    port: options.port,
    status: () => ({
      name: 'dsh-pet-standalone',
      plugin: { root: packageRoot, version: packageVersion(packageRoot) },
      port: portRef.value,
      uptimeSec: Math.round(process.uptime()),
    }),
    onShutdown: () => forwardShutdown(),
  });
  portRef.value = server.port;

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收尾（${reason}）…`);
    // 先释放插件注册的 effect（停桌面 Helper、清周期定时器），再关服务
    await context.dispose();
    await server.close();
    logger.info('已退出。');
  };
  const requestShutdown = (reason: string): void => {
    shutdown(reason)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error(`收尾失败：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };
  forwardShutdown = () => requestShutdown('POST /shutdown');
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  // 起插件宿主半边：路由表、状态仓、桌面 Helper（含 bridge 管道）都在这一句里
  apply(context.ctx);

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
    `  插件        dsh-pet@${packageVersion(packageRoot)}  ${packageRoot}`,
    `  路由        http://127.0.0.1:${server.port}/dsh-pet-7340/`,
    `  配置        ${configSource}`,
    `  宠物        ${describePets(pets)}`,
    desktopVisible.length === 0
      ? '  桌面小窗    0 只：display 需要 desktop 或 both 才会出现透明小窗（服务仍在运行）'
      : `  桌面小窗    ${desktopVisible.length} 只`,
    '  不可用      余额 / 碎碎念 / 对话 / 系统通知（依赖 DSH 的凭证、模型与会话）',
    '  退出        Ctrl+C，或 POST /shutdown',
    '',
  ]) {
    logger.info(line);
  }
  if (context.failures.length > 0) {
    logger.warn(`初始化期间有 ${context.failures.length} 项失败（见上方日志）；路由仍可用，相关端点会显式报错`);
  }
}

/** CLI 入口 */
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`dsh-pet-standalone: ${parsed.error}\n`);
    console.error(USAGE);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const logger = createStandaloneLogger();
  if (options.check) return runCheck(logger);
  await run(logger, options);
  return 0;
}

// 本文件就是可执行入口（package.json 的 bin 指向构建产物 lib/standalone.js），
// 因此无条件启动：不做 import.meta.main / argv[1] 比较之类的守卫 ——
// import.meta.main 要 Node 24+，而 argv[1] 比较在 pnpm 的 bin 符号链接下会判错。
main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`dsh-pet-standalone: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
