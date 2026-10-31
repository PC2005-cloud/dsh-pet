/**
 * 指针拖拽：按下态、拖拽阈值、触屏长按菜单与点击互动。
 * 不负责飞行与走位；弹簧跟随在 ./drag-follow，松手结算在 ./drag-release。
 * 依赖 PetCard 每帧给出的当帧能力 getter：尺寸、动画池、状态设置器与停/起运动。
 * 不变量：按下后所有位置写入都经包围盒读写；松手必须先停弹簧跟随再结算落点。
 * 鼠标松开兜底也在这里：指针捕获被浏览器提前丢掉时，window 上的 mouseup 走同一套收尾。
 * @module dsh-pet/src/client/pet/motion/drag
 */
import { trimTrail, type DragSample } from '../../../shared/physics.ts';
import { pick } from '../../../shared/pickers.ts';
import { clickScore, mountScorePopup, SCORE_MIN_SPEED, spawnScoreBurst } from '../../../shared/score-popup.ts';
import { DRAG_THRESHOLD, SLINGSHOT_DOUBLE_MS } from '../../../shared/constants.ts';
import { createDragFollow } from './drag-follow.ts';
import { createTouchPress } from './touch-press.ts';
import { decideRelease } from './drag-release.ts';
import type { BoxPoint } from './geometry.ts';
import type { PhysicsParams } from '../../../shared/types.ts';
import type * as ReactNS from 'react';

/** 指针按下的状态：阈值判定、弹弓与长按各占几个字段。 */
interface PressState {
  /** 已按下。 */
  active: boolean;
  /** 已超过拖动阈值。 */
  dragging: boolean;
  /** 按下点（px）。 */
  sx: number;
  /** 按下点（px）。 */
  sy: number;
  /** 按下点到宠物中心的偏移（px）。 */
  offX: number;
  /** 按下点到宠物中心的偏移（px）。 */
  offY: number;
  /** 本次拖拽按拉距算力度。 */
  sling: boolean;
  /** 按下时的宠物中心 X（px）。 */
  anchorX: number;
  /** 按下时的宠物中心 Y（px）。 */
  anchorY: number;
}

/** 一次松手的现场：React 事件在入口处折算成它，收尾逻辑只认这里。 */
interface ReleasePoint {
  /** 指针横坐标（px）。 */
  x: number;
  /** 指针纵坐标（px）。 */
  y: number;
  /** 命中区节点：摘拖拽类与判定提示落点都用它。 */
  hit: HTMLDivElement;
}

/** 拖拽驱动每次处理事件时取的当帧能力。 */
export interface DragCard {
  /** 本宠物 id，用于日志。 */
  petId: string;
  /** 宠物宽度（px）。 */
  size: number;
  /** 盒半宽（px）。 */
  halfW: number;
  /** 盒半高（px）。 */
  halfH: number;
  /** 舞台脚底垫高（px）。 */
  bottomPad: number;
  /** 该宠物的物理参数。 */
  physics: PhysicsParams;
  /** 拖拽动画池。 */
  dragAnims: string[];
  /** 点击动画池。 */
  clickAnims: string[];
  /** 待机动画池。 */
  idleAnims: string[];
  /** 当前动画名，抽待机时用来避开自己。 */
  currentAnim: string;
  /** 换源播一次。 */
  setOnce: (on: boolean) => void;
  /** 换成指定动画。 */
  playAnim: (anim: string) => void;
  /** 递增换源序号，强制 switchTo 走一遍。 */
  bumpSeq: () => void;
  /** 标记「等新首帧就位后压 Q 弹」。 */
  markSquash: () => void;
  /** 拖拽态：控制舞台位移与指针样式。 */
  setDragging: (on: boolean) => void;
  /** 恢复非终态工作循环；返回 false 表示没有可恢复的状态。 */
  resumeWork: () => boolean;
  /** 停走位与位置跟随。 */
  stopAutonomy: () => void;
  /** 停飞。 */
  stopFlight: () => void;
  /** 起飞。 */
  startFlight: (px: number, py: number, vx: number, vy: number) => void;
  /** 本卡是否被占用锁冻结。 */
  isFrozen: () => boolean;
  /** 本地解冻并释放宿主锁。 */
  releaseLock: () => void;
  /** 抓取瞬间的飞行速度；没在飞时为 null。 */
  grabVelocity: () => { vx: number; vy: number } | null;
  /** 点击音效。 */
  playClickSound: () => void;
  /** 悬浮提示是否点亮。 */
  tipOn: () => boolean;
  /** 把提示摆到光标旁。 */
  placeTip: (x: number, y: number) => void;
  /** 切换提示显隐。 */
  setTipOn: (on: boolean) => void;
  /** 舞台元素。 */
  stage: () => HTMLDivElement | null;
  /** 根元素。 */
  root: () => HTMLDivElement | null;
  /** 当前包围盒位置。 */
  box: () => BoxPoint | null;
  /** 写回包围盒位置。 */
  setBox: (box: BoxPoint) => void;
  /** 原地放下：提交夹取后的归一化中心。 */
  commitPlace: (box: BoxPoint) => void;
}

