/**
 * 抛掷物理：甩抛初速估算、重力积分、边界反弹与屏间穿越。
 *
 * 不处理指针事件与渲染；输入是坐标与 dt，输出是下一帧状态。
 * 撞击统一交给 contact.ts 按接触面法向分解：法向反弹、切向摩擦。
 * 必须始终成立：同一输入必得同一输出，两端（浏览器与桌面）手感一致。
 * @module dsh-pet/src/shared/physics/throw
 */
import { type PhysicsParams, type Rect } from '../types.ts';
import { indexAtPoint, nearestIndex, rectBottom, rectRight } from '../displays.ts';
import { DEFAULT_PHYSICS, MAX_STEP_DT, SUBSTEP_MAX, SUBSTEP_PX } from './constants.ts';
import { type ContactEdge, isRestingOnContacts, resolveContact } from './contact.ts';

/** 一次轨迹采样（t = performance.now() 时间戳 ms；x/y = 指针绝对坐标 px）。 */
export interface DragSample {
  t: number;
  x: number;
  y: number;
}

/** 抛掷边界：包围盒左上角的允许活动范围（与浏览器 root 的 left/top、桌面窗口位置同一套身体贴边语义）。 */
export interface ThrowBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 抛体当前状态（包围盒左上角 px + 速度 px/s）。 */
export interface ThrowState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** 由 W/H/size 计算抛掷碰撞边界：身体（盒内缩 sideAllow）贴屏幕边缘才反弹。 */
export const throwBounds = (o: { W: number; H: number; size: number; sideAllow: number }): ThrowBounds => {
  const h = (o.size * 9) / 16;
  return { minX: -o.sideAllow, minY: 0, maxX: o.W - o.size + o.sideAllow, maxY: o.H - h };
};

/** 同 throwBounds，但基于任意一块工作区矩形（原点不必是 0）；area 取整个视口时两者逐位相同。 */
export const throwBoundsIn = (area: Rect, size: number, sideAllow: number): ThrowBounds => {
  const h = (size * 9) / 16;
  return {
    minX: area.x - sideAllow,
    minY: area.y,
    maxX: rectRight(area) - size + sideAllow,
    maxY: rectBottom(area) - h,
  };
};

/** 抛掷空间：每块屏一套 AABB，而不是整个桌面一个大 AABB。
 *  不规则多屏布局下外接矩形含空洞，用它当边界会让宠物飞进不可见区域（见 shared/displays.ts）。 */
export interface ThrowSpace {
  /** 逐屏的包围盒左上角允许范围（与 areas 同序） */
  bounds: ThrowBounds[];
  /** 逐屏工作区（反弹与归属判定；任务栏挖掉的条带不在此列） */
  areas: Rect[];
  /** 逐屏完整面板（含任务栏区，与 areas 同序）：越界侧有没有邻屏要用面板探测——任务栏位于屏缝时
   *  工作区之间会空出一条不属于任何 workArea 的带，按工作区探测会把接缝当墙。
   *  缺省 = areas（单屏时两者等价）。 */
  panels: Rect[];
  /** 宠物包围盒宽 */
  size: number;
  /** 身体相对包围盒左右各内缩的量 */
  sideAllow: number;
}

/** 由工作区列表构造抛掷空间（单块屏时等价于 throwBounds）。 */
export const throwSpace = (o: { areas: Rect[]; panels?: Rect[]; size: number; sideAllow: number }): ThrowSpace => ({
  bounds: o.areas.map((a) => throwBoundsIn(a, o.size, o.sideAllow)),
  areas: o.areas,
  panels: o.panels && o.panels.length === o.areas.length ? o.panels : o.areas, // 面板缺失或不同序：退化用工作区
  size: o.size,
  sideAllow: o.sideAllow,
});

/** 宠物当前该归属哪块屏：身体中心所在屏，落在空洞里时取最近的一块。 */
export const screenOfBox = (space: ThrowSpace, x: number, y: number): number => {
  const cx = x + space.size / 2;
  const cy = y + (space.size * 9) / 16 / 2;
  const hit = indexAtPoint(space.areas, cx, cy);
  return hit >= 0 ? hit : nearestIndex(space.areas, cx, cy);
};

/** 本步撞到的边与撞击速度。 */
export interface ThrowHit {
  /** 撞的是哪条边。 */
  edge: ContactEdge;
  /** 撞击前的法向速度绝对值（px/s）：振动强度与挤压强度都按它算。 */
  speed: number;
}

