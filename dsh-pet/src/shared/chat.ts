// 对话输入弹窗（src/shared，浏览器 bundle 与桌面 shared-core 共用）：
//  - 纯逻辑：类型 / 发送（走 host /dsh-pet-7340/chat，host 是 memory.json 唯一读写方
//    —— 浏览器与桌面同一实例天然共享同一份记忆，两端只是不同显示方式）；
//  - CHAT_CSS + mountChatDialog：自 menu.ts 之后第二个「两端共用同一份 DOM」例外
//    （菜单组件证明可行的模式：浏览器页面与桌面透明窗渲染完全一致的对话框）。
// 交互语义（与碎碎念同一显示效果，只多一步用户输入）：
//    右键菜单「对话」→ 极简输入框 + 确认 → 点确认后弹窗消失 →
//    桌宠把回复用碎碎念同款方式展示（说话动画 + 白色气泡 10s 消失）——
//    此处只负责「拿到输入 → host 生成回复 → 通过 onReply 交回调用方」，
//    展示/动画由调用方走碎碎念那条链路（两端各自的 triggerWhisper / showWhisper）。
// 记忆语义：memory.json 全存不删；host 每次请求只截尾部 chatMemoryRounds 轮进上下文。

/** POST /dsh-pet-7340/chat?pet=<id> {text}：新回复（host 已写入记忆） */
export type ChatSendState =
  | { ok: true; reply: string; ts: number }
  | { ok: false; reason: 'provider-missing' | 'generate-error' | 'config-error' | 'bad-request'; message?: string };

const SEND_TIMEOUT_MS = 60_000; // 对话要等 LLM 生成回复，比碎碎念（30s）放宽一倍

/** 发送一句对话（携带记忆去 host 生成回复；host 写入记忆后返回新回复）。
 *  网络/解析失败显式抛错（调用方决定报错方式，绝不静默伪造）。 */
export async function sendChat(baseUrl: string, text: string): Promise<ChatSendState> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const raw: unknown = await res.json().catch(() => null);
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: 对话响应非法');
  const o = raw as Record<string, unknown>;
  if (o.ok !== true) {
    return {
      ok: false,
      reason:
        o.reason === 'provider-missing' || o.reason === 'generate-error' || o.reason === 'config-error'
          ? o.reason
          : 'bad-request',
      message: typeof o.message === 'string' ? o.message : undefined,
    };
  }
  const reply = typeof o.reply === 'string' ? o.reply.trim() : '';
  if (!reply) throw new Error('dsh-pet: 对话回复非法');
  return { ok: true, reply, ts: Number(o.ts) || 0 };
}

/** 弹窗样式 —— 两端注入同一份（与菜单 MENU_CSS 同理；视觉对齐浏览器/桌面）。
 *  最简形态：一条自适应输入框（无标题/无按钮）——初始小宽度（160px），
 *  随输入自动增宽（封顶 340px），到上限后自动折行增高；回车发送，Esc 或点外关闭。
 *  宽度由 JS 按文本测量覆盖根元素宽度。 */
export const CHAT_CSS = [
  '.dsh-pet-chat{position:fixed;z-index:2147483001;width:160px;max-width:80vw;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:10px;',
  'box-shadow:0 10px 32px rgba(0,0,0,.22);color:#2b2b2b;font-size:14px;line-height:1.5;',
  // 字体与桌宠气泡同款（上首软糖体，两端均已注入 @font-face），风格一致不显正式
  "font-family:'ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif;",
  'user-select:none}',
  '.dsh-pet-chat *{box-sizing:border-box}',
  '.dsh-pet-chat-input{display:block;width:100%;border:none;outline:none;background:transparent;',
  'padding:8px 11px 9px;font-size:14px;line-height:1.45;color:#2b2b2b;font-family:inherit;',
  'resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsh-pet-chat-input::placeholder{color:rgba(43,43,43,.45)}',
  '.dsh-pet-chat-input:disabled{opacity:.55}',
  '.dsh-pet-chat-err{color:#d94f3d;font-size:12px;padding:0 12px 8px;white-space:pre-wrap;overflow-wrap:anywhere}',
].join('');

/** 输入框宽度自适应参数：初始小宽 → 随文本增宽 → 封顶后折行增高 */
const CHAT_MIN_W = 160;
const CHAT_MAX_W = 340;
const CHAT_H_PAD = 22; // 输入框水平 padding（11×2），宽度测量补偿

let chatCssInjected = false;
function injectChatCss(): void {
  if (chatCssInjected || typeof document === 'undefined') return;
  chatCssInjected = true;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/chat';
  tag.textContent = CHAT_CSS;
  document.head.appendChild(tag);
}

