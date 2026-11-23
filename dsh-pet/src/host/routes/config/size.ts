/**
 * 单只宠物的大小（POST /pet-size）：调用方只给 id 与 size（画框宽度，px），层归属由宿主反查。
 *
 * 与 /pet-display 同源：客户端整段读-改-写容易误伤同层其它宠物，也拿不准该写哪一层；
 * 合并后 id 全局唯一，findPetInstance 没有歧义。写入语义与 PUT /config 一致：白名单重建 + 磁盘原值透传。
 * 不解析整段 pets[]，不负责配置读取的合并（归 ../../config）。
 * @module dsh-pet/src/host/routes/config/size
 */
import { findPetInstance, readAllConfig, saveUserConfig } from '../../config.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { type RouteResult } from '../../http.ts';
import type { PetRouteDeps, RouteInput } from '../types.ts';
import { resolveConfigLayer } from './layer.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from '../result.ts';

/**
 * 改一只宠物的 size 并返回改动后的成品聚合。
 *
 * 失败一律 200 + 失败实体：缺 id / size 非法 / 宠物不存在 / 写盘失败都是业务结论；
 * 方法不对与 JSON 坏了发生在业务之前，由协议构造器给真实状态码。
 */
export async function setPetSize(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  if (input.method !== 'POST') return methodNotAllowed();
  let payload: { id?: unknown; size?: unknown };
  try {
    payload = JSON.parse(input.body ?? '') as { id?: unknown; size?: unknown };
  } catch {
    return invalidJson();
  }
  const petId = typeof payload.id === 'string' ? payload.id.trim() : '';
  // 像素是整数语义：0.4 取整成 0 之后照样得按非法拒绝，不能让它混过 >0 的判断。
  const nextSize = Math.round(Number(payload.size));
  // id 必填（与 9 条 `?pet=` 路由同一对词汇：没给 → pet-required；不存在 → unknown-pet）
  if (!petId) return failResult('pet-required', 'pet 必填：要指定操作哪只桌宠');
  if (!Number.isFinite(nextSize) || nextSize <= 0) {
    return failResult('bad-request', `size 必须是大于 0 的像素数：${String(payload.size)}`);
  }
  let merged: Record<string, Record<string, unknown>>;
  try {
    merged = readAllConfig(deps.configPaths);
  } catch (e) {
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
  // 命中不到有两种可能：id 根本不存在，或该实例在合并时因 id 与其它条目重复被跳过（不在聚合里）。
  // 两种都只能按「没有这只桌宠」报——绝不能凭 id 去猜它「应该」属于哪个文件。
  const hit = findPetInstance(merged, petId);
  if (!hit) return failResult('unknown-pet', `没有这只桌宠：${petId}`);
  const resolved = resolveConfigLayer(deps, hit.entry);
  // 单只端点把「条目文件找不到」仍报 generate-error：id 在合并里存在、文件却消失，属于安装或 IO
  // 异常，不是调用方参数问题（整条目端点会把它报成 unknown-entry，两者语义不同）。
  if (!resolved.ok) return failResult('generate-error', `宠物条目配置文件找不到：${hit.entry}`);
  const layer = resolved.layer;
  // 整段替换语义：saveUserConfig 重建的是整个 pets 数组，必须带上该层全部宠物，只把目标
  // 那只的 size 换掉（漏掉别的 = 把它们从配置里删掉）。
  const layerPets = Array.isArray(hit.conf.pets) ? (hit.conf.pets as Record<string, unknown>[]) : [];
  const pets = layerPets.map((p) => (String(p.id) === petId ? { ...p, size: nextSize } : p));
  const clean = saveUserConfig({ pets }, layer.existing);
  if (!clean) return failResult('bad-request', '宠物配置非法');
  try {
    await mkdir(layer.dir, { recursive: true });
    await writeFile(layer.path, JSON.stringify(clean, null, 2), 'utf8');
  } catch (e) {
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
  // 配置变更信号（只在写盘成功之后：失败时不该动版本号，否则浏览器白重拉一次 /config）。
  // 桌面端右键改大小时浏览器页面不是发起方，只能靠它发现「配置被别处改过」。
  deps.state.writeSection('config', {});
  // 不 await：发起者很可能就是即将被这次重载换掉的桌面 Helper（与 /reload 同一处境）。
  // 写盘已经落定，重启结果不需要回给调用方。
  void deps.requestRestart();
  // 响应体 = 改动后的成品聚合（与 PUT / POST /config 同形）：调用方直接把它交给 petBridge.reload，
  // 不必再发一次 GET /config，也就不会拿到可能陈旧的配置。
  return okResult(readAllConfig(deps.configPaths));
}
