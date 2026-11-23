/**
 * 配置读取与元信息：GET /config 的合并成品、GET /config/meta 的路径清单，以及五个写端点的分发。
 *
 * 写入分居 ./save（用户层 PUT / 同步 POST）、./display（单宠显示位置）、./size（单宠大小）与
 * ./entry（整条目实例）：读路径零副作用，写路径要重建白名单、落盘并重启 Helper，
 * 四者的失败模式与改动原因都不同。
 * 不校验配置形状（归 ../../config）；依赖由 PetRouteDeps 显式传入，模块内不读全局、不建状态。
 * @module dsh-pet/src/host/routes/config/index
 */
import { readAllConfig } from '../../config.ts';
import { type RouteResult } from '../../http.ts';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../../paths.ts';
import { profileNameFrom, storageEntries } from '../../storage-paths.ts';
import { electronLandingDir } from '../../helper-process.ts';
import { TODO_FILE_NAME } from '../../todo/store.ts';
import { homedir } from 'node:os';
import type { PetRouteDeps, RouteInput } from '../types.ts';
import { failResult, okResult } from '../result.ts';
import { saveConfigRoute } from './save.ts';
import { setPetDisplay } from './display.ts';
import { setPetSize } from './size.ts';
import { savePetLayer } from './entry.ts';

/** 内容配置领域：未命中返回 undefined，命中返回应答。 */
export async function handleConfigRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  // 成品配置：GET 读合并成品，其余方法交给写入路径（PUT 保存 / POST 同步默认 / 其它 405）
  if (input.rest === 'config') {
    return input.method === 'GET' ? getConfig(deps) : saveConfigRoute(deps, input);
  }
  // 单只宠物的显示位置（桌面端右键「关闭桌面显示」→ POST /pet-display）
  if (input.rest === 'pet-display') return setPetDisplay(deps, input);
  // 单只宠物的大小（右键「调整大小」的滑块松手 → POST /pet-size）
  if (input.rest === 'pet-size') return setPetSize(deps, input);
  // 整个种类层的实例写回（设置页改文件宠物的配置 → POST /pet-config）
  if (input.rest === 'pet-config') return savePetLayer(deps, input);
  // 配置文件路径 + 存储位置清单（设置页「高级配置」与「卸载与存储」展示用）
  if (input.rest === 'config/meta') return getMeta(deps);
  return undefined;
}

/** 合并成品：唯一配置入口，浏览器 / 桌面 / 设置页直接消费，无需任何校验或兜底。 */
function getConfig(deps: PetRouteDeps): RouteResult {
  try {
    // 动态配置必须杀缓存（与 /state 同口径）：消费端会「发现配置版本变化 → 重拉 /config」，
    // 这一次 GET 若命中缓存就会拿回旧配置，那套机制直接失效。
    return okResult(readAllConfig(deps.configPaths), { 'cache-control': 'no-cache, no-store' });
  } catch (e) {
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
}

/** 路径与存储清单：只读环境与路径，不做业务判断，因此没有失败实体。 */
function getMeta(deps: PetRouteDeps): RouteResult {
  const { log, memesUserRoot, thumbUserRoot, userConfigPath, userRoot } = deps;
  return okResult({
    user: userConfigPath,
    default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
    animations: thumbUserRoot,
    memes: memesUserRoot,
    // 待办数据文件：一份用户级数据（不分宠物），路径与宿主建库时用的是同一个文件名常量。
    todos: join(userRoot, TODO_FILE_NAME),
    // 统一日志出口（就是上面那个 logger 的 file：三种模式都落在 $DSH_HOME/dsh-pet/logs.txt）：
    // 桌面版没有控制台，用户反馈「宠物不出现 / 闪退」时只能靠这个文件。
    logs: log.file,
    // 全部落盘位置（本包用户数据 / Electron 运行时 / 桌面端缓存 / 下载缓存 / 插件本体）：
    // 前两条直接传真实写入方的路径，不在这里重拼目录名
    storage: storageEntries({
      userDataRoot: userRoot,
      electronDir: electronLandingDir(),
      home: homedir(),
      packageRoot: PACKAGE_ROOT,
    }),
    // profile 名（拼卸载命令 dsh plugin --profile <名> remove dsh-pet；反推不出时为空串）
    profile: profileNameFrom(PACKAGE_ROOT) ?? '',
  });
}
