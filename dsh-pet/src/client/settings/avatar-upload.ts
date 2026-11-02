/**
 * 设置页的头像上传：把选中的图片缩到长边 512、转 base64，POST 给宿主覆盖写入。
 *
 * 不复用对话附图的压缩链路：对话图按 640 KiB / 2048 长边压成 JPEG 省请求体，头像是方寸小图、
 * 还要保住透明背景，所以这里只缩边、统一编成 PNG，不套质量阶梯。
 * 编码与提交分成两个函数：编码要 canvas，测试环境没有，网络分支才能单独测。
 * @module dsh-pet/src/client/settings/avatar-upload
 */
import { ROUTE_PATH } from '../../shared/constants.ts';
import { bytesToBase64, loadImage } from '../../shared/chat/encode.ts';

/** 头像长边上限（px）：聊天面板按 28px 显示，512 足够清晰，再大只是白占请求体。 */
export const AVATAR_MAX_SIDE_PX = 512;

/** 上传结果：成功，或可直接展示给用户的失败文案。 */
export type AvatarUpload = { ok: true } | { ok: false; message: string };

/**
 * 把图片文件压进长边上限并转成规范 base64。
 *
 * 已在范围内就原样上传（不重编码：透明、动图、高 DPI 都不掉）；超限才缩边并统一编成 PNG——
 * 用 JPEG 会把透明区域填成黑底。动图超限时只剩第一帧，这是缩放的固有代价。
 *
 * @param file - 用户选中的图片文件。
 * @returns 规范 base64 与媒体类型。
 * @throws 解不出图片，或浏览器拿不到 2D 画布时。
 */
export async function encodeAvatarFile(file: File): Promise<{ base64: string; mediaType: string }> {
  const img = await loadImage(file);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  if (Math.max(width, height) <= AVATAR_MAX_SIDE_PX) {
    return { base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())), mediaType: file.type || 'image/png' };
  }
  const scale = AVATAR_MAX_SIDE_PX / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('浏览器不支持缩放这张图');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/png');
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/png' };
}

/**
 * 把编码后的头像发给宿主（覆盖旧图）。
 *
 * @param assetRoot - 宠物所属素材根；文件宠物用目录前缀，内置用 `main`（宿主会拒）。
 * @param base64 - 规范 base64（不带 `data:` 前缀）。
 * @param fetchImpl - 注入的 fetch，测试用替身；生产不传，取全局 fetch。
 * @returns 成功，或宿主 / 网络给出的失败文案。
 */
export async function postAvatar(
  assetRoot: string,
  base64: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AvatarUpload> {
  const res = await fetchImpl(ROUTE_PATH + '/pet-avatar?root=' + encodeURIComponent(assetRoot), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base64 }),
  });
  const raw = (await res.json().catch(() => null)) as { ok?: unknown; message?: unknown } | null;
  if (!res.ok || raw === null) return { ok: false, message: '上传失败（HTTP ' + res.status + '）' };
  if (raw.ok !== true) return { ok: false, message: typeof raw.message === 'string' ? raw.message : '上传失败' };
  return { ok: true };
}

/**
 * 上传一只宠物的头像（编码 + 提交）。
 *
 * @param assetRoot - 宠物所属素材根。
 * @param file - 用户选中的图片文件。
 * @returns 成功，或编码 / 宿主 / 网络给出的失败文案。
 */
export async function uploadPetAvatar(assetRoot: string, file: File): Promise<AvatarUpload> {
  const { base64 } = await encodeAvatarFile(file);
  return postAvatar(assetRoot, base64);
}