/** 平面重力向量（px/s²）：体感模式把重力方向交给手机姿态，默认仍是竖直向下。 */
export interface GravityVector {
  readonly gx: number;
  readonly gy: number;
}

/** 抛体单步积分与边界反弹。返回值带上两个标志：bounced = 本步是否碰边或落地，
 *  atRest = 所有接触面都已贴住且切向低速，调用方应停止循环；contacts = 本步接触到的边。
 *  physics 取成品配置的物理参数，缺失时用默认值兜底；gravity 覆盖重力方向与大小（缺省竖直向下）。 */
export const throwStep = (
  s: ThrowState,
  dtRaw: number,
  b: ThrowBounds,
  physics: PhysicsParams = DEFAULT_PHYSICS,
  gravity?: GravityVector,
): ThrowState & { bounced: boolean; atRest: boolean; hit: ThrowHit | null; contacts: ContactEdge[] } => {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
  const g: GravityVector = gravity ?? { gx: 0, gy: physics.gravity };
  let { x, y, vx, vy } = s;
  vx += g.gx * dt;
  vy += g.gy * dt;
  x += vx * dt;
  y += vy * dt;
  let bounced = false;
  let hit: ThrowHit | null = null;
  const contacts: ContactEdge[] = [];
  /** 同一步撞到两条边（角落）时 hit 留更重的那个（手感只按主撞击算），contacts 全量保留。 */
  const record = (edge: ContactEdge, speed: number): void => {
    contacts.push(edge);
    if (hit === null || speed > hit.speed) hit = { edge, speed };
  };
  if (x < b.minX) {
    record('left', Math.abs(vx));
    x = b.minX;
    const out = resolveContact({ vx, vy }, 'left', physics, dt);
    vx = out.vx;
    vy = out.vy;
    bounced = true;
  } else if (x > b.maxX) {
    record('right', Math.abs(vx));
    x = b.maxX;
    const out = resolveContact({ vx, vy }, 'right', physics, dt);
    vx = out.vx;
    vy = out.vy;
    bounced = true;
  }
  if (y < b.minY) {
    // ceilingBounce=false：顶部无边界，不夹不弹——宠物飞出屏幕顶部，靠重力落回（y 保持越界状态）
    if (physics.ceilingBounce) {
      record('ceiling', Math.abs(vy));
      y = b.minY;
      const out = resolveContact({ vx, vy }, 'ceiling', physics, dt);
      vx = out.vx;
      vy = out.vy;
      bounced = true;
    }
  } else if (y >= b.maxY) {
    record('floor', Math.abs(vy));
    y = b.maxY;
    const out = resolveContact({ vx, vy }, 'floor', physics, dt);
    vx = out.vx;
    vy = out.vy;
    bounced = true;
  }
  return { x, y, vx, vy, bounced, atRest: isRestingOnContacts(contacts, { vx, vy }), hit, contacts };
};

/** 多屏抛掷步进：物理与 throwStep 同一套，区别是边界取自身体中心所在屏，越界后多问一句越界侧有没有屏。
 *  越界侧有别的屏就原样放行（不夹不弹，自然跨屏飞行或落到下一块屏），什么都没有才按该边反弹。
 *  探测用完整面板而不是工作区：任务栏位于上下屏接缝时 workArea 之间会空出一条带，按工作区探测
 *  会把接缝当墙，宠物永远穿不过去。探测点取当前面板的边外第一像素，面板底即物理屏底。
 *  放行时不改位置也不记录当前屏，下一帧由身体中心重新定位——相邻两屏的 AABB 在缝隙处留有
 *  2×sideAllow 宽的重叠盲区，改成「越界即切屏」会在盲区里逐帧对跳。
 *  lockScreen ≥ 0 表示锁定该屏（confineToScreen）：边界恒取该屏、跳过邻屏探测，屏缝与空洞一样当墙；
 *  索引越界（飞行途中拔掉显示器）即退回不锁定，免得拿一块不存在的屏当边界。 */
