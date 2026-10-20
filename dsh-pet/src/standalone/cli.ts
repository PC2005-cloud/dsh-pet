#!/usr/bin/env node
/**
 * dsh-pet 独立模式 CLI 入口 —— 不打开 DSH 也能养桌宠。
 *
 * 真正的启动逻辑在 `./app.ts` 的 `startStandalone()`（可编程、不碰 argv、不 exit）：
 * 它造伪 Cordis ctx、起本机 `node:http` 服务、跑插件的宿主半边 `apply()`，并返回
 * `port` / `settingsUrl` / `shutdown()`。本文件只负责：
 *   1. 解析命令行（`--port` / `--check` / `--help`）与角色参数；
 *   2. 调用 `startStandalone()`；
 *   3. 把 SIGINT / SIGTERM / POST /shutdown 映射成「收尾 → process.exit」。
 *
 * 用法：
 *   npx dsh-pet-standalone              # 插件装好后直接跑（package.json 的 bin）
 *   npm run standalone                  # 仓库里跑（先安装依赖并 npm run build）
 *   node lib/standalone.js --port 3081
 *   node lib/standalone.js --check      # 只体检，不开窗口
 *
 * 独立模式的边界：动画、物理拖拽、右键菜单、多开、自定义素材与宠物种类全部可用；
 * 余额、碎碎念、对话、系统通知依赖 DSH 的凭证/模型/会话，在独立模式下明确不可用
 * （结构化失败 + 日志，不假装成功）。详见 README 的「独立运行（不打开 DSH）」一节。
 */
import { HOST_KIND_ENV } from '../host/host-kind';
import { APP_ROLE_ARGS, parseAppRole } from '../host/launch-plan';
import { MissingPackageConfigError, startStandalone, type StandaloneHandle } from './app';
import { runCheck } from './check';
import { createStandaloneLogger } from './context';
import { parseArgs, USAGE } from './options';

/** 收尾后退出：失败时打一条可读日志并以 1 退出（与旧 CLI 的收尾口径一致） */
function exitAfterShutdown(logger: ReturnType<typeof createStandaloneLogger>, shutdown: () => Promise<void>): void {
  shutdown()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error(`收尾失败：${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

/** CLI 入口 */
async function main(): Promise<number> {
  // 宿主形态由启动方显式传入（ticket 08）：本入口永远是独立模式 / 站点语义，
  // 不依赖 host-kind.ts 的 Electron 嗅探回退（纯 Node 进程恰好会回退成 site，
  // 但显式声明才能让契约在运行期可验证）。已有取值时不覆盖（环境变量优先）。
  if (!process.env[HOST_KIND_ENV]) process.env[HOST_KIND_ENV] = 'site';
  const argv = process.argv.slice(2);
  // 角色分流（ticket 01）：打包形态由同一个可执行文件承担三种角色；独立模式入口目前恒为宿主。
  // 角色参数先摘掉，免得被自己的 CLI 解析当成未知参数；--port/--check 等是本入口自己的参数，不告警。
  const invocation = parseAppRole(argv, { knownArgs: ['--port', '--check', '-h', '--help'] });
  const logger = createStandaloneLogger();
  for (const warning of invocation.warnings) logger.warn(warning);
  if (invocation.role !== 'host') {
    logger.warn(`独立模式 CLI 目前只运行宿主角色（收到 ${invocation.role} 参数），按宿主继续。`);
  }
  const parsed = parseArgs(argv.filter((arg) => !APP_ROLE_ARGS.includes(arg)));
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
  if (options.check) return runCheck(logger);

  let handle: StandaloneHandle;
  try {
    handle = await startStandalone({
      logger,
      port: options.port,
      autostart: invocation.autostart,
      onShutdownRequested: (_reason, shutdown) => exitAfterShutdown(logger, shutdown),
    });
  } catch (error) {
    if (error instanceof MissingPackageConfigError) {
      logger.error(error.message);
      // 与旧 run() 一致：只设退出码、自然退出，不打断已刷出的诊断
      process.exitCode = 1;
      return 0;
    }
    throw error;
  }

  process.once('SIGINT', () => exitAfterShutdown(logger, () => handle.shutdown('SIGINT')));
  process.once('SIGTERM', () => exitAfterShutdown(logger, () => handle.shutdown('SIGTERM')));
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