/** mountChatDialog 返回值 */
export interface ChatDialogMount {
  /** 根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}

/** 挂载一个对话输入弹窗（两端共用；位置为视口坐标，超出 clamp 矩形自动夹回）。
 *  最简形态：只有一条输入框（无标题/无按钮），回车即发送 → 弹窗关闭 →
 *  onReply(reply) 交给调用方走碎碎念同款显示（说话动画 + 气泡）；
 *  Esc / 点弹窗外关闭；生成失败则留在弹窗内显式提示，不伪造回复。
 *
 *  clamp（可选，#41）：弹窗允许占用的矩形（视口局部坐标，默认整个视口）。
 *  桌面模式传「窗口 ∩ 工作区」——宠物贴屏幕底/右时窗口外扩余量伸出屏幕，
 *  约束到该矩形内即可完整显示，**窗口/宠物零移动零闪帧**。 */
export function mountChatDialog(opts: {
  petId: string;
  /** 端点基址：浏览器默认相对 /dsh-pet-7340/chat；桌面传绝对 URL（file:// 页面需绝对） */
  baseUrl?: string;
  x: number;
  y: number;
  /** 发送成功后的回复（弹窗此时已关闭）；调用方负责播动画 + 气泡展示 */
  onReply?: (reply: string) => void;
  onClose?: () => void;
  /** 弹窗允许占用的矩形（视口局部坐标）；缺省 = 整个视口 */
  clamp?: { x: number; y: number; w: number; h: number };
}): ChatDialogMount {
  injectChatCss();
  const { petId, x, y, onReply, onClose, clamp } = opts;
  const baseUrl = opts.baseUrl ?? '/dsh-pet-7340/chat';
  const withPet = baseUrl + '?pet=' + encodeURIComponent(petId);
  const c =
    clamp && Number.isFinite(clamp.x + clamp.y + clamp.w + clamp.h)
      ? clamp
      : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };

  const root = document.createElement('div');
  root.className = 'dsh-pet-chat';

  const input = document.createElement('textarea');
  input.className = 'dsh-pet-chat-input';
  input.placeholder = '说点什么…';
  input.maxLength = 2000;
  input.rows = 1;

  // 宽度/高度自适应：宽度按文本测量（≤CHAT_MAX_W），封顶后高度随折行增长
  let measureCtx: CanvasRenderingContext2D | null = null;
  const measureText = (text: string): number => {
    const ctx =
      measureCtx ?? (measureCtx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D);
    ctx.font = getComputedStyle(input).font; // 每次取当前计算样式（挂载前后都准）
    return ctx.measureText(text).width;
  };
  const resizeInput = (): void => {
    const textW = measureText(input.value || ' ');
    const w = Math.max(CHAT_MIN_W, Math.min(Math.ceil(textW + CHAT_H_PAD), CHAT_MAX_W));
    root.style.width = w + 'px'; // 根宽度跟随（含 err 行）→ 夹回仍按实际宽
    input.style.height = 'auto';
    input.style.height = Math.max(input.scrollHeight, 22) + 'px';
  };
  input.addEventListener('input', resizeInput);
  resizeInput(); // 以占位符为初始宽度

  const err = document.createElement('div');
  err.className = 'dsh-pet-chat-err';
  err.style.display = 'none';

  root.appendChild(input);
  root.appendChild(err);
  document.body.appendChild(root);

  // 位置：以 (x,y) 落点，超出 clamp 矩形夹回
  resizeInput(); // append 后再量一次（此时样式已生效）
  const rr = root.getBoundingClientRect();
  root.style.left = Math.max(c.x + 4, Math.min(x, c.x + c.w - rr.width - 4)) + 'px';
  root.style.top = Math.max(c.y + 4, Math.min(y, c.y + c.h - rr.height - 4)) + 'px';

  let closed = false;
  let sending = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    root.remove();
    if (onClose) onClose();
  };
  const onDocPointerDown = (e: MouseEvent): void => {
    if (closed) return;
    if (root.contains(e.target as Node)) return;
    close();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (closed) return;
    if (e.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);

  const doSend = (): void => {
    if (closed || sending) return;
    const text = input.value.trim();
    if (!text) return;
    sending = true;
    input.disabled = true;
    sendChat(withPet, text)
      .then((state) => {
        if (state.ok) {
          close();
          if (onReply) onReply(state.reply);
        } else {
          err.textContent = '对话失败：' + (state.message ?? state.reason);
          err.style.display = 'block';
        }
      })
      .catch((e) => {
        err.textContent = '对话异常：' + String(e && e.message ? e.message : e);
        err.style.display = 'block';
      })
      .finally(() => {
        sending = false;
        input.disabled = false;
        if (!closed) input.focus();
      });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSend();
    }
  });

  input.focus();
  return { el: root, close };
}
