/**
 * 应用启动计划与角色分流 —— 纯逻辑（零 I/O，可独立单测）。
 *
 * 打包后是**单个 Electron 应用**：宿主角色 spawn 桌面壳时，可执行文件与开发形态不同
 * （开发形态是 Electron 二进制 + helper 脚本路径；打包形态是同一个 exe + 角色参数），
 * 还要删掉会劫持 Electron 启动模式的环境变量。这些差别必须收在这里，而不是散在 spawn 调用点。
 *
 * 角色分流（打包后的主进程）：
 *   无参数 / --autostart → 宿主；--dsh-pet-helper → 桌面壳；--dsh-pet-dpi-probe → 一次性 DPI 探测。
 *   未知参数不崩溃：按宿主处理，并**返回**告警文案（本模块不碰 console，由调用方决定怎么输出）。
 */

/** 应用角色：宿主 / 桌面壳 / DPI 探测 */
export type AppRole = 'host' | 'helper' | 'dpi-probe';

/** 角色分流结果 */
export interface AppRoleInvocation {
  role: AppRole;
  /** 是否由系统登录项（--autostart）拉起：宿主据此延迟启动、不抢焦点（见 ticket 09） */
  autostart: boolean;
  /** 未知参数的告警文案；调用方负责输出（不要在本模块直接 console） */
  warnings: string[];
}

export interface ParseAppRoleOptions {
  /**
   * 调用方自己的参数（如独立模式 CLI 的 `--port` / `--check`）：不参与角色判断，也不产生未知参数告警。
   * 支持 `--flag=value` 形式；不以 `-` 开头的值参数（如端口号）天然被忽略。
   */
  knownArgs?: readonly string[];
}

/** 应用级角色参数（独立模式入口在把 argv 交给自己的 CLI 解析前需要剔除它们） */
export const APP_ROLE_ARGS: readonly string[] = ['--autostart', '--dsh-pet-helper', '--dsh-pet-dpi-probe'];

/** spawn 子进程前必须从环境里**删键**的变量（见 buildLaunchPlan 的说明） */
export const LAUNCH_ENV_DELETE_KEYS: readonly string[] = ['ELECTRON_RUN_AS_NODE'];

function matchesKnownArg(arg: string, knownArgs: ReadonlySet<string>): boolean {
  if (knownArgs.has(arg)) return true;
  // `--port=3081` 这类带值形式也认（值本身不是独立 token，不需要额外处理）
  const eq = arg.indexOf('=');
  return eq > 0 && knownArgs.has(arg.slice(0, eq));
}

/**
 * 命令行参数 → 角色与自启标记。
 *
 * @param argv 应用级参数（打包形态 = `process.argv.slice(1)`；独立模式 = `process.argv.slice(2)`）
 */
export function parseAppRole(argv: readonly string[], options: ParseAppRoleOptions = {}): AppRoleInvocation {
  const knownArgs = new Set(options.knownArgs ?? []);
  let role: AppRole = 'host';
  let autostart = false;
  const warnings: string[] = [];

  for (const arg of argv) {
    if (arg === '--autostart') {
      autostart = true;
    } else if (arg === '--dsh-pet-helper') {
      role = 'helper';
    } else if (arg === '--dsh-pet-dpi-probe') {
      role = 'dpi-probe';
    } else if (matchesKnownArg(arg, knownArgs)) {
      // 调用方自己的参数：与角色无关
    } else if (arg.startsWith('-')) {
      warnings.push(`未知参数 ${JSON.stringify(arg)}：按宿主角色处理`);
    }
    // 非 `-` 开头的 token（如 --port 的数值）没有角色含义，忽略
  }

  return { role, autostart, warnings };
}

/** 启动的进程种类：桌面壳（常驻）或 DPI 探测（一次性） */
export type LaunchKind = 'helper' | 'dpi-probe';

export interface LaunchPlanInput {
  /** 是否打包形态：true = 同一个可执行文件 + 角色参数；false = Electron 二进制 + 脚本路径 */
  packaged: boolean;
  /** 开发形态是 Electron 二进制；打包形态是应用自身可执行文件 */
  executablePath: string;
  /** 开发形态的桌面壳脚本入口（打包形态不使用：入口已内置在 exe 里） */
  helperEntry: string;
  /** 子进程工作目录（Windows 上不能落在包目录内，见 HelperProcess 的注释） */
  cwd: string;
  /** 默认 helper；dpi-probe = 一次性 DPI 探测（打印主屏 scaleFactor 后退出） */
  kind?: LaunchKind;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  /**
   * spawn 前必须从环境里删掉的变量。
   * `ELECTRON_RUN_AS_NODE` 必须**删键**而不是设空串：Electron 只看键是否存在，
   * 设空串会直接 abort（实测 43.3.0，见 helper-process.ts 的 helperSpawnEnv 注释）。
   */
  envDelete: string[];
}

/** 解析出一次子进程启动所需的全部信息（命令 / 参数 / 工作目录 / 环境清理） */
export function buildLaunchPlan(input: LaunchPlanInput): LaunchPlan {
  const probe = input.kind === 'dpi-probe';
  const roleArg = probe ? '--dsh-pet-dpi-probe' : '--dsh-pet-helper';
  const args = input.packaged ? [roleArg] : probe ? [input.helperEntry, roleArg] : [input.helperEntry];
  return {
    command: input.executablePath,
    args,
    cwd: input.cwd,
    envDelete: [...LAUNCH_ENV_DELETE_KEYS],
  };
}
