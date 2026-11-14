/**
 * 对话图片入参的解析：把线上 JSON 的 `attachment` 变成附件服务可直接接收的字节。
 * 不做 IO、不碰附件服务——落盘与权威校验（解码真实性、像素上限）在路由层，本模块只负责
 * 形状、媒体类型白名单与 base64 规范化。
 * @module dsh-pet/src/host/image-attachment
 */

/** 图片媒体类型白名单，与宿主附件服务接受的集合一致。 */
export type PetImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** 一张已落盘的图片：只声明 pet 用到的字段，不引 @deepseek-ai/dsh-attachment 的类型包。 */
export interface PetImageRef {
  readonly attachmentId: string;
  readonly mediaType: PetImageMediaType;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

/** 定位一张已落盘图片所需的最小信息：对象路径只由 attachmentId 决定。 */
export interface PetImageLocator {
  readonly attachmentId: string;
}

/** 附件服务的最小形状：DSH 宿主提供，独立模式缺失。 */
export interface PetImageSink {
  /** 部署级单图字节上限；缺失视为不设限（服务内部仍会权威校验）。 */
  readonly imageLimits?: { readonly maxImageBytes?: number };
  /** 校验并持久化一批图片，返回与入参同序的引用。 */
  saveImages(inputs: readonly { data: Uint8Array; mediaType: PetImageMediaType }[]): Promise<readonly PetImageRef[]>;
  /** 宿主文件后端上的绝对路径；非文件后端不提供此方法（取图端点据此回 404）。 */
  imageHostPath?(ref: PetImageLocator): string | undefined;
}

/** 解析结论；失败时 message 直接作为 bad-request 的文案。 */
export type ParsedImage =
  | { readonly ok: true; readonly mediaType: PetImageMediaType; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly message: string };

/** 允许的媒体类型；顺序用于错误文案，与宿主附件服务的白名单保持一份事实。 */
const MEDIA_TYPES: readonly PetImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** base64 字符上限：按对话配图本身的需要定，不随请求体上限放大。 */
const MAX_BASE64_CHARS = 900_000;

/**
 * 解析请求体里的 `attachment`。
 *
 * @param raw - 未经校验的原始值。
 * @returns 规范 base64 解出的字节与媒体类型；失败时给出可直接下发的文案。
 */
export function parseImageAttachment(raw: unknown): ParsedImage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'attachment 必须是对象' };
  }
  const { mediaType, data } = raw as Record<string, unknown>;
  if (typeof mediaType !== 'string' || !MEDIA_TYPES.includes(mediaType as PetImageMediaType)) {
    return { ok: false, message: `attachment.mediaType 必须是 ${MEDIA_TYPES.join(' / ')} 之一` };
  }
  if (typeof data !== 'string' || data === '') {
    return { ok: false, message: 'attachment.data 必须是非空 base64 字符串' };
  }
  if (data.length > MAX_BASE64_CHARS) {
    return { ok: false, message: 'attachment.data 过长（请压缩或降低分辨率）' };
  }
  // Buffer 解码会静默丢弃非法字符，所以用「重新编码必须与原文一致」确认它确实是规范 base64；
  // 否则 `"abc!!!"` 会被悄悄解成别的字节，调用方以为发了 A、模型看到的却是 B。
  const decoded = Buffer.from(data, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== data) {
    return { ok: false, message: 'attachment.data 不是合法的 base64' };
  }
  return { ok: true, mediaType: mediaType as PetImageMediaType, bytes: new Uint8Array(decoded) };
}
