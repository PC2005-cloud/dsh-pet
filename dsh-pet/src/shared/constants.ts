// 画布 / 几何常量：与 640×360 播放变体强耦合，属于运行时几何，不作为配置。
// 浏览器 overlay 与桌面模式共用同一组（src/shared = shared-core 单一来源）。
/** thumb 画布高度 */
export const CANVAS_H = 360;
/** thumb 画布上「脚底」的 y 坐标（人物站在 y=330 线上） */
export const FEET_Y = 330;
/** 点击/拖拽命中矩形（thumb 640×360 像素坐标） */
export const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
/** 拖拽判定阈值（px） */
export const DRAG_THRESHOLD = 5;
/** 移动距离缩放基准（px）：config.jsonc 的 moves.minDist/maxDist 是「基准宠物宽 462px」下的绝对像素，
 *  运行时乘以 实际size/基准 等比缩放 —— 任何缩放下，行进距离与人物自身大小成比例（小宠物挪小步、大宠物挪大步） */
export const PET_REF_WIDTH = 462;

/** 播放动画扩展名（集中开关，浏览器与桌面共用同一常量）：
 *  - 默认 '.webm'（VP9-alpha，发布格式）：Chrome/Edge/Firefox 与桌面模式（Electron=Chromium）直接透明播放；
 *  - macOS 的 Safari/WKWebView 不认 webm alpha（渲染黑底），需改为 '.mov'（HEVC-with-Alpha）——
 *    素材从仓库 GitHub Release（固定 tag assets-mov）下载放入 main-animation/mov/，
 *    并把本常量改为 '.mov' 后重新构建（自构建用户改这里；npm 包用户改产物 lib/client.js 中同名常量）。 */
export const ANIMATION_EXT = '.webm';

/** 左键点身体「顺带」触发余额查询的最小间隔（ms），浏览器与桌面共用同一值。
 *  为什么需要节流：点击身体是**高频**动作（每次点击都会弹积分/播点击动画），而每次触发都会让宿主
 *  真正打一次余额接口（有外部 API 成本）；3 秒内的重复点击只触发第一次。
 *  右键菜单「查看余额」与 /balance 命令**不受**此限——那是用户明确要的，点一次就该有一次答复。 */
export const BODY_CLICK_BALANCE_THROTTLE_MS = 3000;
