// 弹弓小互动（桌面右键「弹弓」打开的透明窗口）的纯逻辑：
// 场景尺寸 / 宠物几何 / 弹弓初速 / 木箱垛布局 / 损伤与「全倒」判定 / 会话状态。无 DOM、无物理引擎——
// 刚体模拟（木箱翻倒、碰撞、宠物飞行）在 runtime/electron-helper/game-physics.js（matter-js），
// 渲染与输入在 game.js（经 shared-core 读 window.PetShared）。
//
// 这不是一个「游戏」：没有分数、次数、关卡与胜负。宠物站在弹弓皮兜里，用户把她往后拽、松手，
// 她飞出去撞那垛木箱；撞得重的木箱会裂、再撞就碎。整垛都被推倒（没有哪块还垫在别的上面）
// 她就开心地跳一下，木箱再重新码好。
//
// 坐标语义：全部为**逻辑场景像素**，y 向下；渲染端按桌宠大小缩放、底边对齐（sceneView）。场景宽随屏而变
// （左右墙 = 窗口边，可以伸到 x < 0 或 x > GAME_W），GAME_W × GAME_H 只是「至少要放得下」的最小场景。
// 状态更新一律返回新对象（不改入参）。
import { CANVAS_H, HIT_BOX } from './constants';
import { bodyPixelBox } from './physics';

/** 场景点（逻辑像素） */
export interface GameVec {
  x: number;
  y: number;
}

/** 轴对齐矩形（与 bodyPixelBox 同形） */
export interface GameBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// ---- 场景 ----
/** 最小场景宽（16:9）：窗口再小也至少放得下 GAME_W × GAME_H（见 sceneFit） */
export const GAME_W = 1280;
/** 最小场景高 */
export const GAME_H = 720;
/** 地面线 y：窗口底边贴工作区底边（见 game-launch.js），地面 ≈ 任务栏上沿，与桌宠落地处一致 */
export const GAME_GROUND_Y = 708;
/** 场景里宠物包围盒宽（与 640×360 动画帧同比例）；渲染时按桌宠的实际大小换算（见 sceneFit） */
export const GAME_PET_SIZE = 300;
/** 场景重力（px/s²）：比桌面抛掷略低，弧线更平、好瞄 */
export const GAME_GRAVITY = 1200;
/** 物理推进的固定步长（s） */
export const GAME_STEP_DT = 1 / 60;
/** 单发最长飞行时间（s）：在墙间来回弹太久时强制落定 */
export const MAX_FLIGHT_SEC = 7;

/**
 * 场景 → 窗口的缩放（CSS 像素 / 场景像素）。宠物进了弹弓**大小不变**：缩放取 petSize / GAME_PET_SIZE，
 * 画出来的宠物就和桌面上那只一样大（弹弓、木箱与她的比例也不变）。只有桌宠大到整个场景塞不进窗口时，
 * 才退回「整窗放下」的缩放；petSize 缺失 / 非法同样整窗放下。
 */
export const sceneFit = ({ width, height, petSize }: { width: number; height: number; petSize?: number }): number => {
  const whole = Math.min(width / GAME_W, height / GAME_H);
  const size = Number(petSize);
  if (!Number.isFinite(size) || size <= 0) return whole;
  return Math.min(size / GAME_PET_SIZE, whole);
};

// ---- 宠物几何（HIT_BOX 是 640×360 舞台坐标） ----
const STAGE_W = 640;
const PET_H = (GAME_PET_SIZE * 9) / 16;
/** 身体中心相对包围盒左上角的偏移 */
const BODY_CENTER: GameVec = {
  x: ((HIT_BOX.x0 + HIT_BOX.x1) / 2 / STAGE_W) * GAME_PET_SIZE,
  y: ((HIT_BOX.y0 + HIT_BOX.y1) / 2 / CANVAS_H) * PET_H,
};
const BODY_BOTTOM = (HIT_BOX.y1 / CANVAS_H) * PET_H;
/** 身体中心到脚底的距离 */
const HALF_BODY_H = BODY_BOTTOM - BODY_CENTER.y;

/** 身体中心 → 包围盒左上角 */
export const petBoxAt = (center: GameVec): GameVec => ({ x: center.x - BODY_CENTER.x, y: center.y - BODY_CENTER.y });

