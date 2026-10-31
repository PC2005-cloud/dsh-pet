/**
 * 对话输入弹窗的挂载与生命周期：定位、关闭、发送。
 * 两端共用同一份实现；它只经注入的 baseUrl/surface 说话，不读配置、不读写记忆。
 * 回复不经响应回传展示：POST 的响应里也有正文，但本组件不用它——回复统一从 /state 的
 * pets.<id>.say 走气泡展示，onSent 只用来催促调用方取一拍。
 * @module dsh-pet/src/shared/chat/dialog
 */
import { ROUTE_PATH } from '../constants.ts';
import { createChatDom } from './dom.ts';
import type { EncodedImage } from './encode.ts';
import { sendChat, type ChatAttachment } from './send.ts';
import { injectChatCss } from './styles.ts';

/** 对话弹窗挂载句柄。 */
export interface ChatDialogMount {
  /** 根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
  /** 开录：快捷键「按住说话」按下时用（麦克风已在录、环境不支持时无动作）。 */
  startHear: () => void;
  /** 收尾：快捷键松开时用（没在录时无动作）。 */
  stopHear: () => void;
  /** 此刻是否真的在采集。 */
  isHearing: () => boolean;
}

/** 发送接线需要的元素与回调。 */
interface SendBinding {
  readonly input: HTMLTextAreaElement;
  readonly err: HTMLElement;
  /** 已含 `?pet=&surface=` 的对话地址。 */
  readonly url: string;
  readonly isClosed: () => boolean;
  /** 发送成功（弹窗尚未关闭）。 */
  readonly onOk: () => void;
  /** 待发送的图片；没有就发纯文本。 */
  readonly attachment: () => ChatAttachment | undefined;
  /** 是否还在压缩图片：是的话先提示，别发出去把图丢掉。 */
  readonly isEncoding: () => boolean;
  /** 非错误提示（"图片还在处理"这类）。 */
  readonly notify: (text: string) => void;
}

/** 点弹窗外或按 Esc 关闭；返回解绑函数。 */
function bindDismiss(root: HTMLElement, isClosed: () => boolean, onDismiss: () => void): () => void {
  const onPointerDown = (e: MouseEvent): void => {
    if (isClosed() || root.contains(e.target as Node)) return;
    onDismiss();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') onDismiss();
  };
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
  };
}

/** 回车发送：成功后回调、失败把原因写进 err 行，不伪造回复。 */
function bindSend(binding: SendBinding): void {
  let sending = false;
  const doSend = (): void => {
    if (binding.isClosed() || sending) return;
    if (binding.isEncoding()) {
      binding.notify('图片还在处理，稍等一下');
      return;
    }
    const text = binding.input.value.trim();
    if (!text) return;
    sending = true;
    binding.input.disabled = true;
    sendChat(binding.url, text, binding.attachment())
      .then((state) => {
        if (state.ok) binding.onOk();
        else {
          binding.err.textContent = '对话失败：' + (state.message ?? state.reason);
          binding.err.style.display = 'block';
        }
      })
      .catch((e) => {
        binding.err.textContent = '对话异常：' + String(e && e.message ? e.message : e);
        binding.err.style.display = 'block';
      })
      .finally(() => {
        sending = false;
        binding.input.disabled = false;
        if (!binding.isClosed()) binding.input.focus();
      });
  };
  binding.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSend();
    }
  });
}

/**
 * 由对话地址推导识别地址：两端传进来的都是 `.../chat`，去掉尾段换成 `/voice/hear`。
 *
 * @param baseUrl - 已含挂载前缀的对话地址。
 * @returns 同前缀下的识别地址。
 */
function hearUrlOf(baseUrl: string): string {
  return baseUrl.replace(/\/chat$/, '') + '/voice/hear';
}

