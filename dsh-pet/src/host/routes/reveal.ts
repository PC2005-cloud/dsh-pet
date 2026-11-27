/**
 * 桌面窗口唤起：`POST /reveal`，点系统通知时由浏览器半侧调用。
 *
 * 语义是「替我打开 `dsh://open`」而不是「把某个窗口句柄置顶」：为什么要经 explorer 转交、
 * 为什么不自己调窗口 API，见 ../reveal.ts 的模块头。
 *
 * 非桌面宿主（`dsh web` / 独立模式）回 `revealed:false, reason:"not-desktop"`，仍是 200——
 * 这是结论不是协议错误（与 `/pet-display` 的动作端点口径一致）。
 * @module dsh-pet/src/host/routes/reveal
 */
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { revealDesktopWindow } from '../reveal.ts';
import { methodNotAllowed, okResult } from './result.ts';

/** 桌面窗口唤起领域：未命中返回 undefined，命中返回应答。 */
export async function handleRevealRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  if (input.rest === 'reveal') {
    // 只有 POST：GET 会被浏览器预取/缓存，唤起窗口有副作用，必须是显式动作。
    if (input.method !== 'POST') return methodNotAllowed();
    const outcome = await revealDesktopWindow(deps.log);
    if (outcome.revealed) return okResult({ revealed: true });
    return okResult({ revealed: false, reason: outcome.reason });
  }
  return undefined;
}
