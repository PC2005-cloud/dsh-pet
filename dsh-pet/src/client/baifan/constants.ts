/**
 * 「吃白饭」的常量：节奏参数、台词池与覆盖层样式。
 *
 * 台词与节奏是玩法的一部分，不开放给配置；用哪 5 段动画由 animations.baifan 决定，
 * 地址在 ./assets 里按「素材根 + 动画名」拼，与本插件其他动画同一条路。
 * @module dsh-pet/src/client/baifan/constants
 */

/** 接口基址（与页面同源）。 */
export const ROUTE = '/dsh-pet-7340';

/** 菜单 owner：与原扩展同名，装过老扩展的用户升级后不会多出一份重复项。 */
export const OWNER = 'dsh-pet-baifan';

/** 菜单项文案；宿主按文案回传点击，属于协议的一部分。 */
export const LABEL = '吃白饭';

/** 玩法 id：对应配置里的 animations.<id>。 */
export const ACTIVITY = 'baifan';

/** 玩法自带的图片素材（包内 assets/pic/baifan）：米饭与空碗，不是动画名，不随配置变。 */
export const PIC = {
  bowlFull: ROUTE + '/pic/baifan/bowl-full.png',
  bowlEmpty: ROUTE + '/pic/baifan/bowl-empty.png',
  riceBall: ROUTE + '/pic/baifan/rice-ball.png',
} as const;

/**
 * 全部可调节奏。
 *
 * 坐标一律用**视口像素**算，只在调接口时归一化成 0–1——pose() 回的是归一化中心点，
 * 而米饭、气泡要按像素画在页面上，两边来回换算一次就够。
 * 注意这里没有「素材多长」：动画结束一律问 GET /playback/{id} 的回执，不吃定时器。
 */
export const CFG = {
  groundOffset: 26,
  prepMs: 2100,
  travelMs: 5000,
  runSpeed: 290,
  patrolSpeedRatio: 0.72,
  spawnMs: 4200,
  bowlRatio: 0.38,
  maxRice: 2,
  eatPx: 40,
  arrivePx: 12,
  tripMaxMs: 4500,
  sideWatchMs: 400,
  idleMs: 140,
  animLeadMs: 300,
  backTurnPenalty: 1.8,
  pollLatencyMs: 1000,
  preRollSec: 0.35,
  lockTtl: 30000,
  lockWaitMs: 25000,
  renewMs: 6000,
  flyFallbackMs: 5200,
  waitBudgetMs: 30000,
  httpTimeoutMs: 20000,
  bubbleMs: 2400,
  footRatio: 0.894,
  mouthRatio: 0.63,
  mouthDx: -0.03,
  refWidth: 498,
} as const;

/** 台词池：只在合适的节拍上说一句，其余时间闭嘴，否则气泡会糊在演出上。 */
export const LINES = {
  start: ['开饭了——', '白饭时间到！', '饿了饿了饿了'],
  down: ['等我下去……', '下面有饭香', '让一让，我下去了'],
  expect: ['饭呢？饭呢？', '快点快点', '……还没好吗'],
  drop: ['掉下来了！', '接住！', '来了来了'],
  bowl: ['碗饭最香', '这个碗我要了', '再来一碗'],
  ball: ['饭团饭团', '一口一个', '捏得刚好'],
  full: ['嗝——还能吃！', '这点不够塞牙缝', '再来十份'],
} as const;

/** 样式表去重标记（与 dsh-pet 的 data-plugin-css 约定一致）。 */
export const STYLE_TAG = 'dsh-pet-baifan/baifan.css';

/** 覆盖层根节点 id，重复挂载时按它摘掉旧的。 */
export const ROOT_ID = 'dsh-pet-baifan-root';

/** 覆盖层压在桌宠之上（桌宠 `.dsh-pet-root` 是 z-index:40）；只保证这一层关系。 */
const Z_INDEX = 50;

/** 覆盖层与米饭、分数的样式。 */
export const CSS = [
  // 覆盖层由 shell.overlay 槽承载（AppFrame 的 [data-shell-overlay]，z-index:20），不是 body
  // 直接子级：宿主给 macOS 写的 body > :not(#root){no-drag} 命中不到它，所以这里不声明
  // -webkit-app-region——那条声明会在 Windows 上生成一块铺满全窗的 no-drag 排除区，
  // 把标题栏拖拽带整条挖掉（#323 / #324）。
  '#dsh-pet-baifan-root{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:' + Z_INDEX + '}',
  '.bf-rice{position:absolute;transform-origin:50% 100%;will-change:transform,opacity;',
  'user-select:none;-webkit-user-drag:none;pointer-events:none}',
  '.bf-score{position:absolute;display:flex;align-items:center;gap:6px;',
  'padding:5px 13px 5px 7px;border-radius:999px;white-space:nowrap;',
  'background:linear-gradient(180deg,#fff 0%,#e9f1fa 100%);',
  'border:1px solid rgba(23,64,107,.16);',
  'box-shadow:0 8px 22px rgba(23,64,107,.2),inset 0 1px 0 #fff;',
  'pointer-events:none;transform-origin:50% 100%}',
  '.bf-score img{width:26px;height:26px;object-fit:contain;display:block}',
  '.bf-score img.bowl{width:32px;height:22px}',
  '.bf-score .num{font-size:22px;font-weight:800;color:#17406b;line-height:1}',
  '.bf-score .plus{position:absolute;right:-6px;top:-10px;font-size:13px;font-weight:800;',
  'color:#e8825a;text-shadow:0 1px 0 #fff}',
  '.bf-toast{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);',
  'padding:8px 16px;border-radius:999px;font:13px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
  'background:rgba(34,52,74,.88);color:#fff;opacity:0;transition:opacity .25s ease;pointer-events:none}',
  '.bf-toast.show{opacity:1}',
].join('');
