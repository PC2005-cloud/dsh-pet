/**
 * 第三方右键菜单：注册项查询、点击消费与事件长轮询。
 *
 * 不渲染菜单，不决定菜单层级（归 shared/menu）。
 * 依赖（PetRouteDeps）显式传入，模块内不读全局、不建状态。
 * @module dsh-pet/src/host/routes/menu
 */
import { MENU_WAIT_MAX_MS } from '../menu.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

/** 第三方菜单领域：未命中返回 undefined，命中返回应答。 */
export async function handleMenuRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { menuRegistry, state } = deps;
  const { body, method, rest, url } = input;

  // 第三方右键菜单：POST /menu/item 注册（该 owner 整体覆盖），DELETE 清除，GET /menu/events
  // 读取即消费（支持长轮询），POST /menu/click 由渲染端上报。
  // 注册表在进程内存，快照写进 S 的 sections.menu：两端据此拼「更多」与一级菜单项，注册后不用重启 Helper。
  // 业务失败一律 200 + { ok:false, reason, message }；400 只留给 JSON 坏了，405 只留给方法错。
  if (rest === 'menu/item') {
    if (method === 'DELETE') {
      const result = menuRegistry.clear(url.searchParams.get('owner') ?? '');
      if (!result.ok) return failResult(result.reason, result.message);
      state.writeSection('menu', { items: menuRegistry.snapshot() });
      return okResult({ ok: true, removed: result.removed });
    }
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? '');
    } catch {
      return invalidJson();
    }
    const result = menuRegistry.register(parsed);
    if (!result.ok) return failResult(result.reason, result.message);
    // 写入会唤醒所有挂起的长轮询；两端拿到新 counter 就重拼菜单（下一次右键即生效）
    state.writeSection('menu', { items: menuRegistry.snapshot() });
    return okResult({ ok: true });
  }

  if (rest === 'menu/events') {
    if (method !== 'GET') return methodNotAllowed();
    const owner = url.searchParams.get('owner') ?? '';
    const rawWait = Number(url.searchParams.get('wait') ?? '0');
    const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, MENU_WAIT_MAX_MS) : 0;
    // 挂起等待期间调用方断开：不额外处理（最多白挂 MENU_WAIT_MAX_MS，无状态残留）
    const events = await menuRegistry.poll(owner, waitMs);
    // owner 不存在（没注册过 / 被清除了 / 宿主重启过）：业务失败，仍是 200
    if (events === null) return failResult('unknown-owner', '这个 owner 没有注册，重新注册即可');
    return okResult({ ok: true, events });
  }

  if (rest === 'menu/click') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? '');
    } catch {
      return invalidJson();
    }
    // delivered=false（项已不在）= 正常竞态：渲染端拿的是上一拍快照，仍回 200
    return okResult(menuRegistry.click(parsed));
  }

  return undefined;
}
