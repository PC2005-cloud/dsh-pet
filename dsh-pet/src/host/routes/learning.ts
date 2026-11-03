/**
 * 台词文件路由：GET /learningTxt 读项目根目录 learningTxt.json（一行一条），
 * POST /learningTxt 用系统默认编辑器打开它（设置页「打开台词文件」按钮）。
 *
 * 浏览器 / 桌面端从 GET 拉取后随机抽行显示；文件缺失回 404（客户端回退空内容（不弹气泡））。
 * @module dsh-pet/src/host/routes/learning
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { RouteResult } from '../http.ts';
import { LEARNING_TXT_PATH } from '../paths.ts';
import { methodNotAllowed } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 台词文件领域：未命中返回 undefined，命中返回应答。 */
export async function handleLearningRoutes(_deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  if (input.rest !== 'learningTxt') return undefined;
  if (input.method === 'GET') {
    try {
      const body = await readFile(LEARNING_TXT_PATH, 'utf8');
      return { kind: 'text', status: 200, body };
    } catch {
      return { kind: 'text', status: 404, body: '' };
    }
  }
  if (input.method === 'POST') {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', LEARNING_TXT_PATH] : [LEARNING_TXT_PATH];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return { kind: 'json', status: 200, obj: { ok: true } };
  }
  return methodNotAllowed();
}
