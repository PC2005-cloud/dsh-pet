/**
 * 单只宠物的显示位置（POST /pet-display）：调用方只给 id 与 display，层归属由宿主反查。
 *
 * 客户端整段读-改-写容易误伤同层其它宠物，也拿不准该写哪一层；合并后 id 全局唯一，
 * findPetInstance 没有歧义。写入语义与 PUT /config 一致：白名单重建 + 磁盘原值透传。
 * 不解析整段 pets[]，不负责配置读取的合并（归 ../../config）。
 * @module dsh-pet/src/host/routes/config/display
 */
import { PET_DISPLAY_SET, findPetInstance, readAllConfig, saveUserConfig } from '../../config.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { type RouteResult } from '../../http.ts';
import type { PetRouteDeps, RouteInput } from '../types.ts';
import { resolveConfigLayer } from './layer.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from '../result.ts';

/**
 * 改一只宠物的 display 并返回改动后的成品聚合。
 *
 * 失败一律 200 + 失败实体：缺 id / display 非法 / 宠物不存在 / 写盘失败都是业务结论；
 * 方法不对与 JSON 坏了发生在业务之前，由协议构造器给真实状态码。
 */
export async function setPetDisplay(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  if (input.method !== 'POST') return methodNotAllowed();
  let payload: { id?: unknown; display?: unknown };
  try {
    payload = JSON.parse(input.body ?? '') as { id?: unknown; display?: unknown };
  } catch {
    return invalidJson();
  }
  const petId = typeof payload.id === 'string' ? payload.id.trim() : '';
  const nextDisplay = String(payload.display ?? '');
  // id 必填（与 9 条 `?pet=` 路由同一对词汇：没给 → pet-required；不存在 → unknown-pet）
  if (!petId) return failResult('pet-required', 'pet 必填：要指定操作哪只桌宠');
  if (!PET_DISPLAY_SET.has(nextDisplay)) {
    return failResult('bad-request', `display 必须是 web / desktop / both / none：${nextDisplay}`);
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
  // 那只的 display 换掉（漏掉别的 = 把它们从配置里删掉）。
  const layerPets = Array.isArray(hit.conf.pets) ? (hit.conf.pets as Record<string, unknown>[]) : [];
  const pets = layerPets.map((p) => (String(p.id) === petId ? { ...p, display: nextDisplay } : p));
  const clean = saveUserConfig({ pets }, layer.existing);
  if (!clean) return failResult('bad-request', '宠物配置非法');
  try {
    await mkdir(layer.dir, { recursive: true });
    await writeFile(layer.path, JSON.stringify(clean, null, 2), 'utf8');
  } catch (e) {
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
  // 配置变更信号（只在写盘成功之后：失败时不该动版本号，否则浏览器白重拉一次 /config）。
  // 单只端点（本路由与 /pet-size）是 sections.config 的写方：保存 / 同步配置的调用方自己就拿到了
  // 成品聚合（响应体），桌面端由下面的 requestRestart() 重启，都不需要这个信号；而桌面端右键改
  // display / 大小 时浏览器页面不是发起方，只能靠它发现「配置被别处改过」。
  deps.state.writeSection('config', {});
  // 占用锁：改成 `none`（桌面端右键「关闭桌面显示」）＝ 用户主动隐藏/关闭，属于抢占——
  // 撤销本轮占用（cause: preempted）。不做的话宠物会被锁到 TTL 到点，而用户明明已经把它藏了
  // （issue #122：「用户主动停止、隐藏或关闭时，也应能取消联动，避免宠物被永久锁住」）。
  // 只认 `none`：web/desktop/both 是换显示位置，不是「用户接管」。
  if (nextDisplay === 'none') deps.lock.release({ petId, force: true });
  // 不 await：发起者很可能就是即将被这次重载换掉的桌面 Helper（与 /reload 同一处境）。
  // 写盘已经落定，重启结果不需要回给调用方。
  void deps.requestRestart();
  // 响应体 = 改动后的成品聚合（与 PUT / POST /config 同形）：调用方（浏览器端右键菜单）
  // 直接把它交给 petBridge.reload，不必再发一次 GET /config —— 与设置页保存走的是同一条路，
  // 也就不会拿到可能陈旧的配置（现场表现：不返回聚合时浏览器端要刷新才生效）。
  return okResult(readAllConfig(deps.configPaths));
}
