/**
 * 桌面 Helper 的门禁配置：只查 no-undef。
 *
 * 这批是经典脚本（非 ESM、非 TS），没有 tsc 也没有类型可依；它们靠 index.html 的加载顺序
 * 共享顶层全局（constants.js 提供配置与常量，sprite.js 提供 PetSprite，events.js 提供循环）。
 * 因此这里把**契约里真实存在的**共享全局显式声明，其余一律报错——三次「宠物不可见」事故
 * 都是拆分后某个名字不再有任何定义，只有 no-undef 能在启动前发现。
 *
 * 新增共享全局时同时加到下面的 globals 里；不要用 `/* global *\/` 一类的兜底，那等于关掉门禁。
 * @module dsh-pet/eslint.runtime.config
 */
import { defineConfig } from 'eslint/config';

/** 宿主与 Node 全局（主进程侧）。 */
const nodeGlobals = {
  require: 'readonly',
  process: 'readonly',
  module: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  setImmediate: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

/** 浏览器全局（渲染端与 preload）。 */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  Audio: 'readonly',
  // 语音输入：shared/hear 在渲染端开 16kHz 采集上下文（经 shared-core.js 进 bundle）
  AudioContext: 'readonly',
  Image: 'readonly',
  getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  MutationObserver: 'readonly',
  ResizeObserver: 'readonly',
  Blob: 'readonly',
  FileReader: 'readonly',
  btoa: 'readonly',
  CustomEvent: 'readonly',
  performance: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
};

/**
 * 脚本之间共享的顶层全局：定义在 constants.js（配置与常量）、sprite.js（类与提示）、
 * events.js（轮询循环）。定义处见各文件；这里只登记名字，不重复它们的值。
 */
const scriptGlobals = {
  // constants.js
  S: 'readonly',
  CONFIG: 'readonly',
  config: 'writable',
  toScreen: 'readonly',
  toLocal: 'readonly',
  OPEN_TARGET: 'readonly',
  VIEW: 'readonly',
  AREAS: 'readonly',
  WORK_AREAS: 'readonly',
  PANELS: 'readonly',
  PRIMARY_AREA: 'readonly',
  applyDeskGeometry: 'readonly',
  BASE: 'readonly',
  ORIGIN: 'readonly',
  STATE_URL: 'readonly',
  BALANCE_URL: 'readonly',
  WHISPER_URL: 'readonly',
  POSE_REPORT_URL: 'readonly',
  POSE_THROTTLE_MS: 'readonly',
  BUBBLE_DURATION_MS: 'readonly',
  BALANCE_FADE_MS: 'readonly',
  STATE_WAIT_MS: 'readonly',
  WINDOW_MARGIN_RATIO: 'readonly',
  rootEl: 'readonly',
  errorEl: 'readonly',
  sprites: 'writable',
  balance: 'writable',
  balanceTick: 'writable',
  balanceNoticeKey: 'writable',
  workTick: 'writable',
  bootTimer: 'writable',
  loopsStarted: 'writable',
  // sprite.js
  PetSprite: 'readonly',
  OPEN_SHORTCUT_HINT: 'readonly',
  isOpenShortcut: 'readonly',
  playClickSound: 'readonly',
  // events.js
  startLoops: 'readonly',
};

export default defineConfig([
  {
    files: ['runtime/electron-helper/**/*.js'],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals, ...scriptGlobals } },
    rules: { 'no-undef': 'error' },
  },
]);
