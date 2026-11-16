/**
 * 记忆领域：`/memory/providers` 列出已注册的长期记忆实现。
 *
 * 只转发注册表的结论，不读配置、不碰记忆文件；契约见 openapi.yaml。
 * @module dsh-pet/src/host/routes/memory
 */
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { methodNotAllowed, okResult } from './result.ts';

/** 记忆领域：未命中返回 undefined，命中返回应答。 */
export async function handleMemoryRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { method, rest } = input;

  // 实现目录：与配置项 memoryProvider 同源，前端据此渲染下拉。
  if (rest === 'memory/providers') {
    if (method !== 'GET') return methodNotAllowed();
    return okResult({ ok: true, ...deps.memory.list() });
  }

  return undefined;
}