/** 包围盒左上角 → 身体中心 */
export const petCenterOf = (box: GameVec): GameVec => ({ x: box.x + BODY_CENTER.x, y: box.y + BODY_CENTER.y });

/** 包围盒左上角 → 身体命中框（与桌面/浏览器同一个 HIT_BOX 比例） */
export const petBody = (box: GameVec): GameBox =>
  bodyPixelBox({ x: box.x, y: box.y, size: GAME_PET_SIZE, bottomPad: 0 });

// ---- 弹弓 ----
/** 弹弓树干落地点 */
export const SLING_BASE: GameVec = { x: 240, y: GAME_GROUND_Y };
/** 叉尖（皮筋绑扎处）离地高度——必须与画好的 sling.png / sling.json 一致（有单测钉住） */
export const SLING_FORK_HEIGHT = 106;
/** 皮兜在叉尖下方垂多少（宠物脚底就站在这里） */
const POUCH_SAG = 4;
/** 待发位置（身体中心）：宠物站在两根叉尖之间的皮兜里 */
export const SLING_ANCHOR: GameVec = {
  x: SLING_BASE.x,
  y: SLING_BASE.y - SLING_FORK_HEIGHT + POUCH_SAG - HALF_BODY_H,
};
/** 最大拉伸距离（px） */
export const SLING_MAX_PULL = 150;
/** 拉伸小于它 = 取消发射（宠物弹回皮兜） */
export const SLING_MIN_PULL = 20;
/** 每像素拉伸给的初速（px/s）：拉满 150px ≈ 1725px/s */
export const SLING_POWER = 11.5;

/** 拖拽目标 → 宠物位置（身体中心）：以待发点为圆心夹在最大拉伸半径内，且脚不钻进地面 */
export const aimPoint = (target: GameVec): GameVec => {
  const dx = target.x - SLING_ANCHOR.x;
  const dy = target.y - SLING_ANCHOR.y;
  const dist = Math.hypot(dx, dy);
  const k = dist > SLING_MAX_PULL ? SLING_MAX_PULL / dist : 1;
  return { x: SLING_ANCHOR.x + dx * k, y: Math.min(SLING_ANCHOR.y + dy * k, GAME_GROUND_Y - HALF_BODY_H) };
};

/**
 * 拉伸位置 → 发射初速 (px/s)：方向与拉伸相反，大小 = 拉伸距离 × power（缺省 SLING_POWER；超过最大拉伸按最大算）。
 * 拉伸不足 SLING_MIN_PULL 返回 null = 取消。power 由 sceneView 按木箱垛离多远给出。
 */
export const slingVelocity = (pulled: GameVec, power: number = SLING_POWER): { vx: number; vy: number } | null => {
  const dx = pulled.x - SLING_ANCHOR.x;
  const dy = pulled.y - SLING_ANCHOR.y;
  const dist = Math.hypot(dx, dy);
  if (dist < SLING_MIN_PULL) return null;
  const speed = Math.min(dist, SLING_MAX_PULL) * power;
  return { vx: (-dx / dist) * speed, vy: (-dy / dist) * speed };
};

// ---- 木箱垛 ----
export type BlockKind = 'crate';

