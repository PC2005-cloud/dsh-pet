/**
 * 余额查询入口：/balance 主动刷新并返回成品快照。
 *
 * 不实现各服务商的取数协议（归 ./balance/providers）。
 * `pet` 缺省 = 全局刷新，所有开了余额的宠物照常显示（第三方与斜杠命令走这条）；
 * 给了就只让该宠物显示，并依次过显示端与占用锁门禁（睡觉由分发器统一挡）。
 * 依赖（PetRouteDeps）显式传入，模块内不读全局、不建状态。
 * @module dsh-pet/src/host/routes/balance
 */
import { readAllConfig } from '../config.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** 余额领域：未命中返回 undefined，命中返回应答。 */
export async function handleBalanceRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { configPaths, lockBlocked, refreshBalance, requirePet, surfaceBlocked } = deps;
  const { method, rest, url } = input;

  // 余额：POST /balance 立即刷新一次并写入 S，返回 {ok}——不返回余额数据，数据只有 /state 一个出口。
  // 前端已不再各自定时查余额，也没有计数轮询中转端点。
  if (rest !== 'balance') return undefined;
  if (method !== 'POST') return methodNotAllowed();

  const requested = String(url.searchParams.get('pet') ?? '').trim();
  if (requested === '') {
    // 不带 pet：老调用方与 /balance 命令的路，不写归属 → 所有开了余额的宠物都照常显示
    await refreshBalance(true);
    return okResult({ ok: true });
  }
  try {
    const cfg = readAllConfig(configPaths);
    const who = requirePet(url.searchParams, () => cfg, { surface: true });
    if (!who.ok) return who.res;
    // 与 /broadcast、/environment 同一套门禁顺序：先看能不能显示，再看有没有被占用
    const noSurface = surfaceBlocked(cfg, who.petId, url.searchParams);
    if (noSurface) return noSurface;
    const blocked = lockBlocked(who.petId, url.searchParams);
    if (blocked) return blocked;
    await refreshBalance(true, who.petId);
    return okResult({ ok: true });
  } catch (e) {
    // 配置读取失败等（安装损坏）→ 显式失败，不静默（与其它动作端点同一口径）
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
}
