/**
 * dsh-pet 桌面 Helper 的基础设施：启动参数、桌面几何、全局状态与调试钩子。
 *
 * 经典 script：经 index.html 顺序加载、先于 sprite.js / events.js / renderer.js，顶层声明进全局词法环境。
 * 不负责行为与渲染。依赖 shared-core.js 的 window.PetShared 与主进程注入的 query 参数。
 * @module dsh-pet/runtime/electron-helper/constants
 */
'use strict';

const S = window.PetShared;

const params = new URLSearchParams(location.search);
const CONFIG = {
  configUrl: params.get('configUrl') || 'http://127.0.0.1:3080/dsh-pet-7340/config',
  scale: Number(params.get('scale') || '1'),
  petIndex: Number(params.get('petIndex') || '0'),
  topInsetRatio: Number(params.get('topInsetRatio') || '0'),
};

// 坐标系约定：主进程对窗口 setZoomFactor(CONFIG.scale) 后，DOM 度量、事件坐标、桌面几何与全部
// shared 组件同在 CSS 像素里；与主进程交换的物理像素只在 toScreen/toLocal 两处换算，
// 其它地方一律不得乘除（几何导入的唯一入口是 applyDeskGeometry）。
function toScreen(v) {
  return v * CONFIG.scale;
}
function toLocal(v) {
  return v / CONFIG.scale;
}
// bridge 模式（DSH_PET_BRIDGE=1）：请求走自定义 scheme 经主进程转宿主管道，绕开 DSH 桌面应用的
// 浏览器访问闸门（它只放行带令牌的请求，插件自拉进程的裸 HTTP 一律 403）。
const BRIDGE = params.get('bridge') === '1';
// 菜单首项去向（主进程按宿主形态注入）：desktop 唤起桌面应用，standalone 打开本机 AI 设置页，web 打开站点。
const OPEN_TARGET_RAW = params.get('openTarget');
const OPEN_TARGET = OPEN_TARGET_RAW === 'desktop' || OPEN_TARGET_RAW === 'standalone' ? OPEN_TARGET_RAW : 'web';
// 视口 = 全部显示器工作区的外接矩形，只是坐标系原点与比例换算基准；边界判定一律走 AREAS 的并集
// （不规则布局下外接矩形含大片不属于任何屏的空洞）。主进程下发的是物理像素，VIEW 是 ÷scale 后的 CSS 系。
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
/** 逐显示器工作区，视口相对坐标（= 屏幕坐标 − VIEW 原点）：抛掷/漫游/菜单夹取走它们的并集 */
let AREAS = [];
/** 菜单/聊天框/提示仍限制在工作区，不能随宠物进入菜单栏或 Dock。 */
let WORK_AREAS = [];
/** 逐显示器完整面板（含任务栏区，与 AREAS 同序）：抛掷时探测越界侧有没有邻屏——
 *  任务栏在接缝处挖出的工作区条带不当墙（见 shared/physics.ts） */
let PANELS = [];
/** 主屏工作区（视口相对坐标）：角落定位与「回到初始位置」用它——外接矩形的角落可能落在空洞里 */
let PRIMARY_AREA = null;

/** 把主进程下发的桌面几何（{hull, areas, panels, primaryIndex}，屏幕坐标）挂到 VIEW / AREAS / PANELS。 */
function applyDeskGeometry(geo) {
  const hull = geo && geo.hull;
  const list = geo && Array.isArray(geo.areas) ? geo.areas.filter((a) => a && a.width > 0 && a.height > 0) : [];
  if (!hull || !(hull.width > 0) || !(hull.height > 0) || list.length === 0) return false;
  // 主进程几何是物理像素：逐个 ÷scale 进 CSS 系（几何导入的唯一收口）
  VIEW.x = toLocal(hull.x);
  VIEW.y = toLocal(hull.y);
  VIEW.w = toLocal(hull.width);
  VIEW.h = toLocal(hull.height);
  AREAS = S.translateRects(
    list.map((a) => ({ x: toLocal(a.x), y: toLocal(a.y), width: toLocal(a.width), height: toLocal(a.height) })),
    -VIEW.x,
    -VIEW.y,
  );
  const workAreas = geo && Array.isArray(geo.workAreas) && geo.workAreas.length === list.length ? geo.workAreas : list;
  WORK_AREAS = S.translateRects(
    workAreas.map((a) => ({ x: toLocal(a.x), y: toLocal(a.y), width: toLocal(a.width), height: toLocal(a.height) })),
    -VIEW.x,
    -VIEW.y,
  );
  CONFIG.topInsetRatio = Number(geo.topInsetRatio) || 0;
  // 面板与工作区同序；缺失或长度不符（老主进程）退化为工作区，保持原行为
  const panelsList =
    geo && Array.isArray(geo.panels) && geo.panels.length === list.length
      ? geo.panels.filter((p) => p && p.width > 0 && p.height > 0)
      : null;
  PANELS = S.translateRects(
    (panelsList || list).map((a) => ({
      x: toLocal(a.x),
      y: toLocal(a.y),
      width: toLocal(a.width),
      height: toLocal(a.height),
    })),
    -VIEW.x,
    -VIEW.y,
  );
  const pi = Number(geo.primaryIndex);
  PRIMARY_AREA = AREAS[Number.isInteger(pi) && pi >= 0 && pi < AREAS.length ? pi : 0];
  return true;
}

