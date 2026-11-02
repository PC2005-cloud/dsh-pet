/**
 * 取图：把对话记忆里记下的图片引用读回成浏览器能显示的图。
 *
 * 只校验 id 形状、把引用交给宿主附件服务算路径——插件自己不拼任何文件路径，路径穿越无从谈起。
 * 不校验归属（id 是内容哈希、不可猜，服务只监听回环），也不做缩放（原图 + 缓存头，够用）。
 * 附件对象按 sha256 命名、没有扩展名，所以类型只能从文件头判断，不能从文件名猜。
 * @module dsh-pet/src/host/routes/attachment
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { IMAGE_HEAD_BYTES, imageTypeOf } from '../http.ts';
import type { PetImageLocator, PetImageSink } from '../image-attachment.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';

/** 附件 id 的合法形状（与宿主附件服务同一规则）：`sha256:` + 64 位小写 hex。 */
const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/;

/** 取图领域：未命中返回 undefined，命中返回应答。 */
export async function handleAttachmentRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { method, rest, url } = input;
  if (rest === 'attachment') {
    if (method !== 'GET') return { kind: 'text', status: 405, body: 'dsh-pet: method not allowed' };
    const id = url.searchParams.get('id') ?? '';
    if (!ATTACHMENT_ID.test(id)) return { kind: 'text', status: 400, body: 'dsh-pet: invalid attachment id' };
    const sink = deps.optionalService('attachments') as PetImageSink | undefined;
    // 独立模式没有附件服务：取图直接不可用（与 POST /chat 的图片能力同一降级口径）
    const file = locate(sink, id);
    if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: attachment not found' };
    const contentType = sniffImageType(file);
    if (contentType === undefined) {
      return { kind: 'text', status: 404, body: 'dsh-pet: attachment is not a displayable image' };
    }
    return { kind: 'file', file, contentType };
  }
  return undefined;
}

/** 用附件服务定位对象；服务缺失、后端非文件式、引用非法或对象已被清掉都返回 undefined。 */
function locate(sink: PetImageSink | undefined, id: string): string | undefined {
  if (typeof sink?.imageHostPath !== 'function') return undefined;
  try {
    const file: string | undefined = sink.imageHostPath({ attachmentId: id } as PetImageLocator);
    return file !== undefined && existsSync(file) ? file : undefined;
  } catch {
    // 引用非法 / 后端拒绝：对客户端就是「图不存在」，不把内部错误文案漏出去
    return undefined;
  }
}

/** 按文件头判断图片类型；只认附件服务会存的四种，读不到或认不出返回 undefined。 */
function sniffImageType(file: string): string | undefined {
  try {
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(IMAGE_HEAD_BYTES);
      return imageTypeOf(head, readSync(fd, head, 0, IMAGE_HEAD_BYTES, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined; // 读的瞬间被清理 / 权限不足：同样按不存在处理
  }
}
