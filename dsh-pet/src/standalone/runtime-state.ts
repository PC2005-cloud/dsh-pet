import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { writePrivateJson } from './ai-storage';

interface RuntimeDetails {
  port: number;
  token: string;
  settingsUrl: string;
  pluginRoot: string;
}

/** 只给本机启动器的能力文件；HTTP health 不得包含其 token/settingsUrl。 */
export function writeStandaloneRuntime(home: string, details: RuntimeDetails): () => void {
  const directory = join(home, 'dsh-pet');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'standalone-runtime.json');
  try {
    writePrivateJson(file, {
      name: 'dsh-pet-standalone',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...details,
    });
  } catch (error) {
    throw new Error('无法安全写入桌宠运行状态，请检查数据目录的访问权限。', { cause: error });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; token?: string };
      if (current.pid === process.pid && current.token === details.token) unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('清理桌宠运行状态失败；请检查数据目录，未删除其他进程的状态。', { cause: error });
    }
  };
}
