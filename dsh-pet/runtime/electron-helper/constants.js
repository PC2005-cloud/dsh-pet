/**
 * dsh-pet desktop helper —— 基础设施（常量 + 全局状态 + 调试钩子）。
 *
 * 经典 script 全局共享（经 index.html 顺序加载，先于 sprite.js / events.js / renderer.js）；
 * 顶层 const/let/function 都进全局词法环境，后续文件可直接引用。
 */
'use strict';

const S = window.PetShared;

const params = new URLSearchParams(location.search);
const CONFIG = {
  configUrl: params.get('configUrl') || 'http://127.0.0.1:3080/dsh-pet-7340/config',
  scale: Number(params.get('scale') || '1'),
  petIndex: Number(params.get('petIndex') || '0'),
};

// ---------- 渲染端坐标系统一约定（DESIGN.md §3.5） ----------
// main 进程对窗口做页面级缩放 setZoomFactor(CONFIG.scale) 后，本窗口的 DOM 度量、事件坐标、
// 桌面几何（VIEW/AREAS/PRIMARY_AREA）与全部 shared 组件（右键菜单/积分弹窗/聊天框）都在
// **同一套 CSS 像素**里——固定 px UI 随缩放自动恢复 DIP 观感，组件代码零换算。
// 主进程侧（窗口 bounds、逐屏几何、碰撞 broker）仍是物理像素：与它交换的值只允许在下面两个
// 收口换算（×scale 发出去 / ÷scale 收进来），任何组件代码不得再乘除（防散修回归）。
function toScreen(v) {
  return v * CONFIG.scale;
}
function toLocal(v) {
  return v / CONFIG.scale;
}
// bridge 模式（DSH_PET_BRIDGE=1）：请求走自定义 scheme，经 Electron 主进程转宿主管道——
// 绕开 DSH Desktop 2.0.3+ 的浏览器访问闸门（只放行带令牌的请求，插件自拉进程的裸 HTTP 全 403）
const BRIDGE = params.get('bridge') === '1';
// 视口 = 全部显示器工作区的外接矩形（多显示器时即整个桌面；窗口只是宠物的一块局部画布）。
// 它只是**坐标系原点与比例换算基准**：位置比例（customPos）、漫游 ratio 都按它算。
// x/y = 外接矩形左上角（多显示器时原点非 0）——visibleClampRect 计算「窗口 ∩ 工作区」需要它；
// 缺省 0（单显示器原点即 0）。注意：缺失会令夹取矩形变 NaN，菜单将飞到窗口左上角（#41 回归）。
//
// **边界判定一律不用它**，改用下面 AREAS 的并集：显示器摆放不规则时外接矩形里有大片空洞
// （实测右倒 T 型双屏 23.7% 的面积不属于任何屏），拿它当边界会让宠物走进/飞进不可见区域。
// 字段可变：显示器分辨率/缩放变化、插拔屏、旋转时由 applyDeskGeometry 就地重挂（#P4）。
// 主进程下发的视口（**物理像素**，原样保留给首帧 applyDeskGeometry）；VIEW 才是 ÷scale 后的 CSS 系
const VIEW_SCREEN = {
  x: Number(params.get('workAreaX') || 0),
  y: Number(params.get('workAreaY') || 0),
  w: Number(params.get('workAreaW') || (window.screen && window.screen.availWidth) || 1920),
  h: Number(params.get('workAreaH') || (window.screen && window.screen.availHeight) || 1080),
};
const VIEW = {
  x: toLocal(VIEW_SCREEN.x),
  y: toLocal(VIEW_SCREEN.y),
  w: toLocal(VIEW_SCREEN.w),
  h: toLocal(VIEW_SCREEN.h),
};
/** 逐显示器工作区，**视口相对坐标**（= 屏幕坐标 − VIEW 原点）。抛掷/漫游/菜单夹取都走它们的并集 */
let AREAS = [];
/** 主屏工作区（视口相对坐标）：角落定位与「回到初始位置」用它——外接矩形的角落可能落在空洞里 */
let PRIMARY_AREA = null;

