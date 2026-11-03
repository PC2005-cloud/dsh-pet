/**
 * 设置页脚本的公共层：令牌、请求封装、共享状态与 DOM 工具。
 *
 * 作为整页脚本的第一个片段被拼进同一个 IIFE，后续片段只调用这里导出的名字。
 * 令牌只放内存并随请求头送出，地址栏里的那一份读完即清；刷新后内存里没有令牌时，
 * 由首次访问换来的 HttpOnly cookie 继续认证，所以请求一律按同源凭据发出。
 * 片段里不许出现第二份枚举清单，取值一律由调用方注入。
 * @module dsh-pet/src/standalone/settings-page/script/core
 */

/** 脚本片段需要的枚举与默认值，全部由装配入口从源码常量注入。 */
export interface ScriptConsts {
  /** 音色白名单（来自 host/voice/voices.ts）。 */
  readonly voices: readonly { readonly id: string; readonly name: string; readonly tag: string }[];
  /** 字体预设 id（来自 shared/fonts.ts）。 */
  readonly fonts: readonly string[];
  /** 显示档（来自 shared/config.ts）。 */
  readonly displays: readonly string[];
  /** 停靠角落（来自 host/config/constants.ts）。 */
  readonly corners: readonly string[];
  /** 物理默认值（来自 shared/physics）。 */
  readonly physics: unknown;
  /** 字体默认值（来自 shared/fonts.ts）。 */
  readonly font: unknown;
  /** 动作频率默认值（来自 shared/weights.ts）。 */
  readonly weights: unknown;
}

/**
 * 生成公共层片段。
 *
 * @param routePath - 插件 HTTP 前缀，取自 shared/constants 的 ROUTE_SEGMENT。
 * @param consts - 枚举与默认值。
 * @returns 可直接拼进整页脚本的源码。
 */
export function coreScript(routePath: string, consts: ScriptConsts): string {
  return `
const TOKEN = new URLSearchParams(location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', location.pathname);
const API = ${JSON.stringify(routePath)};
const VOICES = ${JSON.stringify(consts.voices)};
const FONT_IDS = ${JSON.stringify(consts.fonts)};
const DISPLAYS = ${JSON.stringify(consts.displays)};
const CORNERS = ${JSON.stringify(consts.corners)};
const FALLBACK_PHYSICS = ${JSON.stringify(consts.physics)};
const FALLBACK_FONT = ${JSON.stringify(consts.font)};
const FALLBACK_WEIGHTS = ${JSON.stringify(consts.weights)};
const FALLBACK_INTERVAL_SEC = 300;
const state = { config: null, meta: null, globals: null, pets: {}, prompts: {}, entry: 'main', petIndex: 0, dirty: false };

function byId(id) {
  return document.getElementById(id);
}

function make(tag, props, kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'value') node.value = value;
      else if (key === 'checked' || key === 'disabled' || key === 'hidden') node[key] = value === true;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, String(value));
    }
  }
  if (kids) {
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
  }
  return node;
}

function setStatus(node, text, kind) {
  if (!node) return;
  node.textContent = text;
  node.dataset.error = kind === 'error' ? 'true' : 'false';
  node.dataset.ok = kind === 'ok' ? 'true' : 'false';
}

function markDirty(value) {
  state.dirty = value;
  const badge = byId('dirty');
  if (badge) badge.hidden = !value;
}

async function callApi(method, path, body) {
  const response = await fetch(API + path, {
    method: method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body
      ? { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' }
      : { 'X-DSH-Pet-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 403) throw new Error('打开凭据已失效，请从桌宠菜单重新打开设置。');
    if (response.status === 429) throw new Error('保存过于频繁，请稍等一分钟再试。');
    throw new Error((data && (data.message || data.error)) || '本机接口暂时无法处理请求');
  }
  return data;
}
`;
}
