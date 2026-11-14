/**
 * 配置写入：PUT /config 保存用户层，POST /config 用内置默认整份覆盖。
 *
 * 写入顺序固定：白名单重建 → 落盘 → 异步重启 Helper；失败一律 200 + 失败实体，不留半个文件。
 * 不校验配置形状（归 ../../config），不碰单宠显示位置（归 ./display）。
 * @module dsh-pet/src/host/routes/config/save
 */
import {
  readAllConfig,
  readUserConfig,
  saveUserConfig,
  syncUserConfigFromDefault,
  userConfigUnparsable,
} from '../../config.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { resetUapiCache } from '../../uapi.ts';
import { type RouteResult } from '../../http.ts';
import type { PetRouteDeps, RouteInput } from '../types.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from '../result.ts';

/**
 * 写端点分发：PUT 保存用户层，POST 同步内置默认，其余方法 405。
 * @param deps - 路由层依赖（路径、日志、重启意图）。
 * @param input - 已解析的请求（方法、请求体、查询串）。
 */
export async function saveConfigRoute(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  if (input.method === 'PUT') return saveUserLayer(deps, input);
  if (input.method === 'POST') return syncFromDefault(deps);
  return methodNotAllowed();
}

/** 白名单重建用户层后写盘，响应体是保存后的成品聚合。 */
async function saveUserLayer(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  const { configPaths, ctx, requestRestart, userConfigPath, userRoot } = deps;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body ?? '');
  } catch {
    return invalidJson();
  }
  try {
    // 透传保留：读当前磁盘上的用户文件原对象，把非白名单顶层字段带回给 saveUserConfig，
    // 保存不再抹掉用户手改的精调配置。
    // 必须走 JSONC 容忍解析器（readUserConfig）：用户层可能是带 // 注释的 config.jsonc 原文，
    // 严格 JSON.parse 会抛错并吞掉 → existing 变 undefined → 白名单重建 → 高级字段全丢。
    const existing = readUserConfig(configPaths);
    const clean = saveUserConfig(parsed, existing);
    if (!clean) {
      return failResult(
        'bad-request',
        'invalid pet config: expected { pets:[{name?,id,size,sizePercent?,balanceEnabled,display,position:{corner,marginX,marginY}}] }（id 为非空字符串且去除首尾空白后唯一；sizePercent 可选，不小于 1 的数字；display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / notifyWhenFocused / whisperImageEnabled / chatImageEnabled / chatAnimationEnabled / trayEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）',
      );
    }
    // 损坏预检：用户层存在但连 JSONC 都解析不了（真损坏）→ 先不写盘。
    // 保存是白名单重建，existing 读不出来就等于把文件里剩下的内容整份丢掉，而且静默——
    // 所以回 needConfirm 让设置页弹窗（取消 = 不动文件；确认 = 带 ?force=1 强行重建）。
    if (input.url.searchParams.get('force') !== '1' && userConfigUnparsable(configPaths)) {
      return failResult('user-config-unparsable', '用户配置无法解析，需确认后重建', {
        needConfirm: true,
        userFile: userConfigPath,
      });
    }
    await mkdir(userRoot, { recursive: true });
    await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
    // 配置变了，UAPI 那条缓存必须作废：否则改完城市得等 TTL（10 分钟）过期才生效，
    // 而碎碎念与外部脚本不带 fresh，会一直读到旧城市
    resetUapiCache();
    void requestRestart(); // display/size 等可能变化：重解析桌面宠物并重启 Helper（异步，不阻塞保存响应）
    // 响应体 = 保存后的成品聚合（与 GET /config 同一份，字段已填满）：设置页直接交给
    // flattenConfigPets 拍平渲染，客户端的条目级字段只有这一处填充。
    return okResult(readAllConfig(configPaths));
  } catch (e) {
    ctx.logger?.warn?.(`[dsh-pet] config save failed: ${e instanceof Error ? e.message : String(e)}`);
    return failResult('generate-error', 'failed to save config');
  }
}

/**
 * 把内置默认配置（`assets/config.jsonc` 原文，含注释）整份写入用户配置。
 *
 * 既是「恢复默认」（合并结果 = 内置默认），又给用户留下一份可直接编辑的完整配置，
 * 不必再自己从包内复制一份（见 ../config 的 syncUserConfigFromDefault）。
 */
function syncFromDefault(deps: PetRouteDeps): RouteResult {
  const { configPaths, requestRestart } = deps;
  try {
    syncUserConfigFromDefault(configPaths);
  } catch (e) {
    // 默认文件缺失 / 用户目录不可写：显式失败，绝不静默留下半个配置文件
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
  void requestRestart(); // 配置变了：重解析桌面宠物并重启 Helper（异步，不阻塞响应）
  return okResult(readAllConfig(configPaths));
}
