/**
 * 「吃白饭」的米饭层：掉落、落体循环、飞向嘴边、空碗与分数气泡。
 *
 * 自持 DOM 与 rAF（落体只在有东西还在天上时才跑），不碰接口也不判演出相位——
 * 相位归 show，这里只回答「场上有什么、离最近的是哪份」。
 * @module dsh-pet/src/client/baifan/scene
 */
import { CFG, PIC } from './constants.ts';
import { groundLine, type Geometry } from './geometry.ts';
/** 场上的一份饭。 */
export interface RiceItem {
  /** 元素。 */
  el: HTMLImageElement;
  /** 视口中心 x。 */
  x: number;
  /** 底边 y。 */
  y: number;
  /** 渲染宽。 */
  w: number;
  /** 渲染高。 */
  h: number;
  /** 碗饭还是饭团。 */
  type: 'bowl' | 'ball';
  /** 下落速度（像素/秒）。 */
  vy: number;
  /** 当前旋转角（度）。 */
  rot: number;
  /** 旋转速度（度/秒）。 */
  spin: number;
  /** 状态：还在落 / 已落地。 */
  state: 'falling' | 'ground';
}

/** 建一个元素。 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag);
}

/**
 * 造米饭层。
 *
 * @param layer - 覆盖层根节点（本层所有元素都挂它下面）。
 * @param toastEl - 提示条节点；`toast()` 直接写它。
 * @returns 生成、落体、飞行、计分与清理的方法。
 */
