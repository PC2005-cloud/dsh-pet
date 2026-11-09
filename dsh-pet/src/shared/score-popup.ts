/**
 * 点击积分弹窗与粒子爆发：两端共用同一份渲染。
 * 纯逻辑（阈值与分数映射）在 score.ts，本文件只做展示——粒子在点击处爆开，
 * 弹窗显示 +N 分与速度/大小明细，点外或 Esc 立即关闭。
 * @module dsh-pet/src/shared/score-popup
 */
import { clickScore, SCORE_MIN_SPEED } from './score.ts';
import { uiT } from './ui/i18n.ts';

/** 弹窗展示时长（ms）：积分反馈比气泡（10s）短，够读即可。 */
export const SCORE_POPUP_DURATION_MS = 2200;

/** 弹窗样式 —— 两端注入同一份。 */
export const SCORE_POPUP_CSS = [
  '.dsh-pet-score{position:fixed;z-index:2147483002;min-width:120px;text-align:center;',
  'background:rgba(255,255,255,.97);border:1px solid rgba(255,179,0,.35);border-radius:12px;',
  'box-shadow:0 10px 32px rgba(0,0,0,.22);padding:8px 16px 9px;user-select:none;pointer-events:auto;',
  // 字体族走全局配置变量（两端注入在 documentElement）：弹窗挂在 body 下，继承不到宠物根容器。
  // 字号固定 px——配置的 font.size 只作用于气泡与悬浮提示。
  "font-family:var(--dsh-pet-font-family,'DshPetRu','ShangshouSoftCandy','Yuanti SC','YouYuan','幼圆','Comic Sans MS','PingFang SC','Microsoft YaHei',sans-serif);}",
  '.dsh-pet-score.is-in{animation:dshPetScorePop .28s ease}',
  '.dsh-pet-score-val{font-size:22px;line-height:1.25;font-weight:700;color:#ff8f00;font-variant-numeric:tabular-nums}',
  '.dsh-pet-score-sub{font-size:11px;line-height:1.4;color:rgba(43,43,43,.6);margin-top:2px;white-space:nowrap}',
  // 粒子层：整屏固定、不挡交互；粒子为绝对定位小圆点，位移与透明度由 rAF 直接写
  '.dsh-pet-score-burst{position:fixed;inset:0;pointer-events:none;z-index:2147483002}',
  '.dsh-pet-score-particle{position:absolute;border-radius:50%;pointer-events:none}',
  '@keyframes dshPetScorePop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}',
].join('');

/** 样式只注入一次（同 CHAT_CSS 的注入模式）。 */
let scoreCssInjected = false;
function injectScoreCss(): void {
  if (scoreCssInjected || typeof document === 'undefined') return;
  scoreCssInjected = true;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = 'dsh-pet/score';
  tag.textContent = SCORE_POPUP_CSS;
  document.head.appendChild(tag);
}

/** 粒子数量。 */
const BURST_COUNT = 20;
/** 初速范围（px/s）。 */
const BURST_SPEED_MIN = 120;
const BURST_SPEED_MAX = 460;
/** 重力（px/s²）：粒子向上喷出后回落。 */
const BURST_GRAVITY = 700;
/** 单粒子寿命范围（ms）。 */
const BURST_LIFE_MIN = 500;
const BURST_LIFE_MAX = 900;
/** 粒子半径范围（px）。 */
const BURST_RADIUS_MIN = 3;
const BURST_RADIUS_MAX = 7;
/** 暖色盘（积分与庆祝感）。 */
const BURST_COLORS = ['#ffb300', '#ff8f00', '#ff7043', '#f4511e', '#ffc400', '#ffd54f', '#ef5350'];

/** 在 (x, y) 爆开一圈暖色粒子（视口坐标）：随机方向初速 + 重力回落 + 淡出，寿命结束整体清理。
 *  prefers-reduced-motion 时跳过（与 Q 弹同语义）。 */