/** 拖拽驱动对外的读写面。 */
export interface Drag {
  /** 按下：处理积分、拖拽与弹弓，并开启指针捕获。 */
  onPointerDown(e: ReactNS.PointerEvent<HTMLDivElement>): void;
  /** 移动：更新悬浮提示、拖拽阈值与弹簧目标。 */
  onPointerMove(e: ReactNS.PointerEvent<HTMLDivElement>): void;
  /** 松开与取消：结算拖拽或抛掷，并复位悬浮提示。 */
  onPointerUp(e: ReactNS.PointerEvent<HTMLDivElement>): void;
  /** 点击：播放点击动画并触发 Q 弹。 */
  onClick(): void;
  /** 停弹簧跟随，不碰指针捕获状态。 */
  stopFollow(): void;
  /** 摘掉鼠标松开兜底监听；卸载时调用，之后这个驱动不可再用。 */
  dispose(): void;
  /** 指针是否按着（含未超过拖动阈值）。 */
  isActive(): boolean;
  /** 是否刚拖完：松手后的短窗口内为真，右键菜单要忽略这段时间。 */
  justDragged(): boolean;
}

/** 复位的按下状态：避免每个实例各写一份字面量。 */
const IDLE_PRESS: PressState = {
  active: false,
  dragging: false,
  sx: 0,
  sy: 0,
  offX: 0,
  offY: 0,
  sling: false,
  anchorX: 0,
  anchorY: 0,
};

/** 松手后这段时间内的指针事件视为同一次拖拽的尾巴（ms）。 */
const JUST_DRAGGED_MS = 100;

/** 日志行的时刻前缀。 */
const stamp = (): string => new Date().toTimeString().slice(0, 8);

/** 一行带时刻与宠物 id 的日志：客户端统一前缀，便于按宠物 grep。 */
const log = (petId: string, message: string): void => {
  console.log('[dsh-pet] ' + stamp() + ' pet=' + petId + ' ' + message);
};

/**
 * 抓取瞬间记一行速度，手速够快就打分。
 *
 * @param current - 当帧能力。
 * @param x - 指针横坐标（px），分数从这里弹出。
 * @param y - 指针纵坐标（px）。
 * @returns 是否打过分；调用方据此让随后的 click 不再播普通点击动画。
 */
function noteGrab(current: DragCard, x: number, y: number): boolean {
  const grab = current.grabVelocity();
  const speed = grab ? Math.hypot(grab.vx, grab.vy) : 0;
  log(
    current.petId,
    'grab vx=' +
      (grab ? Math.round(grab.vx) : 0) +
      ' vy=' +
      (grab ? Math.round(grab.vy) : 0) +
      ' |v|=' +
      Math.round(speed),
  );
  if (speed < SCORE_MIN_SPEED) return false;
  const score = clickScore(speed, current.size);
  log(current.petId, 'click-score speed=' + Math.round(speed) + ' size=' + current.size + ' -> +' + score);
  spawnScoreBurst(x, y);
  mountScorePopup({ x, y, score, speed, size: current.size });
  return true;
}