export function createScene(layer: HTMLDivElement, toastEl: HTMLDivElement) {
  /** 场上的饭。 */
  let items: RiceItem[] = [];
  /** 落体循环的 rAF 句柄；0 = 没在跑。 */
  let frame = 0;
  /** 上一帧时间戳（秒）。 */
  let lastMs = 0;
  /** 提示条的淡出定时器。 */
  let toastTimer = 0;

  /**
   * 底部居中提示条，1.8 秒后自己淡掉。
   *
   * @param text - 文案。
   */
  function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  /** 按当前坐标写样式。 */
  function layout(item: RiceItem): void {
    item.el.style.left = item.x - item.w / 2 + 'px';
    item.el.style.top = item.y - item.h + 'px';
    item.el.style.transform = 'rotate(' + item.rot + 'deg)';
  }

  /**
   * 从天上掉一份饭。位置在视口里随机（左右各留 70px），尺寸按精灵缩放。
   *
   * @param scale - 精灵相对基准宽的缩放。
   * @returns 新的一份；场上已满时返回 null。
   */
  function spawn(scale: number): RiceItem | null {
    if (items.length >= CFG.maxRice) return null;
    const isBowl = Math.random() < CFG.bowlRatio;
    const w = (isBowl ? 124 : 110) * scale;
    const img = el('img');
    img.className = 'bf-rice';
    img.src = isBowl ? PIC.bowlFull : PIC.riceBall;
    img.alt = '';
    img.draggable = false;
    img.style.width = w + 'px';
    img.style.height = w + 'px';
    const item: RiceItem = {
      el: img,
      x: 70 + Math.random() * Math.max(10, window.innerWidth - 140),
      y: -w - 20,
      w,
      h: w,
      type: isBowl ? 'bowl' : 'ball',
      vy: 170 + Math.random() * 60,
      rot: 0,
      spin: isBowl ? 0 : (Math.random() < 0.5 ? -1 : 1) * 90,
      state: 'falling',
    };
    layer.appendChild(img);
    items.push(item);
    layout(item);
    return item;
  }

  /**
   * 落体循环：只在还有东西在天上时才跑 rAF，落地后自然停下来。
   *
   * @param ts - rAF 时间戳（毫秒）。
   */
  function fallTick(ts: number): void {
    frame = 0;
    if (!lastMs) lastMs = ts;
    const dt = Math.min((ts - lastMs) / 1000, 0.05);
    lastMs = ts;

    let falling = false;
    const line = groundLine();
    for (const item of items) {
      if (item.state !== 'falling') {
        if (item.rot !== 0) {
          item.rot = 0;
          layout(item);
        }
        continue;
      }
      falling = true;
      item.y += item.vy * dt;
      item.rot += item.spin * dt;
      if (item.y >= line) {
        item.y = line;
        item.state = 'ground';
        item.el.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(.92)' }, { transform: 'scaleY(1)' }], {
          duration: 160,
          easing: 'ease-out',
        });
      }
      layout(item);
    }
    if (falling && frame === 0) frame = window.requestAnimationFrame(fallTick);
  }

  /** 按需拉起落体循环。 */
  function kick(): void {
    if (frame === 0) frame = window.requestAnimationFrame(fallTick);
  }

  /**
   * 场上离得最近的、已经落地的饭。
   *
   * 「最近」带一点朝向偏好：身后那份要打折才算数——换朝向就要重开一段跑步动画（新视频要解码），
   * 那一下必然有空档，能不换就不换。
   *
   * @param petPx - 宠物中心 x。
   * @param facing - 当前朝向。
   * @returns 挑中的那份；场上没有已落地的饭时返回 null。
   */
  function nearest(petPx: number, facing: 'left' | 'right'): RiceItem | null {
    let best: RiceItem | null = null;
    let bestScore = Infinity;
    for (const item of items) {
      if (item.state !== 'ground') continue;
      const distance = Math.abs(item.x - petPx);
      const ahead = facing === 'right' ? item.x > petPx : item.x < petPx;
      const score = ahead ? distance : distance * CFG.backTurnPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  /** 把一份饭从场上摘掉（元素交给调用方决定什么时候删）。 */
  function detach(item: RiceItem): void {
    const index = items.indexOf(item);
    if (index >= 0) items.splice(index, 1);
  }

  /**
   * 吃掉一份：飞到嘴边，随咀嚼缩小，到点自己删元素。
   *
   * @param item - 被吃的那份（调用方应已 detach）。
   * @param mouthX - 嘴部视口 x。
   * @param mouthY - 嘴部视口 y。
   * @param durationMs - 飞行时长（用真实片长，才与咀嚼同步）。
   */
  function flyToMouth(item: RiceItem, mouthX: number, mouthY: number, durationMs: number): void {
    const dx = mouthX - item.x;
    const dy = mouthY - (item.y - item.h / 2);
    item.el.style.zIndex = '5';
    // 飞行末段把食物缩到 0.72：整份原尺寸怼在脸上会把眼睛盖住。
    // transform-origin 是 50% 100%（底边），所以缩放是「从下往上收」，不会越缩越高。
    item.el.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1, offset: 0 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.72)', opacity: 1, offset: 0.16 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.68)', opacity: 1, offset: 0.55 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.12)', opacity: 0, offset: 1 },
      ],
      { duration: durationMs, easing: 'ease-in-out', fill: 'forwards' },
    );
    window.setTimeout(() => item.el.remove(), durationMs + 80);
  }

  /**
   * 空碗：从嘴边掉到地上，弹两下，然后淡出。
   *
   * @param x - 嘴部视口 x。
   * @param fromY - 嘴部视口 y（碗底先放这儿）。
   * @param scale - 精灵缩放。
   */
  function dropEmptyBowl(x: number, fromY: number, scale: number): void {
    const w = 124 * scale;
    const img = el('img');
    img.className = 'bf-rice';
    img.src = PIC.bowlEmpty;
    img.alt = '';
    img.draggable = false;
    img.style.width = w + 'px';
    img.style.height = w + 'px';
    img.style.left = x - w / 2 + 'px';
    img.style.top = fromY - w + 'px';
    layer.appendChild(img);

    const drop = Math.max(0, groundLine() - fromY);
    img.animate(
      [
        { transform: 'translateY(0)' },
        { transform: 'translateY(' + drop + 'px)', offset: 0.48, easing: 'ease-in' },
        { transform: 'translateY(' + (drop - 42 * scale) + 'px)', offset: 0.62, easing: 'ease-out' },
        { transform: 'translateY(' + drop + 'px)', offset: 0.74, easing: 'ease-in' },
        { transform: 'translateY(' + (drop - 14 * scale) + 'px)', offset: 0.82, easing: 'ease-out' },
        { transform: 'translateY(' + drop + 'px)', offset: 0.9 },
        { transform: 'translateY(' + drop + 'px)', offset: 1 },
      ],
      { duration: 820, easing: 'linear' },
    );
    window.setTimeout(() => {
      img.style.transition = 'opacity .9s ease';
      img.style.opacity = '0';
      window.setTimeout(() => img.remove(), 950);
    }, 900);
  }

  /**
   * 头顶分数气泡：图标随刚吃下的那份饭变（碗饭 / 饭团）。
   *
   * @param value - 累计份数。
   * @param type - 刚吃下的种类。
   * @param geom - 当前几何量（决定气泡位置）。
   */
  function popScore(value: number, type: 'bowl' | 'ball', geom: Geometry): void {
    const isBowl = type === 'bowl';
    const node = el('div');
    node.className = 'bf-score';
    node.innerHTML =
      '<img class="' +
      (isBowl ? 'bowl' : 'ball') +
      '" src="' +
      (isBowl ? PIC.bowlFull : PIC.riceBall) +
      '" alt="">' +
      '<span class="num">' +
      value +
      '</span>' +
      '<span class="plus">+1</span>';
    node.style.left = geom.cx + 'px';
    node.style.top = geom.top + geom.h * 0.09 + 'px';
    layer.appendChild(node);

    node.animate(
      [
        { opacity: 0, transform: 'translate(-50%,-100%) scale(.55)' },
        { opacity: 1, transform: 'translate(-50%,-100%) scale(1.16)', offset: 0.26 },
        { opacity: 1, transform: 'translate(-50%,-100%) scale(1)', offset: 0.5 },
        { opacity: 1, transform: 'translate(-50%,-100%) scale(1)', offset: 0.78 },
        { opacity: 0, transform: 'translate(-50%,-132%) scale(1)', offset: 1 },
      ],
      { duration: 1300, easing: 'ease-out', fill: 'forwards' },
    );
    const plus = node.querySelector('.plus');
    if (plus !== null) {
      plus.animate(
        [
          { opacity: 0, transform: 'translateY(6px) scale(.8)' },
          { opacity: 1, transform: 'translateY(-4px) scale(1)', offset: 0.25 },
          { opacity: 1, transform: 'translateY(-10px) scale(1)', offset: 0.7 },
          { opacity: 0, transform: 'translateY(-18px) scale(1)' },
        ],
        { duration: 1000, easing: 'ease-out', fill: 'forwards' },
      );
    }
    window.setTimeout(() => node.remove(), 1350);
  }

  /** 收场时把场上的饭淡出清掉，并停掉落体循环。 */
  function clear(): void {
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    lastMs = 0;
    for (const item of items) {
      const node = item.el;
      node.style.transition = 'opacity .5s ease';
      node.style.opacity = '0';
      window.setTimeout(() => node.remove(), 520);
    }
    items = [];
  }

  return {
    clear,
    detach,
    dropEmptyBowl,
    flyToMouth,
    kick,
    nearest,
    popScore,
    /** 场上还有几份（调用方据此决定要不要继续掉）。 */
    count: (): number => items.length,
    /** 精灵缩放到米饭尺寸用：按基准宽换算（大宠物配大盘饭，不夹到 1）。 */
    scaleOf: (spriteW: number): number => (spriteW > 0 ? spriteW / CFG.refWidth : 1),
    spawn,
    toast,
  };
}

/** 米饭层的公开面。 */
export type Scene = ReturnType<typeof createScene>;