/** 挂载对话弹窗的入参。 */
export interface ChatDialogOptions {
  petId: string;
  /** 端点基址：浏览器默认相对路径，桌面传绝对 URL（file:// 页面需要绝对）。 */
  baseUrl?: string;
  /** 这个弹窗开在哪一端：POST /chat 的 ?surface= 是必填的，宿主据此提前拒掉不可能的组合。 */
  surface: 'web' | 'desktop';
  x: number;
  y: number;
  /** 发送成功后调用（弹窗此时已关闭）：回复本身不从这里回传，数据只有 /state 一个出口。 */
  onSent?: () => void;
  onClose?: () => void;
  /** 弹窗允许占用的矩形（视口局部坐标）；缺省 = 整个视口。 */
  clamp?: { x: number; y: number; w: number; h: number };
  /** 打开时就带着的图片（拖拽落到宠物身上走的这条）；缺省 = 空弹窗。 */
  initialImage?: File;
  /** 截屏实现：浏览器传 getDisplayMedia 抓帧，桌面传 preload 的 IPC 调用；缺省 = 不支持。 */
  capture?: () => Promise<EncodedImage>;
  /**
   * 识别地址；缺省按 `baseUrl` 去掉尾部 `/chat` 推导（两端传进来的都是 `.../chat`）。
   * 给了也用不上时（环境不能录音）按钮不出现，见 createChatDom。
   */
  hearUrl?: string;
}

/** 挂载一个对话输入弹窗（两端共用；位置为视口坐标，超出 clamp 矩形自动夹回）。
 *  输入框 + 上传/截屏两枚图标按钮 + 图片预览（本轮只有界面与本地预览，编码与发送待接入）。
 *  回车即发送：发送成功后弹窗关闭并调 onSent。Esc 或点弹窗外关闭；生成失败留在弹窗内显式提示。
 *  clamp 由调用方给：桌面传「窗口 ∩ 工作区」，宠物贴边时弹窗照样完整显示、窗口零移动。 */
export function mountChatDialog(opts: ChatDialogOptions): ChatDialogMount {
  injectChatCss();
  const { petId, surface, x, y, onSent, onClose, clamp } = opts;
  const baseUrl = opts.baseUrl ?? ROUTE_PATH + '/chat';
  // `surface` 必填（宿主校验）；这个 URL 只用于 POST 发送——GET 读记忆那条路不需要它
  const withPet = baseUrl + '?pet=' + encodeURIComponent(petId) + '&surface=' + surface;
  const c =
    clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h)
      ? clamp
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };

  const dom = createChatDom({ capture: opts.capture, hearUrl: opts.hearUrl ?? hearUrlOf(baseUrl) });
  const { root, input, err } = dom;

  /** 以 (x,y) 落点，超出 clamp 矩形夹回。 */
  const place = (): void => {
    const r = root.getBoundingClientRect();
    root.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - r.width - 4)) + 'px';
    root.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - r.height - 4)) + 'px';
  };

  let closed = false;
  let unbindDismiss = (): void => {};
  const close = (): void => {
    if (closed) return;
    closed = true;
    unbindDismiss();
    dom.dispose();
    dom.clearAttach();
    root.remove();
    if (onClose) onClose();
  };
  unbindDismiss = bindDismiss(root, () => closed, close);
  bindSend({
    input,
    err,
    url: withPet,
    isClosed: () => closed,
    onOk: () => {
      close();
      if (onSent) onSent();
    },
    attachment: () => dom.getAttachment(),
    isEncoding: () => dom.isEncoding(),
    notify: (text) => dom.flash(text),
  });
  // 截屏按钮的接线在 dom 里（依赖注入的 capture），这里只负责发送与关闭

  dom.resizeInput(); // append 后再量一次（此时样式已生效）
  place();
  if (opts.initialImage) void dom.setImageFile(opts.initialImage);
  input.focus();
  return { el: root, close, startHear: dom.startHear, stopHear: dom.stopHear, isHearing: dom.isHearing };
}
