/**
 * 宠物头像上传：`POST /pet-avatar?root=<素材根>`，体是 `{ base64 }`。
 *
 * 为什么走 base64 而不是原始字节：宿主请求体统一按 utf8 解码（见 http.ts 的 readBody），
 * 二进制裸流在解码处就被破坏；JSON 也让本端点与其它写端点共用同一套错误结论。
 * 只校验「文件头像图片 + 在预算内」，不裁剪不重编码——尺寸与画质由前端压到长边 512 担保。
 * @module dsh-pet/src/host/routes/avatar
 */
import { isValidPetId } from '../config.ts';
import { savePetAvatar } from '../pet-avatar.ts';
import { failResult, invalidJson, methodNotAllowed, okResult, payloadTooLarge } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';

/** 解码后的字节上限：请求体 1 MiB 是 base64 文本的上限，解码后天然不超过 768 KiB。 */
const MAX_AVATAR_BYTES = 768 * 1024;

/**
 * 头像上传领域：未命中返回 undefined，命中返回应答。
 *
 * 写成 `rest === 'pet-avatar'` 的正向分支而不是反向守卫：scripts/check-openapi.mjs 按这个
 * 字面量收集宿主实现的路由，反向写法会让文档里的路径被误报成「实现里不存在」。
 */
export async function handleAvatarRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  if (input.rest === 'pet-avatar') return acceptUpload(deps, input);
  return undefined;
}

/**
 * 受理一次上传。
 *
 * @param deps - 路由层依赖（只用到文件宠物目录）。
 * @param input - 已解析的请求（方法、URL、请求体）。
 * @returns 成功，或按原因分档的业务/协议失败。
 */
async function acceptUpload(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  if (input.method !== 'POST') return methodNotAllowed();

  // 参数叫 root 而不是 pet：这里要的是素材根（目录前缀），不是 pets[].id（见 openapi 的 PetIdQuery）。
  const assetRoot = (input.url.searchParams.get('root') ?? '').trim();
  if (assetRoot === '') return failResult('bad-request', '缺少 root 参数（素材根）');
  // 素材根是标识符不是路径片段：含分隔符/保留字符即拒，早于任何路径拼接。
  if (!isValidPetId(assetRoot)) return failResult('bad-request', '素材根不合法');
  // pet/ 只归 pet pack：内置条目用插件默认 logo，不接受写入（也不该在 pet/ 里留下 main 的文件）。
  if (assetRoot === 'main') return failResult('bad-request', '内置条目不能换头像：main 不写入 pet/ 目录');

  let raw: unknown;
  try {
    raw = JSON.parse(input.body ?? '');
  } catch {
    return invalidJson();
  }
  const base64 = typeof raw === 'object' && raw !== null ? (raw as { base64?: unknown }).base64 : undefined;
  if (typeof base64 !== 'string' || base64 === '') return failResult('bad-request', 'base64 必须是非空字符串');

  // Buffer 解码会静默丢弃非法字符，所以用「重新编码必须与原文一致」确认它是规范 base64。
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== base64) return failResult('bad-request', 'base64 不合法');
  if (bytes.length > MAX_AVATAR_BYTES) return payloadTooLarge('头像超过 768 KiB');

  const saved = savePetAvatar(deps.petConfigDir, assetRoot, bytes);
  if (!saved.ok) {
    return saved.reason === 'not-image'
      ? failResult('unsupported', '只支持 PNG / JPEG / WebP / GIF')
      : failResult('internal-error', '头像写入失败');
  }
  return okResult({ ok: true });
}
