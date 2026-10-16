/**
 * 独立模式的命令行解析与路径推导（纯逻辑，零 I/O —— 便于 node:test 直接单测）。
 *
 * 配置路径为什么在这里再写一遍：独立模式的 `--check` 要回答"DSH 会读哪份配置"，
 * 而那必须在不 `apply`（= 不拉起桌宠窗口）的前提下算出来。`src/host/index.ts` 仍是
 * 唯一事实来源，这里是它的**只读镜像**；`options.test.ts` 用插件自己的
 * `GET /config/meta`（由 `apply` 注册的真实路由）钉住两者一致，镜像一旦漂移测试就红。
 */
import { join } from 'node:path';

import type { ConfigPaths } from '../host/config';
import { DEFAULT_STANDALONE_PORT } from './server';

/** 命令行解析结果 */
export interface CliOptions {
  port: number;
  check: boolean;
  help: boolean;
}

/** `--help` 正文 */
export const USAGE = `dsh-pet 独立模式（不需要 DSH）

用法：dsh-pet-standalone [选项]

选项：
  --port <端口>   监听端口（默认 ${DEFAULT_STANDALONE_PORT}；被占用时自动向后顺延）
  --check         只体检：打印配置来源、宠物清单与 Electron 状态，不启动窗口
  -h, --help      显示本帮助

说明：
  桌宠在独立模式下以「透明置顶小窗」运行；浏览器内浮层需要有 DSH 网页，独立模式不提供。
  余额 / 碎碎念 / 对话 / 系统通知依赖 DSH 的服务，在独立模式下不可用。
`;

/**
 * 解析 argv。
 * @param argv `process.argv.slice(2)`
 * @returns 选项，或 `{ error }`（调用方打印用法并以 2 退出）
 */
export function parseArgs(argv: string[]): { options: CliOptions } | { error: string } {
  const options: CliOptions = { port: DEFAULT_STANDALONE_PORT, check: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg === '--port' ? String(argv[index + 1] ?? '') : arg.slice('--port='.length);
      if (arg === '--port') index += 1;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return { error: `--port 需要 1..65535 的整数端口，收到 ${JSON.stringify(raw)}` };
      }
      options.port = value;
    } else {
      return { error: `未知参数：${arg}` };
    }
  }
  return { options };
}

/**
 * 配置路径集（`src/host/index.ts` 那份推导的只读镜像，见文件头）。
 * @param root 插件包根目录（构建产物里 = 包根；源码形态下 = `src/`）
 * @param home DSH_HOME
 */
export function configPathsFor(root: string, home: string): ConfigPaths {
  const userRoot = join(home, 'dsh-pet');
  return {
    defaultFile: join(root, 'assets', 'config.jsonc'),
    userFile: join(userRoot, 'main-config.jsonc'),
    legacyUserFile: join(userRoot, 'main-config.json'),
    petDir: join(userRoot, 'pet'),
  };
}

/** 宠物列表的展示串：`display` 原样打印，由用户确认（独立模式不替用户改配置） */
export function describePets(pets: Record<string, unknown>[]): string {
  if (pets.length === 0) return '（没有宠物：配置里 pets 为空）';
  return pets
    .map((pet) => `${String(pet.id ?? '?')}(size=${String(pet.size ?? '?')}, display=${String(pet.display ?? '?')})`)
    .join('  ');
}

/**
 * 该实例是否会出现在桌面（`display` 含 desktop/both）。
 *
 * 口径来源是 `src/host/index.ts` 的 `isDesktopVisible`（那里是模块内 const、未导出），
 * 独立模式只是为了**打印提示**才知道这条规则，不参与渲染决策（渲染由插件自己判断），
 * 因此这里保留一份最小镜像；规则若变，测试与提示文案会露出来。
 */
export function isDesktopVisible(pet: Record<string, unknown>): boolean {
  const display = pet.display;
  return display === 'desktop' || display === 'both';
}
