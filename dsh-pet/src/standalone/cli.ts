#!/usr/bin/env node
/**
 * dsh-pet 独立模式 CLI 入口 —— 不打开 DSH 也能养桌宠。
 *
 * 参数解析与启动编排分开：本文件只管"命令行长什么样、体检还是启动"，
 * 真正把服务与插件宿主半边串起来的逻辑在 `./run`（桌面应用入口 `./desktop` 复用同一条路径）。
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
import { runCheck } from './check';
import { createStandaloneLogger } from './context';
import { parseArgs, USAGE } from './options';
import { runStandalone } from './run';

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
  // 启动失败（如包内默认配置缺失）时 runStandalone 已打日志并置 process.exitCode=1
  await runStandalone(logger, options);
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
