/**
 * 对话图片的压缩与编码：把一张文件或一块画布压进宿主可接受的预算，产出可发送的 base64。
 * 纯计算（尺寸换算、字节反推）与 DOM（解码、canvas）分开，前者可单测。
 * 预算依据：宿主按 1 MiB 请求体拒绝，base64 膨胀 4/3，所以解码后上限取 640 KiB。
 * 解码与 base64 编码两个小件（{@link loadImage}、{@link bytesToBase64}）也供设置页的头像上传感复用——
 * 头像的预算与质量阶梯不同，但「怎么把文件读成图、怎么读成规范 base64」只有这一份实现。
 * @module dsh-pet/src/shared/chat/encode
 */
import { type PetImageMediaType, imageMediaTypeOf } from './image-pick.ts';

/** 单张图片的字节上限（解码后）。 */
export const IMAGE_MAX_BYTES = 640 * 1024;
/** 长边上限：再大对"看清报错文字"没有收益，只会挤占请求体。 */
export const IMAGE_MAX_SIDE = 2048;
/** 质量阶梯：从高到低，第一档进预算就停。 */
export const IMAGE_QUALITIES = [0.85, 0.75, 0.65, 0.55] as const;
/** 预览缩略图的长边（像素）：只用于弹窗里那枚 24×24。 */
const PREVIEW_SIDE = 96;

/** 按 base64 长度反推字节数（不重新解码）。 */
export function attachmentBytes(base64: string): number {
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - pad;
}

/** 缩到长边上限后的目标尺寸；不放大。 */
export function targetSize(width: number, height: number, maxSide = IMAGE_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** 编码结果：`base64` 是要发出去的载荷，`previewUrl` 只给缩略图用。 */
export interface EncodedImage {
  readonly base64: string;
  readonly mediaType: PetImageMediaType;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** 是否重新编码过（原图超限，或来源本来就是画布）。 */
  readonly resized: boolean;
  /** 小尺寸预览（几十 KB 以内），避免把整张图的 data URL 挂在 DOM 上。 */
  readonly previewUrl: string;
}

/**
 * 把文件解码成 `<img>`。
 *
 * 用 `FileReader` 的 data URL 而不是 `URL.createObjectURL`：桌面 helper 的 CSP 是
 * `img-src 'self' http: https: data:`，不含 `blob:`，objectURL 在那边会被拦成 onerror
 * （表现为"这个文件解不出图片"，而浏览器端正常）。
 *
 * @param file - 用户选中的图片文件。
 * @returns 解码完成的图片元素。
 * @throws 文件读不出来或解不出图片时。
 */
export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('这个文件读不出来'));
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      if (!url) {
        reject(new Error('这个文件读不出来'));
        return;
      }
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('这个文件解不出图片'));
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 字节 → 规范 base64（分块，避免 String.fromCharCode 参数过多爆栈）。
 *
 * @param bytes - 已读进内存的原始字节。
 * @returns 不带 data: 前缀的规范 base64。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/** 把源按目标尺寸画进一张新画布。 */
function drawToCanvas(source: CanvasImageSource, size: { width: number; height: number }): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext('2d')?.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
}

/** 缩略图：96px、JPEG 0.72，几 KB 就够 24×24 显示。 */
function previewOf(source: CanvasImageSource, width: number, height: number): string {
  return drawToCanvas(source, targetSize(width, height, PREVIEW_SIDE)).toDataURL('image/jpeg', 0.72);
}

/**
 * 把一块画布压进预算：按质量阶梯转 JPEG，第一档进预算就停。
 *
 * @param canvas - 已按目标尺寸画好的画布（文件与截屏共用这条）。
 * @returns 载荷与预览；压不进预算时抛错。
 */
export function encodeCanvas(canvas: HTMLCanvasElement): EncodedImage {
  const { width, height } = canvas;
  const previewUrl = previewOf(canvas, width, height);
  const floor = IMAGE_QUALITIES[IMAGE_QUALITIES.length - 1];
  for (const quality of IMAGE_QUALITIES) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bytes = attachmentBytes(base64);
    if (bytes <= IMAGE_MAX_BYTES || quality === floor) {
      return { base64, mediaType: 'image/jpeg', bytes, width, height, resized: true, previewUrl };
    }
  }
  throw new Error('无法压到预算内');
}

/**
 * 把一张图片文件编码成可发送的附件。
 *
 * 原图够小就原样发送（不重编码：JPEG 再压一次会掉画质，动图也能保住）；
 * 超限才缩到长边上限、按质量阶梯逐档压到预算内。
 *
 * @param file - 已通过 `isImageFile` 的文件。
 * @returns 载荷与预览；压不进预算时抛错（调用方提示用户换图）。
 */
export async function encodeImageFile(file: File): Promise<EncodedImage> {
  const mediaType = imageMediaTypeOf(file);
  if (!mediaType) throw new Error('不是可发送的图片');
  const img = await loadImage(file);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const raw = new Uint8Array(await file.arrayBuffer());
  if (raw.length <= IMAGE_MAX_BYTES && Math.max(width, height) <= IMAGE_MAX_SIDE) {
    return {
      base64: bytesToBase64(raw),
      mediaType,
      bytes: raw.length,
      width,
      height,
      resized: false,
      previewUrl: previewOf(img, width, height),
    };
  }
  const target = targetSize(width, height);
  return encodeCanvas(drawToCanvas(img, target));
}
