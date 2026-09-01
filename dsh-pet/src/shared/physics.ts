// 拖拽抛掷物理（弹簧跟手 + 甩抛 + 重力反弹）：纯计算，无 DOM / rAF。
// 浏览器 overlay 与桌面模式共用同一份（src/shared = shared-core 单一来源），保证手感严格一致。
//
// 坐标语义：全部为「宠物包围盒左上角」的像素坐标（浏览器 = 视口 px；桌面 = 工作区 px）。
// 初速估算的轨迹样本用**指针**绝对坐标（浏览器 clientX/Y、桌面 screenX/Y）——
// 去掉两端的常数偏移后速度一致，物理步进完全共用。
// 参数与取值依据移植自 dsh-pet-indesktop 的 physics.py（纯函数、可单测）。
//
// 可调参数：重力 / 弹性 / 地面摩擦来自配置顶层 physics 段（host 合并成品，全局共用）；
// 本文件的常量只是**默认值来源**（= assets/config.jsonc 的 physics 段），
// 运行时 throwStep 必须接收调用方传入的 PhysicsParams（浏览器/桌面都从配置成品读）。
import type { PhysicsParams } from './types';

/** 拖拽弹簧刚度：越大跟手越紧 */
export const SPRING_K = 200;
/** 拖拽弹簧阻尼：ζ = c/(2√k) ≈ 1.06，过阻尼，不 overshoot */
export const SPRING_C = 30;

/** 拖拽轨迹保留窗口（ms）：只留最近这一段做初速估算 */
export const TRAIL_KEEP_MS = 200;
/** 初速估算窗口（ms） */
export const RELEASE_WINDOW_MS = 150;
/** 松手前停顿超过它 = 温柔放下（不带残余速度），即使之前甩过 */
export const RELEASE_STALE_MS = 150;
/** 窗口太短视为不可估算（ms） */
export const MIN_SPAN_MS = 20;
/** 分段速度的最小 dt（ms）：高回报率鼠标事件可低至 1ms，过小 dt 会把抖动放大成虚假峰值，短段向前合并 */
export const SEG_MIN_DT_MS = 8;
/** 低于此速度 = 不抛（原地放下），px/s */
export const DEAD_ZONE_SPEED = 500;
/** 甩出速度软上限（px/s）：cap*(1-e^(-s/cap))，任意力度下仍单调可区分，渐近不超过 cap */
export const MAX_THROW_SPEED = 3600;
/** 初速大小 = 端点均值*(1-w) + 窗口峰值*w（弥补快甩时位移集中在窗口内一小段的低估） */
export const PEAK_WEIGHT = 0.5;
/** 参考加速度（px/s²）：末段加速达到它即吃满增益 */
export const ACCEL_REF = 8000;
/** 加速度增益上限：仍在加速的甩动最多放大 60% */
export const ACCEL_GAIN_MAX = 0.6;

// ---- 抛掷物理默认值（= assets/config.jsonc 的 physics 段；运行时以配置成品为准） ----
/** 抛掷重力（px/s²） */
export const GRAVITY = 1400;
/** 碰边恢复系数：每次反弹保留约 78% 速度 */
export const RESTITUTION = 0.78;
/** 地面水平摩擦（/s） */
export const GROUND_FRICTION = 2.5;

/** 抛掷物理的默认参数（与内置配置一致；仅作配置缺失时的兜底） */
export const DEFAULT_PHYSICS: PhysicsParams = {
  gravity: GRAVITY,
  restitution: RESTITUTION,
  groundFriction: GROUND_FRICTION,
};
/** 落地时 |vy| 小于它直接停竖直 */
export const REST_VY = 40;
/** 地面上 |vx| 小于它认为已静止 */
export const REST_VX = 15;
/** 单步最大 dt（s）：防后台标签页/卡顿后恢复的巨帧跳变 */
export const MAX_STEP_DT = 0.05;

