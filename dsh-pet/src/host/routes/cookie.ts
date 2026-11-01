/**
 * cookie 体检：`POST /cookie?pet=` 读一次 cookie 库，把占用情况写进这只宠物的气泡。
 *
 * 与 `/balance` 同一套分工：动作端点只负责触发与写叶子，页面照旧从 `/state` 读；
 * 响应体里的数字是给接口调用方看的，不是页面渲染的必需路径（本插件自己的前端也不读它）。
 * 读不到时不伪造条数，把原因原样说进气泡——失败面板与正常面板在界面上是同一个位置。
 * @module dsh-pet/src/host/routes/cookie
 */
import { readAllConfig } from '../config.ts';
import { cookieBubbleText, gaugeOf } from '../cookie/gauge.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** cookie 领域：未命中返回 undefined，命中返回应答。 */
export async function handleCookieRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const isCookie = input.rest === 'cookie';
  if (!isCookie) return undefined;
  if (input.method !== 'POST') return methodNotAllowed();

  const { configPaths, cookieGuard, requirePet, state } = deps;
  try {
    const who = requirePet(input.url.searchParams, () => readAllConfig(configPaths));
    if (!who.ok) return who.res;

    // force=1 对应「用户自己点的」：可穿透 60 秒缓存，但仍受 5 秒最小间隔约束。
    const probe = await cookieGuard.inspect(input.url.searchParams.get('force') === '1');
    if (!probe.ok) {
      const text = `读不到 cookie 库：${probe.reason}`;
      state.writePet(who.petId, 'say', { text, anim: false });
      return failResult('unsupported', text);
    }

    const gauge = gaugeOf(probe.count);
    state.writePet(who.petId, 'say', { text: cookieBubbleText(gauge), anim: false });
    return okResult({ ok: true, gauge, source: probe.source, fileSize: probe.fileSize, elapsedMs: probe.elapsedMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log.warn(`[dsh-pet] cookie 体检失败：${message}`);
    return failResult('generate-error', message);
  }
}