export const throwStepRegion = (
  s: ThrowState,
  dtRaw: number,
  space: ThrowSpace,
  physics: PhysicsParams = DEFAULT_PHYSICS,
  lockScreen = -1,
  gravity?: GravityVector,
): ThrowState & {
  screen: number;
  bounced: boolean;
  atRest: boolean;
  hit: ThrowHit | null;
  contacts: ContactEdge[];
} => {
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT);
  const g: GravityVector = gravity ?? { gx: 0, gy: physics.gravity };
  let { x, y, vx, vy } = s;
  vx += g.gx * dt;
  vy += g.gy * dt;
  x += vx * dt;
  y += vy * dt;
  if (space.areas.length === 0) {
    return { x, y, vx, vy, screen: -1, bounced: false, atRest: false, hit: null, contacts: [] };
  }

  const h = (space.size * 9) / 16;
  let bounced = false;
  let hit: ThrowHit | null = null;
  const contacts: ContactEdge[] = [];
  /** 同一步撞到两条边时 hit 留更重的那个，与 {@link throwStep} 同口径；contacts 全量保留。 */
  const record = (edge: ContactEdge, speed: number): void => {
    contacts.push(edge);
    if (hit === null || speed > hit.speed) hit = { edge, speed };
  };
  // 锁定屏（confineToScreen）：索引越界（飞行途中拔掉显示器导致屏数变少）即视为不锁定
  const locked = Number.isInteger(lockScreen) && lockScreen >= 0 && lockScreen < space.areas.length;
  /** 该用哪块屏的 AABB / 工作区 / 面板：锁定时恒为锁定屏，否则取身体中心所在屏 */
  const pick = (i: number): number => (locked ? lockScreen : i);

  // 横向：边界来自身体中心所在屏，放行与否看缝外同高度处有没有像素
  let cur = screenOfBox(space, x, y);
  let b = space.bounds[pick(cur)];
  let a = space.areas[pick(cur)];
  const pa = space.panels[pick(cur)] || a;
  const cy = y + h / 2;
  if (x < b.minX) {
    if (locked || indexAtPoint(space.panels, pa.x - 1, cy) < 0) {
      record('left', Math.abs(vx));
      x = b.minX;
      const out = resolveContact({ vx, vy }, 'left', physics, dt);
      vx = out.vx;
      vy = out.vy;
      bounced = true;
    }
  } else if (x > b.maxX) {
    if (locked || indexAtPoint(space.panels, rectRight(pa), cy) < 0) {
      record('right', Math.abs(vx));
      x = b.maxX;
      const out = resolveContact({ vx, vy }, 'right', physics, dt);
      vx = out.vx;
      vy = out.vy;
      bounced = true;
    }
  }

  // 纵向：横向若被夹回，身体中心可能已换屏，重新定位
  cur = screenOfBox(space, x, y);
  b = space.bounds[pick(cur)];
  a = space.areas[pick(cur)];
  const pa2 = space.panels[pick(cur)] || a;
  const cx = x + space.size / 2;
  if (y < b.minY) {
    // ceilingBounce=false：顶部无边界，不夹不弹——宠物飞出屏幕顶部，靠重力落回
    if (physics.ceilingBounce && (locked || indexAtPoint(space.panels, cx, pa2.y - 1) < 0)) {
      record('ceiling', Math.abs(vy));
      y = b.minY;
      const out = resolveContact({ vx, vy }, 'ceiling', physics, dt);
      vx = out.vx;
      vy = out.vy;
      bounced = true;
    }
  } else if (y >= b.maxY) {
    // 下方还有一块屏（上下排布的桌面）⇒ 不当地面，继续往下掉
    if (locked || indexAtPoint(space.panels, cx, rectBottom(pa2)) < 0) {
      record('floor', Math.abs(vy));
      y = b.maxY;
      const out = resolveContact({ vx, vy }, 'floor', physics, dt);
      vx = out.vx;
      vy = out.vy;
      bounced = true;
    }
  }

  cur = pick(screenOfBox(space, x, y));
  return {
    x,
    y,
    vx,
    vy,
    screen: cur,
    bounced,
    atRest: isRestingOnContacts(contacts, { vx, vy }),
    hit,
    contacts,
  };
};

/** 一帧该积几步（整数 ≥ 1）。N = 1 是常态：普通甩抛一帧位移远小于 8px；
 *  只有弹弓拉得很远、初速几千 px/s 时才拆多步，否则一帧跨过上百 px 会跳过落地与反弹那几帧。
 *  dt 先按 MAX_STEP_DT 夹取（与 throwStep 内部同源），保证步数算的就是实际要积的时间。 */
export const throwSubsteps = (vx: number, vy: number, dt: number): number => {
  const travel = Math.hypot(vx, vy) * Math.min(Math.max(dt, 0), MAX_STEP_DT);
  if (!(travel > SUBSTEP_PX)) return 1;
  return Math.min(SUBSTEP_MAX, Math.ceil(travel / SUBSTEP_PX));
};
