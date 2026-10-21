/**
 * 「弹弓」小互动窗口的启动判定（纯函数，无 Electron 依赖，单测见 src/host/game-launch.test.ts）。
 *
 * 为什么是**一个独立的透明窗口（不置顶）**而不是复用宠物小窗：每只宠物只是一块局部小窗，
 * 放不下弹弓与木箱垛；整个场景（弹弓 / 木箱 / 宠物 / 特效）在一个渲染器里画完，命中判定逐帧精确，
 * 不用跨窗口同步。透明 + 无边框 + 除宠物身体外点击穿透，让它直接「长」在桌面上；**刻意不置顶**——Windows DWM
 * 视频黑屏要「透明置顶 + 非穿透 + 已聚焦 + 完整盖住视频窗」四项齐备（main.js 文件头 / issue #60），
 * 普通层级的窗口缺第一项，不会触发。
 *
 * 载荷来自宠物窗口（pet:open-game）：素材地址拼进游戏页 URL 之前必须过 sanitizeGameInit——
 * 只认宿主 /dsh-pet-7340 前缀（bridge 自定义 scheme 或本机 HTTP），其余一律拒收。
 */
'use strict';

/** 每个动画池最多带多少个名字 / 每个名字最长多少字符（防御异常载荷撑爆 URL） */
const MAX_ANIM_NAMES = 64;
const MAX_ANIM_NAME_LEN = 200;
/** 宠物名最长（窗口标题用） */
const MAX_PET_NAME_LEN = 40;
/** 桌宠大小（CSS 像素）的合法区间：之外按 0 处理（游戏页整窗缩放） */
const PET_SIZE_MIN = 40;
const PET_SIZE_MAX = 4000;
/** 宿主路由前缀（与 constants.js 的 BASE 一致） */
const ROUTE_PREFIX = '/dsh-pet-7340';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * 解析成 URL，只认宿主的两种来源：bridge scheme（dsh-pet-bridge://dsh-pet）或本机 HTTP（任意端口——
 * 独立模式的端口可配）。带用户名 / 密码 / 查询串 / 片段的一律拒收：它们不属于宿主前缀，
 * 且原始字符串里藏的任何字符都可能被下游原样拼进 URL / CSS。
 */
function parseHostUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol === 'dsh-pet-bridge:') return u.hostname === 'dsh-pet' ? u : null;
  return u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname) ? u : null;
}

/** 宿主前缀 → 规范形（协议 + 主机 + /dsh-pet-7340，无结尾斜杠）；不可信返回 null。输出由解析结果重建，不回传原串 */
function canonicalHostBase(value) {
  const u = parseHostUrl(value);
  if (!u || u.pathname.replace(/\/+$/, '') !== ROUTE_PREFIX) return null;
  return u.protocol + '//' + u.host + ROUTE_PREFIX;
}

/** 素材根 → 规范形：与 base 同协议同主机，路径（URL 解析已消掉 .. / %2e%2e）在 /dsh-pet-7340/thumb/<根>/ 之下 */
function canonicalAssetBase(value, base) {
  const u = parseHostUrl(value);
  if (!u) return null;
  const root = u.protocol + '//' + u.host;
  const prefix = ROUTE_PREFIX + '/thumb/';
  if (root + ROUTE_PREFIX !== base) return null;
  if (!u.pathname.startsWith(prefix) || u.pathname.length <= prefix.length || !u.pathname.endsWith('/')) return null;
  return root + u.pathname;
}

/** 动画名列表：只留非空且不过长的字符串，数量封顶；非数组 → [] */
function cleanNames(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((n) => typeof n === 'string' && n.length > 0 && n.length <= MAX_ANIM_NAME_LEN)
    .slice(0, MAX_ANIM_NAMES);
}

/** 桌宠大小：有限数值且在合法区间内，否则 0（= 未知，游戏页整窗缩放） */
function cleanPetSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= PET_SIZE_MIN && value <= PET_SIZE_MAX
    ? value
    : 0;
}

/** 单个动画名：非空且不过长的字符串，否则空串（= 不播） */
function cleanName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ANIM_NAME_LEN ? value : '';
}

/**
 * 校验 pet:open-game 载荷 → 游戏页初始化参数；不合法返回 null（调用方记日志、不开窗）。
 * 输出：{ petName, petSize, base, assetBase, idle, drag, cheer }（地址都是解析后重建的规范形）
 *   base      = 宿主前缀（字体 / 光标等通用素材）
 *   assetBase = 该宠物的动画素材根（必须在 base + '/thumb/' 之下）
 *   petSize   = 桌宠大小（CSS 像素；0 = 未知）
 *   idle/drag = 待机 / 被拽着（拉弓与飞行）的动画池
 *   cheer     = 整垛木箱都被推倒时的欢呼动画（空串 = 不播）
 */
function sanitizeGameInit(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const base = canonicalHostBase(payload.base);
  if (!base) return null;
  const assetBase = canonicalAssetBase(payload.assetBase, base);
  if (!assetBase) return null;
  const rawName = typeof payload.petName === 'string' ? payload.petName.trim() : '';
  return {
    petName: (rawName || '宠物').slice(0, MAX_PET_NAME_LEN),
    petSize: cleanPetSize(payload.petSize),
    base,
    assetBase,
    idle: cleanNames(payload.idle),
    drag: cleanNames(payload.drag),
    cheer: cleanName(payload.cheer),
  };
}

/**
 * 游戏窗口内容区 bounds（屏幕坐标，与 workArea 同一套像素）：**铺满整个工作区**。窗口是透明无边框的，
 * 场景直接画在桌面上：地面（GAME_GROUND_Y）贴窗口底 = 任务栏上沿，宠物落地的位置与桌宠一致；
 * 场景按桌宠大小缩放（不拉伸），宠物与木箱垛按屏宽的 1/6 定位，左右两堵墙就是屏幕边（见 sceneView）。
 */
function gameWindowBounds({ workArea }) {
  return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
}

/** 页面最多上报几块交互区域（宠物身体 + 右键菜单就够了） */
const MAX_INPUT_REGIONS = 8;

/**
 * 校验页面经 game:input 上报的交互状态：regions = 可交互矩形（页面 CSS 像素），busy = 正在拖拽 / 菜单开着。
 * 非法项丢弃、数量封顶；busy 只认 true。
 */
function sanitizeGameInput(payload) {
  const list = payload && Array.isArray(payload.regions) ? payload.regions : [];
  const regions = list
    .filter(
      (r) => r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v)) && r.w > 0 && r.h > 0,
    )
    .slice(0, MAX_INPUT_REGIONS)
    .map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
  return { regions, busy: !!payload && payload.busy === true };
}

/**
 * 弹弓窗口此刻该不该整窗点击穿透（主进程按真实光标位置轮询判定，不依赖 Electron 的 forward 鼠标钩子——
 * 那条链路在 Windows 上可能静默失效，见 main.js 的 #55 兜底）。
 * bounds = 窗口内容区（屏幕坐标），point = 光标（屏幕坐标），zoom = 页面缩放（CSS 像素 → 窗口像素）。
 * busy（拖拽中 / 菜单开着）时一律不穿透：否则拖到宠物外面就丢了 pointermove / pointerup。
 */
function gameIgnoresMouse({ bounds, point, zoom, regions, busy }) {
  if (busy) return false;
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const lx = (point.x - bounds.x) / z;
  const ly = (point.y - bounds.y) / z;
  return !regions.some((r) => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h);
}

module.exports = { MAX_ANIM_NAMES, sanitizeGameInit, gameWindowBounds, sanitizeGameInput, gameIgnoresMouse };
