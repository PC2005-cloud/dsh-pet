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
// bridge 模式（DSH_PET_BRIDGE=1）：请求走自定义 scheme，经 Electron 主进程转宿主管道——
// 绕开 DSH Desktop 2.0.3+ 的浏览器访问闸门（只放行带令牌的请求，插件自拉进程的裸 HTTP 全 403）
const BRIDGE = params.get('bridge') === '1';
// 视口 = 全部显示器工作区的外接矩形（多显示器时即整个桌面；窗口只是宠物的一块局部画布）：
// 漫游边界/角落定位/抛掷反弹/位置比例换算都用它——宠物可以跨屏漫游、被甩到其它显示器（#43）；
// 单显示器时它即主屏工作区，行为与以前完全一致。
// x/y = 外接矩形左上角（多显示器时原点非 0）——visibleClampRect 计算「窗口 ∩ 工作区」需要它；
// 缺省 0（单显示器原点即 0）。注意：缺失会令夹取矩形变 NaN，菜单将飞到窗口左上角（#41 回归）。
const VIEW = {
  x: Number(params.get('workAreaX') || 0),
  y: Number(params.get('workAreaY') || 0),
  w: Number(params.get('workAreaW') || (window.screen && window.screen.availWidth) || 1920),
  h: Number(params.get('workAreaH') || (window.screen && window.screen.availHeight) || 1080),
};
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
