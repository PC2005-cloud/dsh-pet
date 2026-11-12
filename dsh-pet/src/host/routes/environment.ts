/**
 * 环境查询入口：/environment 查此刻的城市与天气，带宠物时写进轮询状态供气泡使用。
 *
 * 数据只有一个来源（./environment），本模块只做门禁、写叶子与应答形态。
 * `pet` 缺省 = 纯查询，不写 S；给了就必须存在，并过显示端、占用锁两道门禁
 * （睡觉门禁在分发器里按 rest 统一挡，见 ./index 的 sleepGated）。
 * @module dsh-pet/src/host/routes/environment
 */
import { readAllConfig } from '../config.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';

/** 环境领域：未命中返回 undefined，命中返回应答。 */
export async function handleEnvironmentRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { configPaths, environment, lockBlocked, requirePet, state, surfaceBlocked } = deps;
  const { method, rest, url } = input;

  if (rest !== 'environment') return undefined;
  if (method !== 'POST') return methodNotAllowed();

  const requested = String(url.searchParams.get('pet') ?? '').trim();
  let petId: string | undefined;
  if (requested !== '') {
    try {
      const cfg = readAllConfig(configPaths);
      const who = requirePet(url.searchParams, () => cfg, { surface: true });
      if (!who.ok) return who.res;
      petId = who.petId;
      // 与 /broadcast 同一套门禁顺序：先看能不能显示，再看有没有被占用
      const noSurface = surfaceBlocked(cfg, petId, url.searchParams);
      if (noSurface) return noSurface;
      const blocked = lockBlocked(petId, url.searchParams);
      if (blocked) return blocked;
    } catch (e) {
      return failResult('generate-error', e instanceof Error ? e.message : String(e));
    }
  }

  // fresh=1 才跳过缓存：菜单是“我要现在最准的”，外部脚本默认走缓存
  const fresh = url.searchParams.get('fresh') === '1';
  const facts = await environment({ fresh });

  const body: Record<string, unknown> = { ok: true };
  if (facts.region !== undefined) body.region = facts.region;
  if (facts.city !== undefined) body.city = facts.city;
  if (facts.weather !== undefined) body.weather = facts.weather;
  if (petId === undefined) return okResult(body);

  // 写叶子：petId 决定哪只宠物点亮气泡；地点与天气原样带出，展示由前端按结构渲染
  state.writeSection('env', {
    ...(facts.region !== undefined ? { region: facts.region } : {}),
    ...(facts.city !== undefined ? { city: facts.city } : {}),
    ...(facts.weather !== undefined ? { weather: facts.weather } : {}),
    petId,
    ts: Date.now(),
  });
  deps.log.info(`[dsh-pet] 环境查询 pet=${petId}${fresh ? '（强制刷新）' : ''}`);
  return okResult({ ...body, petId });
}
