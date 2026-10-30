/**
 * 共享常量叶子：画布几何、播放扩展名与插件 HTTP 挂载路径。
 * 路径对两端语义不同——宿主只认服务端路由段，浏览器才带挂载前缀，因此拆成两个导出。
 * 不 import 任何模块：宿主半侧直接引本文件，不经 shared/index 桶（桶里有 DOM 挂载代码）。
 * @module dsh-pet/src/shared/constants
 */
/** thumb 画布高度。 */
export const CANVAS_H = 360;
/** thumb 画布上脚底的 y 坐标（人物站在 y=330 线上）。 */
export const FEET_Y = 330;
/** 点击与拖拽的命中矩形（thumb 640×360 像素坐标）。 */
export const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
/** 拖拽判定阈值（px）。 */
export const DRAG_THRESHOLD = 5;
/** 弹弓窗口（ms）：两次按下之间的间隔小于它即按弹弓算，与这次拖了多久、何时松手无关。
 *  只认左键，没有待拉状态（换算见 physics.ts）。 */
export const SLINGSHOT_DOUBLE_MS = 200;
/** 移动距离的缩放基准（px）：配置里的 minDist/maxDist 是基准宠物宽 462px 下的像素，
 *  运行时按「实际 size / 基准」等比缩放，任何缩放下行进距离都与人物自身大小成比例。 */
export const PET_REF_WIDTH = 462;

/**
 * 宿主注册的路由段：服务端路径，永远不带浏览器挂载前缀。
 * 路由注册、匹配与桌面/独立模式拼地址都用它；带了前缀的地址在服务端是错的路由。
 */
export const ROUTE_SEGMENT = '/dsh-pet-7340';

/**
 * 从文档基准地址取出挂载前缀（baseURI 的目录部分）。
 *
 * dsh 返回 index 时注入 `<base href="./">`，baseURI 因此正是「宿主提供 UI 的那个目录」，
 * 也是浏览器解析相对请求的基准；反代/应用网关把 UI 挂在子路径下时，缺的就是这一段前缀。
 *
 * @param baseURI - 文档基准地址；宿主进程、桌面本地页与 Node 测试都没有它。
 * @returns 去掉尾部斜杠的目录部分；空串、非 http(s)、非法地址一律 `''`，且不抛异常。
 */
export function mountPrefixOf(baseURI: string | undefined): string {
  if (baseURI === undefined || baseURI === '') return '';
  try {
    const url = new URL(baseURI);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * 一处算出浏览器侧地址：挂载前缀 + 路由段，供模块加载与单测共用。
 *
 * @param baseURI - 文档基准地址；缺省时按无前缀处理。
 * @returns 请求与素材的公共前缀，形如 `/app/x/dsh-pet-7340`。
 */
export function routePathOf(baseURI: string | undefined): string {
  return mountPrefixOf(baseURI) + ROUTE_SEGMENT;
}

/**
 * 浏览器侧地址：请求、素材与 CSS url() 都按文档基准解析，必须带挂载前缀。
 * 无 `document` 的三处（宿主、桌面 Helper 的主进程侧、独立模式）取到的是纯路由段。
 */
export const ROUTE_PATH = routePathOf(typeof document === 'undefined' ? undefined : document.baseURI);

/** 播放动画扩展名（集中开关）：默认 .webm（VP9-alpha）两端可直接透明播放；
 *  macOS 的 Safari/WKWebView 不认 webm alpha（渲染黑底），需改为 .mov（HEVC-with-Alpha）——
 *  素材从仓库 Release 的 assets-mov tag 取，放进 main-animation/mov/ 后重新构建；
 *  npm 包用户改产物里的同名常量。 */
export const ANIMATION_EXT = '.webm';