// ---- Q 弹挤压（squash & stretch）：点击回应 / 抛掷落地时角色垂直压扁再回弹 ----
/** 下压幅度：高度压到 55%（3 倍力度：原压深 15% → 现压深 45%，可继续调） */
export const SQ_SQUASH = 0.55;
/** 挤压时长（ms） */
export const SQ_DURATION_MS = 220;
/** 落地冲击速度基准：低于此 = 轻落（按下限幅度） */
export const SQ_SOFT_SPEED = 300;
/** 落地冲击速度上限：达到/超过此 = 重砸（吃满最大下压） */
export const SQ_HARD_SPEED = 1500;
/** 落地最大下压幅度（与点击一致）；轻落下限 0.8——重力 1400px/s²、恢复 0.78 下典型落地速度
 *  400~1500px/s，映射太保守会让常规甩抛的落地 Q 弹回到"不明显"，故底部留底限 */
export const SQ_MAX_SQUASH = 0.55;

/**
 * 落地冲击速度 → 下压幅度 scaleY 值（速度越大压得越狠）。
 * 返回作为 startSquash 的 squash 参数，曲线仍走 squashScale（u 进度不变）。
 */
export const landingSquash = (impactSpeed: number): number => {
  const t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1);
  return Math.min(0.8, 1 - t * (1 - SQ_MAX_SQUASH));
};

/**
 * Q 弹挤压曲线：u∈[0,1] 进度 → scaleY 值。
 * 下压段（0~0.45）ease-in 压缩；回弹段（0.45~1）easeOutBack 带回弹过冲（~4%）。
 * 两端共用同一曲线，手感严格一致。
 */
export const squashScale = (u: number, squash: number = SQ_SQUASH): number => {
  if (u < 0.45) {
    const p = u / 0.45;
    return 1 - (1 - squash) * p * p;
  }
  const p = (u - 0.45) / 0.55;
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  return Math.min(1.12, squash + (1 - squash) * Math.max(f, 0));
};

/** 一次轨迹采样（t = performance.now() 时间戳 ms；x/y = 指针绝对坐标 px） */
export interface DragSample {
  t: number;
  x: number;
  y: number;
}

/** 抛掷边界：包围盒左上角的允许活动范围（与浏览器 rootStyle / 桌面 position 同一套「身体贴边」语义） */
export interface ThrowBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 抛体当前状态（包围盒左上角 px + 速度 px/s） */
export interface ThrowState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 由 W/H/size 计算抛掷碰撞边界：身体（盒内缩 sideAllow）贴屏幕边缘才反弹 */
export const throwBounds = (o: { W: number; H: number; size: number; sideAllow: number }): ThrowBounds => {
  const h = (o.size * 9) / 16;
  return { minX: -o.sideAllow, minY: 0, maxX: o.W - o.size + o.sideAllow, maxY: o.H - h };
};

/** 剔除超过保留窗口的旧采样（顺带排序去重，调用前采样按时间追加即可） */
export const trimTrail = (trail: DragSample[], now: number): DragSample[] => {
  const cutoff = now - TRAIL_KEEP_MS;
  let i = 0;
  while (i < trail.length && trail[i].t < cutoff) i++;
  return i === 0 ? trail : trail.slice(i);
};

/** 过阻尼弹簧单轴速度步进：调用方随后 x += v*dt */
export const springStep = (v: number, x: number, target: number, dt: number): number =>
  v + ((target - x) * SPRING_K - v * SPRING_C) * dt;

const softClampSpeed = (speed: number): number => {
  if (speed <= 0) return 0;
  return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED));
};

/**
 * 由拖拽轨迹估算松手初速 (vx, vy)，px/s。
 * 方向：窗口首末端点位移方向（抗抖）。大小：端点平均与峰值按 PEAK_WEIGHT 加权，
 * 末段仍在加速时按 ACCEL_REF 比例增益（最多 ACCEL_GAIN_MAX），软钳速封顶。
 * 返回 null = 温柔放下（轨迹为空 / 停留过久 / 窗口太短 / 峰值速度低于死区），调用方不抛。
 */
