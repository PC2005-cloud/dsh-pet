/**
 * 独立模式的命令行解析与路径推导，纯逻辑、零 I/O。
 *
 * 负责把 argv 变成选项，并镜像宿主半侧推导出的配置路径；不读文件、不建目录。
 * 路径口径以宿主半侧为准，这里只是只读镜像，测试会钉住两者一致。
 * 必须始终成立：--check 不 apply 也能算出 DSH 会读的配置路径。
 * @module dsh-pet/src/standalone/options
 */
import { join } from 'node:path';

import type { ConfigPaths } from '../host/config.ts';
import { DEFAULT_STANDALONE_PORT } from './server.ts';

/** 解析后的命令行选项。 */
export interface CliOptions {
  port: number;
  check: boolean;
  help: boolean;
  setup: boolean;
}

/** --help 正文。 */
export const USAGE = `dsh-pet 独立模式（不需要 DSH）

用法：dsh-pet-standalone [选项]

选项：
  --port <端口>   监听端口（默认 ${DEFAULT_STANDALONE_PORT}；被占用时自动向后顺延）
  --check         只体检：打印配置来源、宠物清单与 Electron 状态，不启动窗口
  --setup         启动桌宠并打开「开始养鱼」，配置聊天与本机长期记忆
  -h, --help      显示本帮助

说明：
  桌宠在独立模式下以「透明置顶小窗」运行；浏览器内浮层需要有 DSH 网页，独立模式不提供。
  对话与碎碎念可在本机 AI 设置页配置 API 后显式启用；未配置时不发送模型请求。
  余额 / DSH 会话工作状态 / 系统通知仍需要 DSH 宿主。
`;

/**
 * 解析 argv。
 * @param argv - 已去掉 node 与脚本路径的参数。
 * @returns 选项，或带 error 的失败结果，由调用方打印用法并以 2 退出。
 */
export function parseArgs(argv: string[]): { options: CliOptions } | { error: string } {
  const options: CliOptions = { port: DEFAULT_STANDALONE_PORT, check: false, help: false, setup: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--setup') {
      options.setup = true;
    } else if (arg === '--check') {
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
 * 推导配置路径集（宿主半侧那份推导的只读镜像）。
 * @param root - 插件包根目录。
 * @param home - DSH_HOME。
 * @returns 与宿主半侧一致的路径集。
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

/** 宠物列表的展示串：display 原样打印，供用户确认。 */
export function describePets(pets: Record<string, unknown>[]): string {
  if (pets.length === 0) return '（没有宠物：配置里 pets 为空）';
  return pets
    .map((pet) => `${String(pet.id ?? '?')}(size=${String(pet.size ?? '?')}, display=${String(pet.display ?? '?')})`)
    .join('  ');
}

/**
 * 判断实例是否会出现在桌面（display 含 desktop 或 both），只用于提示。
 * @param pet - 宠物条目。
 * @returns 是否会出现在桌面。
 */
export function isDesktopVisible(pet: Record<string, unknown>): boolean {
  const display = pet.display;
  return display === 'desktop' || display === 'both';
}