/** 一块积木的摆放（中心点 + 宽高，逻辑像素）；id = 下标 */
export interface BlockSpot {
  readonly id: number;
  readonly kind: BlockKind;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const CRATE = 54;
/** 每摞几只（从左到右）：分开站成一排的几摞，中间那摞最高（270，比宠物高出一截） */
const PILE_STACKS = [2, 3, 5, 3, 2];
/** 相邻两摞的中心距：中间空出 ~40，撞哪摞倒哪摞，倒下来的还会砸到旁边那摞 */
const STACK_PITCH = 95;
/** STRUCTURE 的右边缘（参考摆法；实际摆在哪由 sceneView().pileRight + pileAt 决定） */
const PILE_RIGHT = 1180;

/** 按 PILE_STACKS 摆：每摞的木箱正正地一只压一只，摞与摞之间留空当；id 自左向右、自下而上 */
const pile = (): BlockSpot[] => {
  const firstX = PILE_RIGHT - CRATE / 2 - (PILE_STACKS.length - 1) * STACK_PITCH;
  return PILE_STACKS.flatMap((n, col) => Array.from({ length: n }, (_, row) => ({ col, row }))).map(
    ({ col, row }, id) => ({
      id,
      kind: 'crate' as const,
      x: firstX + col * STACK_PITCH,
      y: GAME_GROUND_Y - CRATE * row - CRATE / 2,
      w: CRATE,
      h: CRATE,
    }),
  );
};

/**
 * 木箱：离弹弓远远的一排，分开站着的五摞（2-3-5-3-2 只）。每只都正好落地或压在下面那只的顶上（有单测钉住），
 * 开局全部「睡着」，被撞醒之前纹丝不动。
 */
export const STRUCTURE: readonly BlockSpot[] = Object.freeze(pile().map((b) => Object.freeze(b)));

/** 整垛的宽（最左到最右） */
const PILE_WIDTH = PILE_RIGHT - Math.min(...STRUCTURE.map((b) => b.x - b.w / 2));

/** 把整垛木箱平移到右边缘 = right 处（形状、id 不变）；返回冻结的新数组，不改 STRUCTURE */
export const pileAt = (right: number): readonly BlockSpot[] => {
  const dx = right - PILE_RIGHT;
  return Object.freeze(STRUCTURE.map((b) => Object.freeze({ ...b, x: b.x + dx })));
};

// ---- 场景摆在屏幕上 ----
/** 弹弓（宠物站的位置）离屏幕左边、木箱垛右边缘离屏幕右边，各占屏宽的这么多 */
export const SCREEN_INSET = 1 / 6;

/** 场景在窗口里的摆法：缩放、偏移（CSS 像素），以及换算成场景坐标的两堵墙与木箱垛右边缘 */
export interface SceneView {
  readonly fit: number;
  readonly offX: number;
  readonly offY: number;
  readonly wallLeft: number;
  readonly wallRight: number;
  readonly pileRight: number;
  /** 这块屏上的弹力（见 REACH_GAP） */
  readonly power: number;
}

/**
 * SLING_POWER 是按「弹弓到木箱垛左边缘」这么远调的手感。屏特别宽 / 桌宠特别小时场景会很宽、木箱垛离得更远，
 * 弹力按 √(距离 / REACH_GAP) 加大（射程 ∝ 速度²，于是射程与距离同比例），保证总打得到；距离不超过它时就是 SLING_POWER。
 */
export const REACH_GAP = 1000;
/**
 * 弹力最多放大到这么多倍：最快一发约 4100 px/s，每个物理子步（1/120 s）走 ~35px，不到一只木箱宽（matter 没有连续碰撞，
 * 再快就可能直接穿过木箱）。屏极宽、桌宠极小、放大到顶也够不着 5/6 处时，木箱垛往里收到够得着的地方。
 */
export const MAX_POWER_BOOST = 2.4;

/**
 * 窗口（width × height CSS 像素，铺满工作区）里怎么摆场景：
 *   - 缩放 = sceneFit（宠物与桌面上一样大）；地面贴窗口底；
 *   - 弹弓在屏宽 1/6 处，木箱垛右边缘在 5/6 处（中间离得远，屏越宽离得越远；极端宽屏见 MAX_POWER_BOOST）；
 *   - 左右墙就是窗口左右边——宠物和木箱撞的是看得见的屏幕边；
 *   - power：木箱垛离得比平常远时加大弹力（见 REACH_GAP）。
 * sceneFit 保证场景至少有 GAME_W 宽，所以再窄的屏，木箱垛离弹弓也有 600 开外（有单测钉住）。
 */
export const sceneView = ({
  width,
  height,
  petSize,
}: {
  width: number;
  height: number;
  petSize?: number;
}): SceneView => {
  const fit = sceneFit({ width, height, petSize });
  const offX = width * SCREEN_INSET - SLING_BASE.x * fit;
  const toSceneX = (cx: number) => (cx - offX) / fit;
  const maxGap = REACH_GAP * MAX_POWER_BOOST * MAX_POWER_BOOST;
  const pileRight = Math.min(toSceneX(width * (1 - SCREEN_INSET)), SLING_ANCHOR.x + maxGap + PILE_WIDTH);
  const gap = pileRight - PILE_WIDTH - SLING_ANCHOR.x;
  return {
    fit,
    offX,
    offY: height - GAME_H * fit,
    wallLeft: toSceneX(0),
    wallRight: toSceneX(width),
    pileRight,
    power: SLING_POWER * Math.sqrt(Math.max(1, gap / REACH_GAP)),
  };
};

// ---- 损伤 ----
/** 每块积木的耐久：中等撞击掉 1（裂开），重击直接掉满（碎） */
export const BLOCK_HP = 2;
/** 碰撞法向速度（px/s）达到它就裂一下：宠物擦过、积木从两层高摔下来都会到这个量级 */
export const CRACK_SPEED = 420;
/** 达到它一下就碎：宠物正面砸中 */
export const BREAK_SPEED = 1000;

/** 一次碰撞（法向相对速度 px/s）造成多少伤害 */
export const impactDamage = (speed: number): number => {
  if (!Number.isFinite(speed) || speed < CRACK_SPEED) return 0;
  return speed >= BREAK_SPEED ? BLOCK_HP : 1;
};

// ---- 「全倒」 ----
/** 底边离地面不超过它就算「落在地上」（翻倒、斜靠着的箱子都会有一点点误差） */
export const DOWN_TOLERANCE = 6;

/**
 * 整垛是不是都被推倒了：剩下（没碎）的每一块底边都贴着地面——没有哪块还垫在别的上面。
 * blocks = 物理世界里积木的当前包围盒（bottom/top，y 向下）；broken = 已碎掉的 id。
 */
export const isFlattened = (
  blocks: readonly { id: number; bottom: number; top: number }[],
  broken: ReadonlySet<number>,
): boolean => blocks.every((b) => broken.has(b.id) || b.bottom >= GAME_GROUND_Y - DOWN_TOLERANCE);

// ---- 会话 ----
/** aiming = 宠物在皮兜里（或正淡出 / 淡入回到皮兜）；flying = 飞出去了；cleared = 整排都倒了 */
export type SlingshotPhase = 'aiming' | 'flying' | 'cleared';

export interface BlockState {
  readonly id: number;
  readonly hp: number;
  readonly broken: boolean;
}

export interface SlingshotState {
  readonly phase: SlingshotPhase;
  readonly blocks: readonly BlockState[];
}

/** 一局新的会话：积木全部满血（不继承任何上一局的东西） */
export const newSession = (): SlingshotState => ({
  phase: 'aiming',
  blocks: STRUCTURE.map((b) => ({ id: b.id, hp: BLOCK_HP, broken: false })),
});

/** 还没碎的积木数 */
export const blocksLeft = (s: SlingshotState): number => s.blocks.filter((b) => !b.broken).length;

/**
 * 对一块积木造成 amount 点伤害：掉到 0 = 碎（broke），没到 0 = 裂开（cracked）。
 * 0 伤害 / 已碎 / 未知 id：原样返回 state。不分阶段——宠物落地后积木还在连锁倒塌，照样会摔坏。
 */
export const damageBlock = (
  s: SlingshotState,
  id: number,
  amount: number,
): { state: SlingshotState; cracked: boolean; broke: boolean } => {
  const b = s.blocks.find((x) => x.id === id);
  if (!b || b.broken || !(amount > 0)) return { state: s, cracked: false, broke: false };
  const hp = Math.max(0, b.hp - amount);
  const broke = hp === 0;
  const blocks = s.blocks.map((x) => (x.id === id ? { ...x, hp, broken: broke } : x));
  return { state: { ...s, blocks }, cracked: !broke, broke };
};

/** 发射：只在瞄准阶段生效 */
export const fireShot = (s: SlingshotState): SlingshotState => (s.phase === 'aiming' ? { ...s, phase: 'flying' } : s);

/** 本发落定：飞行 → 瞄准（没有次数限制）；其它阶段原样返回 */
export const settleShot = (s: SlingshotState): SlingshotState => (s.phase === 'flying' ? { ...s, phase: 'aiming' } : s);

/** 整垛倒了 */
export const markCleared = (s: SlingshotState): SlingshotState =>
  s.phase === 'cleared' ? s : { ...s, phase: 'cleared' };