// 首帧几何走 URL query（position() 定角落时就要用），运行期变化再经 pet:displays 推送。
// areas/panels 缺失（手动 start-desktop / 老主进程）时退化为「整个视口就是一块屏」。
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
  panels: (() => {
    try {
      const parsed = JSON.parse(params.get('panels') || '[]');
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* 落到下面的面板兜底（= 工作区） */
    }
    return null;
  })(),
  primaryIndex: Number(params.get('primaryIndex') || 0),
  workAreas: (() => {
    try {
      return JSON.parse(params.get('workAreas') || 'null');
    } catch {
      return null;
    }
  })(),
  topInsetRatio: CONFIG.topInsetRatio,
});
const ORIGIN = new URL(CONFIG.configUrl).origin;
/** 宿主 /dsh-pet-7340 前缀：bridge 走自定义 scheme（主进程转发），否则 HTTP 直连宿主 */
const BASE = BRIDGE ? 'dsh-pet-bridge://dsh-pet/dsh-pet-7340' : ORIGIN + '/dsh-pet-7340';
const STATE_URL = BASE + '/state'; // 轮询统一状态 S：前端 1s 轮询的唯一数据源（余额/工作状态/通知/说话）
const BALANCE_URL = BASE + '/balance'; // 余额刷新动作（POST，写 S；数据本身从 /state 读）
const FOCUS_SESSION_URL = BASE + '/focus-session'; // 跳会话动作（POST，写 sections.focusSession；页面据此切过去）
const WHISPER_URL = BASE + '/whisper';
// 实况上报（渲染端 → 宿主，内部通道）：第三方用 GET /pose 读宿主存下的这份快照
const POSE_REPORT_URL = BASE + '/pose/report';
// 实况上报的节流间隔（ms）。sendBounds 在走位/抛掷时逐帧调用，必须合并；且必须带 trailing edge
// （到点读当前值推一次），否则第三方读到的永远是走位中途的位置，且没有任何报错。
const POSE_THROTTLE_MS = 400;
const BUBBLE_DURATION_MS = 10 * 1000; // 余额/碎碎念气泡展示时长（与浏览器一致：定时消失，与动画解耦）
// 余额气泡换内容前的等待（ms）：与 .pet-bubble 的 opacity 过渡同为 .25s，淡出走完再换，
// 否则内容会在半透明时被替换 = 看得见的硬切（与浏览器 bubble.ts 同值）
const BALANCE_FADE_MS = 250;
// /state 长轮询的挂起时长（与浏览器端同值）：宿主在版本没变时最多挂这么久，叶子一变立刻返回。
const STATE_WAIT_MS = 1000;
// 窗口四周外扩 = 该比例 × 宠物尺寸：为气泡与可能的弹窗预留显示空间，外扩区透明且点击穿透。
const WINDOW_MARGIN_RATIO = 0.5;

const rootEl = document.getElementById('root');
const errorEl = document.getElementById('pet-error');
let config = null; // { pets: 拍平后的成品实例列表, physics, confineToScreen, clickSoundEnabled }（loadConfig 填充）
let sprites = []; // PetSprite[]（本窗口只装一只宠物）
let balance = null; // BalanceState（本窗口单宠共用）
let balanceTick = 0;
let balanceNoticeKey = null; // 上次已提示的不可用原因（reason:provider）：只在原因变化时再弹（判定在 shared）
let workTick = 0; // 工作状态联动 tick：/state 的 sections.workStatus counter 变化才递增
let bootTimer = null;
let loopsStarted = false;

// 调试钩子：冒烟自检与排障用（错误/配置/气泡/菜单状态）
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
