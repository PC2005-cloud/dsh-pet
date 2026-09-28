/** 浏览器与桌面共用：费用气泡独立挂载，不改变其他气泡和动画状态。 */
export function startSpendBubble(
  root: HTMLElement,
  url: string,
  size: number,
  bubbleClass = 'dsh-pet-bubble',
): () => void {
  const bubble = document.createElement('div');
  // 直接复用各端余额气泡：同一头顶锚点、白色背景、小尾巴、阴影和上首软糖体。
  // 不再使用 top:48% 的本体内部定位；bottom 锚定后气泡向上生长。
  bubble.className = bubbleClass + ' dsh-pet-spend is-on';
  bubble.setAttribute('role', 'status');
  bubble.style.cssText = 'z-index:20;display:none;text-align:center';
  const title = document.createElement('div');
  title.textContent = '本轮消耗（估算）';
  title.style.cssText = `font-size:${size * 0.035}px;color:rgba(43,43,43,.6);margin-bottom:${size * 0.009}px`;
  const amount = document.createElement('div');
  amount.style.cssText = 'color:#1f1f1f;font-weight:650;font-variant-numeric:tabular-nums';
  bubble.append(title, amount);
  root.appendChild(bubble);
  let alive = true;
  let baseline: number | undefined;
  let scope: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let controller = new AbortController();
  const hide = () => {
    bubble.style.display = 'none';
    clearTimeout(hideTimer);
  };
  root.addEventListener('pointermove', hide);
  root.addEventListener('pointerover', hide);
  const poll = async () => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error('turn-spend HTTP ' + res.status);
      const data = await res.json();
      if (!alive) return;
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
        if (validSpend) amount.textContent = data.spend.currency + ' ' + data.spend.amount.toFixed(4);
        else hide();
      }
      if (baseline !== undefined && count !== baseline && validSpend && Date.now() - data.spend.at < 15000) {
        hide();
        amount.textContent = data.spend.currency + ' ' + data.spend.amount.toFixed(4);
        bubble.style.display = 'block';
        hideTimer = setTimeout(hide, 5000);
      }
      baseline = count;
    } catch {
      /* 下次轮询重试，绝不展示伪造金额。 */
    } finally {
      clearTimeout(timeout);
      if (alive) timer = setTimeout(() => void poll(), 1000);
    }
  };
  void poll();
  return () => {
    alive = false;
    controller.abort();
    clearTimeout(timer);
    hide();
    bubble.remove();
    root.removeEventListener('pointermove', hide);
    root.removeEventListener('pointerover', hide);
  };
}