export const estimateReleaseVelocity = (trail: DragSample[], now: number): { vx: number; vy: number } | null => {
  if (trail.length === 0) return null;
  const last = trail[trail.length - 1];
  if (now - last.t > RELEASE_STALE_MS) return null;
  const win = trail.filter((s) => now - s.t <= RELEASE_WINDOW_MS);
  if (win.length < 2) return null;
  const t0 = win[0].t;
  const x0 = win[0].x;
  const y0 = win[0].y;
  const t1 = win[win.length - 1].t;
  const x1 = win[win.length - 1].x;
  const y1 = win[win.length - 1].y;
  const spanMs = t1 - t0;
  if (spanMs < MIN_SPAN_MS) return null;
  const baseVx = ((x1 - x0) / spanMs) * 1000;
  const baseVy = ((y1 - y0) / spanMs) * 1000;
  const baseSpeed = Math.hypot(baseVx, baseVy);
  if (baseSpeed < 1e-6) return null; // 窗口内几乎纯抖动：没有可靠方向，按原地放下处理
  // 分段速度（过密采样向前合并，dt 下限 SEG_MIN_DT_MS）
  const segSpeeds: { speed: number; tEnd: number }[] = [];
  let px = x0;
  let py = y0;
  let pt = t0;
  for (const s of win.slice(1)) {
    const dt = s.t - pt;
    if (dt >= SEG_MIN_DT_MS) {
      segSpeeds.push({ speed: (Math.hypot(s.x - px, s.y - py) / dt) * 1000, tEnd: s.t });
      px = s.x;
      py = s.y;
      pt = s.t;
    }
  }
  const peakSpeed = segSpeeds.length ? Math.max(...segSpeeds.map((v) => v.speed)) : baseSpeed;
  // 末段加速度：末段峰值速度相对首段的斜率（仍在加速的甩动放大初速）
  let accel = 0;
  if (segSpeeds.length >= 2) {
    const lastSeg = segSpeeds[segSpeeds.length - 1];
    const firstSeg = segSpeeds[0];
    accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1000, MIN_SPAN_MS / 1000);
  }
  const speedBeforeClamp =
    ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) *
    (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX);
  const speed = softClampSpeed(speedBeforeClamp);
  if (speed < DEAD_ZONE_SPEED) return null;
  return { vx: (baseVx / baseSpeed) * speed, vy: (baseVy / baseSpeed) * speed };
};

/**
 * 抛体单步积分 + 边界反弹。返回更新后的状态与两个标志：
 * bounced = 本步是否碰边/落地；atRest = 贴地且低速（或碰边后整体低速），调用方应停止循环。
 * physics = 配置成品的抛掷物理参数（重力/弹性/地面摩擦）；缺失时用默认值兜底。
 */
export const throwStep = (
  s: ThrowState,
  dtRaw: number,
  b: ThrowBounds,
  physics: PhysicsParams = DEFAULT_PHYSICS,
): ThrowState & { bounced: boolean; atRest: boolean } => {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
  let { x, y, vx, vy } = s;
  vy += physics.gravity * dt;
  x += vx * dt;
  y += vy * dt;
  let bounced = false;
  if (x < b.minX) {
    x = b.minX;
    vx = Math.abs(vx) * physics.restitution;
    bounced = true;
  } else if (x > b.maxX) {
    x = b.maxX;
    vx = -Math.abs(vx) * physics.restitution;
    bounced = true;
  }
  if (y < b.minY) {
    y = b.minY;
    vy = Math.abs(vy) * physics.restitution;
    bounced = true;
  } else if (y >= b.maxY) {
    y = b.maxY;
    vx *= Math.max(0, 1 - physics.groundFriction * dt);
    if (Math.abs(vy) < REST_VY) vy = 0;
    else vy = -Math.abs(vy) * physics.restitution;
    bounced = true;
  }
  const speed = Math.hypot(vx, vy);
  const atRest =
    (y >= b.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < REST_VX) || (bounced && speed < REST_VY && Math.abs(vy) < 1);
  return { x, y, vx, vy, bounced, atRest };
};
