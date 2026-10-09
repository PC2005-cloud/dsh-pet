import { HIT_BOX } from './constants';

export interface SpendPayload {
  enabled?: boolean;
  scope: string;
  spend: { count: number; amount: number; currency: 'CNY' | 'USD'; at: number } | null;
}

interface SpendRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 坐标均为当前窗口 CSS 像素；桌面传入“窗口与所在屏幕工作区的交集”。 */
export function spendBubblePlacement(body: SpendRect, bounds: SpendRect, width: number, height: number, gap: number) {
  const leftSpace = Math.max(0, body.x - bounds.x - gap);
  const rightSpace = Math.max(0, bounds.x + bounds.w - body.x - body.w - gap);
  const side = rightSpace >= width || rightSpace >= leftSpace ? 'right' : 'left';
  const w = Math.min(width, side === 'right' ? rightSpace : leftSpace);
  return {
    side,
    w,
    x: side === 'right' ? body.x + body.w + gap : body.x - gap - w,
    y: Math.max(bounds.y, Math.min(body.y + (body.h - height) / 2, bounds.y + bounds.h - height)),
  };
}

/** 浏览器与桌面共用：费用气泡独立挂载，不改变其他气泡和动画状态。 */
export function startSpendBubble(
  root: HTMLElement,
  url: string,
  size: number,
  bubbleClass = 'dsh-pet-bubble',
  visibleBounds: () => SpendRect | null = () => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }),
  subscribe?: (receive: (data: SpendPayload) => void) => () => void,
): () => void {
  const bubble = document.createElement('div');
  // 保留余额气泡的配色、字体和阴影，独立定位在身体两侧，给头顶任务气泡留出空间。
  bubble.className = bubbleClass + ' dsh-pet-spend is-on';
  bubble.setAttribute('role', 'status');
  bubble.style.cssText =
    'z-index:20;display:none;text-align:center;bottom:auto;transform:none;box-sizing:border-box;min-width:0;white-space:normal;overflow-wrap:anywhere';
  const title = document.createElement('div');
  title.textContent = '本轮消耗（估算）';
  title.style.cssText = `font-size:${size * 0.035}px;color:rgba(43,43,43,.6);margin-bottom:${size * 0.009}px`;
  const amount = document.createElement('div');
  amount.style.cssText = 'color:#1f1f1f;font-weight:650;font-variant-numeric:tabular-nums';
  bubble.append(title, amount);
  root.appendChild(bubble);
  const style = document.createElement('style');
  style.textContent =
    '.dsh-pet-spend.dsh-pet-spend::after{left:auto;right:auto;top:50%;bottom:auto;transform:translateY(-50%);border:8px solid transparent}' +
    '.dsh-pet-spend[data-side="right"]::after{right:100%;border-right-color:rgba(255,255,255,.92)}' +
    '.dsh-pet-spend[data-side="left"]::after{left:100%;border-left-color:rgba(255,255,255,.92)}';
  root.appendChild(style);
  let alive = true;
  let baseline: number | undefined;
  let scope: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let positionTimer: ReturnType<typeof setTimeout> | undefined;
  const position = () => {
    const viewport = visibleBounds();
    if (!viewport) {
      bubble.style.visibility = 'hidden';
      return;
    }
    const rect = root.getBoundingClientRect();
    const hit = root.querySelector('.dsh-pet-hit,.pet-hit')?.getBoundingClientRect();
    const body = hit
      ? { x: hit.left, y: hit.top, w: hit.width, h: hit.height }
      : {
          x: rect.left + (size * HIT_BOX.x0) / 640,
          y: rect.top + (size * HIT_BOX.y0) / 640,
          w: (size * (HIT_BOX.x1 - HIT_BOX.x0)) / 640,
          h: (size * (HIT_BOX.y1 - HIT_BOX.y0)) / 640,
        };
    const bounds = {
      x: viewport.x + 8,
      y: viewport.y + 8,
      w: Math.max(0, viewport.w - 16),
      h: Math.max(0, viewport.h - 16),
    };
    const gap = Math.max(10, size * 0.025);
    bubble.style.width = size * 0.4 + 'px';
    bubble.style.maxWidth = size * 0.4 + 'px';
    let placement = spendBubblePlacement(body, bounds, bubble.getBoundingClientRect().width, 0, gap);
    bubble.style.width = placement.w + 'px';
    placement = spendBubblePlacement(body, bounds, placement.w, bubble.getBoundingClientRect().height, gap);
    bubble.style.left = placement.x - rect.left + 'px';
    bubble.style.top = placement.y - rect.top + 'px';
    bubble.setAttribute('data-side', placement.side);
    // 极窄可视区域宁可暂时隐藏，也不挤到宠物本体或头顶气泡上。
    bubble.style.visibility = placement.w < 48 ? 'hidden' : 'visible';
  };
  const follow = () => {
    position();
    positionTimer = setTimeout(follow, 50);
  };
  let controller = new AbortController();
  const hide = () => {
    bubble.style.display = 'none';
    clearTimeout(hideTimer);
    clearTimeout(positionTimer);
  };
  root.addEventListener('pointermove', hide);
  root.addEventListener('pointerover', hide);
  const receive = (data: SpendPayload) => {
    if (!alive || !data) return;
    if (data.enabled === false) {
      hide();
      baseline = undefined;
      scope = undefined;
      return;
    }
    const count = Number(data.spend?.count ?? 0);
    if (scope !== data.scope) {
      hide();
      baseline = baseline === undefined ? undefined : 0;
      scope = data.scope;
    }
    const validSpend =
      data.spend &&
      (data.spend.currency === 'CNY' || data.spend.currency === 'USD') &&
      Number.isFinite(data.spend.amount) &&
      data.spend.amount >= 0;
    // 币种切换只更新还在展示的气泡，不重放已消失的提示或延长五秒计时。
    if (bubble.style.display === 'block') {
      if (validSpend && data.spend) amount.textContent = data.spend.currency + ' ' + data.spend.amount.toFixed(4);
      else hide();
    }
    if (
      baseline !== undefined &&
      count !== baseline &&
      validSpend &&
      data.spend &&
      Date.now() - data.spend.at < 15000
    ) {
      hide();
      amount.textContent = data.spend.currency + ' ' + data.spend.amount.toFixed(4);
      bubble.style.display = 'block';
      follow();
      hideTimer = setTimeout(hide, 5000);
    }
    baseline = count;
  };
  const poll = async () => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error('turn-spend HTTP ' + res.status);
      const data = await res.json();
      receive(data);
    } catch {
      /* 下次轮询重试，绝不展示伪造金额。 */
    } finally {
      clearTimeout(timeout);
      if (alive) timer = setTimeout(() => void poll(), 1000);
    }
  };
  const unsubscribe = subscribe?.(receive);
  if (!subscribe) void poll();
  return () => {
    alive = false;
    unsubscribe?.();
    controller.abort();
    clearTimeout(timer);
    hide();
    bubble.remove();
    style.remove();
    root.removeEventListener('pointermove', hide);
    root.removeEventListener('pointerover', hide);
  };
}