export function spawnScoreBurst(x: number, y: number): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  injectScoreCss();
  const root = document.createElement('div');
  root.className = 'dsh-pet-score-burst';
  document.body.appendChild(root);
  interface P {
    el: HTMLDivElement;
    vx: number;
    vy: number;
    t0: number;
    life: number;
  }
  const parts: P[] = [];
  for (let i = 0; i < BURST_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = BURST_SPEED_MIN + Math.random() * (BURST_SPEED_MAX - BURST_SPEED_MIN);
    const r = BURST_RADIUS_MIN + Math.random() * (BURST_RADIUS_MAX - BURST_RADIUS_MIN);
    const el = document.createElement('div');
    el.className = 'dsh-pet-score-particle';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = r * 2 + 'px';
    el.style.height = r * 2 + 'px';
    el.style.background = BURST_COLORS[Math.floor(Math.random() * BURST_COLORS.length)];
    root.appendChild(el);
    parts.push({
      el,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 80,
      t0: performance.now(),
      life: BURST_LIFE_MIN + Math.random() * (BURST_LIFE_MAX - BURST_LIFE_MIN),
    });
  }
  const step = (): void => {
    const now = performance.now();
    let alive = false;
    for (const p of parts) {
      const tSec = (now - p.t0) / 1000;
      const lifeRatio = (now - p.t0) / p.life;
      if (lifeRatio >= 1) continue;
      alive = true;
      // 分析式轨迹：x = vx·t，y = vy·t + ½g·t²（不用逐帧累积，避免丢帧漂移）
      p.el.style.transform =
        'translate(' + p.vx * tSec + 'px,' + (p.vy * tSec + 0.5 * BURST_GRAVITY * tSec * tSec) + 'px)';
      p.el.style.opacity = String(Math.max(0, 1 - lifeRatio));
    }
    if (alive) requestAnimationFrame(step);
    else root.remove();
  };
  requestAnimationFrame(step);
}

/** 积分弹窗挂载句柄（与 mountChatDialog 同契约）。 */
export interface ScorePopupMount {
  /** 根元素（document.body 下） */
  el: HTMLElement;
  /** 关闭并清理（幂等） */
  close: () => void;
}

/** 挂载点击积分弹窗：显示 +N 分与速度/大小明细，SCORE_POPUP_DURATION_MS 后自动消失，点外或 Esc 关闭。
 *  位置为视口坐标，超出视口自动夹回；分数由调用方用 clickScore 算好传入。 */
export function mountScorePopup(opts: {
  x: number;
  y: number;
  score: number;
  speed: number;
  size: number;
  /** 关闭后的通知（调用方复位自身状态） */
  onClose?: () => void;
}): ScorePopupMount {
  injectScoreCss();
  // 弹窗显示在点击点上方（避开手指/光标），超出视口夹回
  const x = opts.x;
  const y = opts.y;
  const root = document.createElement('div');
  root.className = 'dsh-pet-score';

  const val = document.createElement('div');
  val.className = 'dsh-pet-score-val';
  val.textContent = '+' + opts.score;
  const sub = document.createElement('div');
  sub.className = 'dsh-pet-score-sub';
  sub.textContent = uiT('score.detail', { speed: Math.round(opts.speed), size: Math.round(opts.size) });
  root.appendChild(val);
  root.appendChild(sub);
  document.body.appendChild(root);

  // 定位（先量后定位；同 mountChatDialog）
  const rr = root.getBoundingClientRect();
  root.style.left = Math.max(4, Math.min(x - rr.width / 2, window.innerWidth - rr.width - 4)) + 'px';
  root.style.top = Math.max(4, y - rr.height - 14) + 'px';
  // 强制重排后再加动画类，保证入场动画可见
  void root.offsetWidth;
  root.classList.add('is-in');

  let closed = false;
  let timer: number | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    document.removeEventListener('mousedown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    root.remove();
    if (opts.onClose) opts.onClose();
  };
  // 挂载宽限期：弹窗由 pointerdown 触发（按下即弹），同一事件之后浏览器还会派发兼容的 mousedown；
  // 没有宽限期，刚挂上的弹窗会被自己的「点外关闭」当场关掉，所以只吞掉挂载后的第一个 mousedown。
  const mountedAt = performance.now();
  let graceConsumed = false;
  const onDocPointerDown = (e: MouseEvent): void => {
    if (closed) return;
    if (!graceConsumed) {
      graceConsumed = true;
      if (e.timeStamp - mountedAt < 300) return; // 同一次按下的兼容 mousedown:忽略
    }
    if (root.contains(e.target as Node)) return;
    close();
  };
  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (closed) return;
    if (e.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
  timer = window.setTimeout(close, SCORE_POPUP_DURATION_MS);
  return { el: root, close };
}

// 转出分数常量，调用方无需另 import score.ts
export { clickScore, SCORE_MIN_SPEED };