/**
 * 造拖拽驱动。
 *
 * @param card - 取当帧能力的 getter；每次事件处理时调用一次。
 * @returns 可反复调用的驱动；指针状态在实例内跨渲染保留。
 */
export function createDrag(card: () => DragCard): Drag {
  let press: PressState = { ...IDLE_PRESS };
  /** 「刚拖完」窗口的截止时刻（ms）；用时刻而不是定时器，读的时候再判，少一个待清理的句柄。 */
  let justDraggedUntil = 0;
  let pressScoreFired = false;
  let lastPressAt = 0;
  /** 指针轨迹采样，供初速估算。 */
  let trail: DragSample[] = [];
  const follow = createDragFollow({ card });
  // 指针捕获可能先于鼠标松开被浏览器丢掉，那时真正的 pointerup 落在别的元素上，拖拽会卡在按下态。
  // 只在鼠标按下期间挂一个 window 级 mouseup 兜底，按当前坐标走同一套收尾，不伪造 pointerup 事件。
  let mousePressHit: HTMLDivElement | null = null;
  /** 捕获丢失后的松手：坐标来自 mouseup，落点判定与正常松开完全一致。 */
  function onWindowMouseUp(e: MouseEvent): void {
    const hit = mousePressHit;
    // 右键或还有别的键按着时不算松手，只认左键完全松开的那一次。
    if (!hit || e.button !== 0 || e.buttons !== 0) return;
    endPress(card(), { x: e.clientX, y: e.clientY, hit });
  }
  /** 鼠标按下时登记命中区并挂兜底；node 里的测试没有 window，替身自己提供。 */
  const armMouseFallback = (hit: HTMLDivElement): void => {
    mousePressHit = hit;
    if (typeof window !== 'undefined') window.addEventListener('mouseup', onWindowMouseUp, true);
  };
  const clearMouseFallback = (): void => {
    mousePressHit = null;
    if (typeof window !== 'undefined') window.removeEventListener('mouseup', onWindowMouseUp, true);
  };
  /** 触屏长按：计时与容差在 motion/touch-press.ts，到点后把这次按压当右键。 */
  const touchPress = createTouchPress({
    onMenu: (target) => {
      // 结束本次按压：松手时既不抛掷也不播点击动画。
      press.active = false;
      pressScoreFired = true;
      if (target.el.hasPointerCapture(target.pointerId)) target.el.releasePointerCapture(target.pointerId);
      log(card().petId, '-> [TOUCH-MENU]');
      // 与鼠标右键同一入口：派发 contextmenu 交给右键处理。
      target.el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          button: 2,
          cancelable: true,
          clientX: target.x,
          clientY: target.y,
          view: window,
        }),
      );
    },
    stillHolding: () => press.active && !press.dragging,
  });

  /**
   * 记下这次按下的几何与弹弓判定。
   *
   * @param c - 当帧能力。
   * @param e - 按下事件。
   * @returns 新的按下状态。
   */
  const beginPress = (c: DragCard, e: ReactNS.PointerEvent<HTMLDivElement>): PressState => {
    e.currentTarget.classList.add('dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
    // 指针捕获期间 pointerleave 不触发，不主动收起提示就会一直跟着跑。
    c.setTipOn(false);
    const rootEl = c.root();
    let offX = 0;
    let offY = 0;
    if (rootEl) {
      const rr = rootEl.getBoundingClientRect();
      offX = e.clientX - (rr.left + rr.width / 2);
      offY = e.clientY - (rr.top + rr.height / 2);
      c.setBox({ x: rr.left, y: rr.top });
    }
    // 弹弓只比较两次按下的间隔，与本次拖了多久、何时松手无关。
    const pressNow = performance.now();
    const sling = pressNow - lastPressAt < SLINGSHOT_DOUBLE_MS;
    lastPressAt = sling ? 0 : pressNow; // 命中后清零，免得连点三下弹两次。
    const anchor = c.box();
    return {
      active: true,
      anchorX: anchor ? anchor.x + c.halfW : e.clientX,
      anchorY: anchor ? anchor.y + c.halfH : e.clientY,
      dragging: false,
      offX,
      offY,
      sling,
      sx: e.clientX,
      sy: e.clientY,
    };
  };

  const onPointerDown = (e: ReactNS.PointerEvent<HTMLDivElement>): void => {
    const c = card();
    // 只认左键：右键会与菜单判定打架，两端一致。
    if (e.button !== 0) return;
    // 用户点了或拖了这只宠物就是接管：立即本地解冻并 force 释放宿主锁。
    // 先本地解冻是为了不等一次往返；此刻确实有锁，乐观释放是安全的。
    if (c.isFrozen()) c.releaseLock();
    // 抓取瞬间的积分：手速够快就打分，随后这次 click 不再播普通点击动画。
    pressScoreFired = noteGrab(c, e.clientX, e.clientY);
    // 空中抓取：停掉抛掷、漫游与弹簧跟随，从当前落点开始拖拽。
    c.stopFlight();
    follow.stop();
    c.stopAutonomy();
    trail = [];
    press = beginPress(c, e);
    clearMouseFallback();
    // 笔与触屏的 pointerup 会正常送达命中区；只有鼠标需要这条兜底。
    if (e.pointerType === 'mouse') armMouseFallback(e.currentTarget);
    touchPress.arm({
      el: e.currentTarget,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const onPointerMove = (e: ReactNS.PointerEvent<HTMLDivElement>): void => {
    const c = card();
    // 提示跟随光标，必须在拖拽早退之前。
    if (c.tipOn()) c.placeTip(e.clientX, e.clientY);
    if (!press.active) return;
    const dx = e.clientX - press.sx;
    const dy = e.clientY - press.sy;
    // 长按窗口内手指移动超过容差即取消。
    touchPress.move(Math.hypot(dx, dy));
    if (!press.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      press.dragging = true;
      c.setDragging(true);
      c.setOnce(true);
      if (c.dragAnims.length) {
        const name = pick(c.dragAnims);
        log(c.petId, '-> [DRAG] ' + name);
        c.playAnim(name);
      }
    }
    // 记录指针轨迹，供初速估算。
    const now = performance.now();
    trail = trimTrail([...trail, { t: now, x: e.clientX, y: e.clientY }], now);
    // 弹簧目标是包围盒左上角，跟随循环逐帧追赶。
    follow.aim({ x: e.clientX - press.offX - c.halfW, y: e.clientY - press.offY - c.halfH });
    const rootEl = c.root();
    if (rootEl) follow.start(rootEl);
    const stageEl = c.stage();
    if (stageEl) stageEl.style.transform = 'none';
  };

  /**
   * 松手结算：原地放下、甩抛或弹弓。
   *
   * @param c - 当帧能力。
   * @param point - 松手现场；指针没跟上时用它的坐标兜底算落点。
   */
  const settleRelease = (c: DragCard, point: ReleasePoint): void => {
    // 释放位置取弹簧跟随的实时包围盒，而不是指针目标。
    const current = c.box();
    const box = current ?? { x: point.x - press.offX - c.halfW, y: point.y - press.offY - c.halfH };
    const decision = decideRelease({
      anchor: { x: press.anchorX, y: press.anchorY },
      box,
      half: { w: c.halfW, h: c.halfH },
      now: performance.now(),
      physics: c.physics,
      size: c.size,
      sling: press.sling,
      trail,
    });
    trail = [];
    if (decision.kind === 'sling') {
      log(
        c.petId,
        'sling dist=' +
          Math.round(decision.dist) +
          ' power=' +
          decision.power.toFixed(2) +
          ' vx=' +
          Math.round(decision.velocity.vx) +
          ' vy=' +
          Math.round(decision.velocity.vy),
      );
      c.startFlight(box.x, box.y, decision.velocity.vx, decision.velocity.vy);
      return;
    }
    if (decision.kind === 'throw') {
      const { vx, vy } = decision.velocity;
      log(c.petId, 'release vx=' + Math.round(vx) + ' vy=' + Math.round(vy) + ' |v|=' + Math.round(Math.hypot(vx, vy)));
      // 飞行期间由 rAF 直接写 left/top，落定后才提交归一化中心。
      c.startFlight(box.x, box.y, vx, vy);
      return;
    }
    // 原地放下：夹到可见下限后提交归一化中心；根节点位置由 commitPlace 直接写，不依赖重渲染。
    c.commitPlace(box);
  };

  /**
   * 松手后把提示摆回光标处并点亮；指针已移出命中区时保持收起。
   *
   * @param c - 当帧能力。
   * @param point - 松手现场。
   */
  const restoreTip = (c: DragCard, point: ReleasePoint): void => {
    const hitRect = point.hit.getBoundingClientRect();
    const inside =
      point.x >= hitRect.left && point.x <= hitRect.right && point.y >= hitRect.top && point.y <= hitRect.bottom;
    if (!inside) return;
    c.placeTip(point.x, point.y);
    c.setTipOn(true);
  };

  /**
   * 松手收尾的唯一路径：复位按下态、摘拖拽类、结算去向并把提示摆回去。
   *
   * @param c - 当帧能力。
   * @param point - 松手现场；正常 pointerup 与捕获丢失后的 window mouseup 都折算成它。
   */
  const endPress = (c: DragCard, point: ReleasePoint): void => {
    clearMouseFallback();
    // pointercancel 也走这条路径，长按计时器在这里一并清掉。
    touchPress.cancel();
    const wasDragging = press.dragging;
    press.active = false;
    press.dragging = false;
    point.hit.classList.remove('dragging');
    follow.stop();
    if (wasDragging) {
      justDraggedUntil = performance.now() + JUST_DRAGGED_MS;
      c.setDragging(false);
      const stageEl = c.stage();
      if (stageEl) stageEl.style.transform = 'translateY(' + c.bottomPad + 'px)';
      // 拖拽松手：非终态恢复工作循环，否则播一遍待机后回随机链。
      // once 必须为 true，否则 ended 不触发，随机链回不来。
      if (!c.resumeWork()) {
        if (c.idleAnims.length) c.playAnim(pick(c.idleAnims, c.currentAnim));
        c.setOnce(true);
      }
      settleRelease(c, point);
    }
    restoreTip(c, point);
  };

  const onPointerUp = (e: ReactNS.PointerEvent<HTMLDivElement>): void => {
    endPress(card(), { x: e.clientX, y: e.clientY, hit: e.currentTarget });
  };

  const onClick = (): void => {
    const c = card();
    if (press.active || press.dragging || performance.now() < justDraggedUntil) return;
    // 本次按下已触发过积分：只收手停住，不再播普通点击动画。
    if (pressScoreFired) {
      pressScoreFired = false;
      c.stopFlight();
      c.stopAutonomy();
      return;
    }
    c.stopFlight(); // 点击飞行中的宠物即收手停住。
    c.stopAutonomy();
    // 点击音效放在所有「不播点击动画」的早退分支之后。
    c.playClickSound();
    c.setOnce(true);
    if (!c.clickAnims.length) return;
    const name = pick(c.clickAnims);
    log(c.petId, '-> [CLICK] ' + name);
    c.markSquash(); // 等新点击动画切到前台后再压新首帧。
    // 单动画点击时状态不变，effect 不会重放；递增 seq 强制 switchTo 走一遍，
    // 防重分支负责消费 Q 弹标记。
    c.bumpSeq();
    c.playAnim(name);
  };

  return {
    isActive: () => press.active,
    justDragged: () => performance.now() < justDraggedUntil,
    onClick,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    stopFollow: follow.stop,
    dispose: clearMouseFallback,
  };
}