/** 把主进程给的桌面几何（{hull, areas, primaryIndex}，屏幕坐标）挂到 VIEW / AREAS / PRIMARY_AREA */
function applyDeskGeometry(geo) {
  const hull = geo && geo.hull;
  const list = geo && Array.isArray(geo.areas) ? geo.areas.filter((a) => a && a.width > 0 && a.height > 0) : [];
  if (!hull || !(hull.width > 0) || !(hull.height > 0) || list.length === 0) return false;
  // 主进程几何是物理像素：hull/areas 逐个 ÷scale 进 CSS 系（§3.5 收口约定——几何导入唯一入口）
  VIEW.x = toLocal(hull.x);
  VIEW.y = toLocal(hull.y);
  VIEW.w = toLocal(hull.width);
  VIEW.h = toLocal(hull.height);
  AREAS = S.translateRects(
    list.map((a) => ({ x: toLocal(a.x), y: toLocal(a.y), width: toLocal(a.width), height: toLocal(a.height) })),
    -VIEW.x,
    -VIEW.y,
  );
  const pi = Number(geo.primaryIndex);
  PRIMARY_AREA = AREAS[Number.isInteger(pi) && pi >= 0 && pi < AREAS.length ? pi : 0];
  return true;
}

// 首帧几何走 URL query（position() 定角落时就要用）；运行期变化再经 pet:displays 推送。
// areas 缺失（手动 start-desktop / 老版本主进程）时退化为「整个视口就是一块屏」= 旧行为。
applyDeskGeometry({
  hull: { x: VIEW_SCREEN.x, y: VIEW_SCREEN.y, width: VIEW_SCREEN.w, height: VIEW_SCREEN.h },
  areas: (() => {
    try {
      const parsed = JSON.parse(params.get('areas') || '[]');
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* 落到下面的单矩形兜底 */
    }
    return [{ x: VIEW_SCREEN.x, y: VIEW_SCREEN.y, width: VIEW_SCREEN.w, height: VIEW_SCREEN.h }];
  })(),
  primaryIndex: Number(params.get('primaryIndex') || 0),
});
const ORIGIN = new URL(CONFIG.configUrl).origin;
/** 宿主 /dsh-pet-7340 前缀：bridge 走自定义 scheme（主进程转发），否则 HTTP 直连宿主 */
const BASE = BRIDGE ? 'dsh-pet-bridge://dsh-pet/dsh-pet-7340' : ORIGIN + '/dsh-pet-7340';
const BALANCE_URL = BASE + '/balance';
const TRIGGER_URL = BASE + '/balance/trigger';
const WHISPER_URL = BASE + '/whisper';
const WORK_STATUS_URL = BASE + '/work-status'; // 工作状态联动：1s 轮询，ts 变化才触发（与浏览器同一端点）
const BUBBLE_DURATION_MS = 10 * 1000; // 余额/碎碎念气泡展示时长（与浏览器一致：定时自动消失，与动画解耦）
// 窗口四周外扩 = 该比例 × 宠物尺寸：为气泡 / 未来可能的弹窗预留显示空间；
// 外扩区透明且点击穿透（只有身体命中区可交互）。单点可调——按实际观感改这里。
const WINDOW_MARGIN_RATIO = 0.5;

// ---------- 全局状态 ----------
const rootEl = document.getElementById('root');
const errorEl = document.getElementById('pet-error');
let config = null; // { pets: 拍平后的成品实例列表, refreshSec: 主条目周期 }（loadConfig 填充）
let sprites = []; // PetSprite[]（本窗口只装一只宠物）
let balance = null; // BalanceState（本窗口单宠共用）
let balanceTick = 0;
let workTick = 0; // 工作状态联动 tick：容器 1s 轮询 /work-status，ts 变化才递增（各启用宠物以此触发）
let bootTimer = null;
let loopsStarted = false;

// ---------- 调试钩子（冒烟自检/排障用；真实运行也可排查错误/配置/气泡） ----------
window.__dshPetDebug = {
  errors: [],
  configOk: false,
  spriteCount: 0,
  lastBubbleTitle: '',
  lastBalanceOk: null,
  menuOpen: false,
  chatOpen: false,
  bootAt: Date.now(),
};
window.addEventListener('error', (event) => {
  window.__dshPetDebug.errors.push(String(event.message || event.error));
});
