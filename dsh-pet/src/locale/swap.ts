/**
 * 固定文案的整句替换表：中文整句对俄文整句。
 * 设置页脚本按这张表改文本节点；用户自己写进输入框的内容不在这里。
 */
import { chromeRu, chromeZh, type ChromeKey } from './chrome.ts';

/** 中文整句 → 俄文，以及反向。同一句中文只保留一条俄文。 */
export function chromeSwapTables(): { toRu: Record<string, string>; toZh: Record<string, string> } {
  const toRu: Record<string, string> = {};
  const toZh: Record<string, string> = {};
  for (const key of Object.keys(chromeZh) as ChromeKey[]) {
    const from = chromeZh[key];
    const to = chromeRu[key];
    if (from === to) continue;
    const previous = toRu[from];
    if (previous !== undefined && previous !== to) continue;
    toRu[from] = to;
    if (toZh[to] === undefined) toZh[to] = from;
  }
  return { toRu, toZh };
}

/**
 * 设置页脚本里的替换函数。
 * 插在公共层之后：那时 `callApi` 已经声明。页面读 `/state`，标签再次可见时再读一次。
 */
export function chromeApplySource(): string {
  const { toRu, toZh } = chromeSwapTables();
  return `
const CHROME_TO_RU = ${JSON.stringify(toRu)};
const CHROME_TO_ZH = ${JSON.stringify(toZh)};
function chromeSwapText(text, id) {
  if (typeof text !== 'string' || text === '') return text;
  if (id === 'ru') return Object.prototype.hasOwnProperty.call(CHROME_TO_RU, text) ? CHROME_TO_RU[text] : text;
  return Object.prototype.hasOwnProperty.call(CHROME_TO_ZH, text) ? CHROME_TO_ZH[text] : text;
}
function applyChrome(id) {
  const root = document.body;
  if (!root) return;
  if (document.documentElement) document.documentElement.lang = id === 'ru' ? 'ru' : 'zh-CN';
  const attrs = ['placeholder', 'aria-label', 'title', 'data-title'];
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      const next = chromeSwapText(node.nodeValue, id);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    const tag = node.tagName;
    if (typeof node.getAttribute === 'function') {
      for (const attr of attrs) {
        const value = node.getAttribute(attr);
        if (typeof value !== 'string') continue;
        const next = chromeSwapText(value, id);
        if (next !== value) node.setAttribute(attr, next);
      }
    }
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INPUT' || tag === 'TEXTAREA') return;
    const kids = node.childNodes || node.children || [];
    for (let i = 0; i < kids.length; i += 1) walk(kids[i]);
    if (kids.length === 0 && typeof node.textContent === 'string') {
      const next = chromeSwapText(node.textContent, id);
      if (next !== node.textContent) node.textContent = next;
    }
  };
  walk(root);
}
async function refreshHostLocale() {
  try {
    const snap = await callApi('GET', '/state');
    const data = snap && snap.sections && snap.sections.locale && snap.sections.locale.data;
    const raw = data && typeof data.id === 'string' ? data.id.trim() : '';
    applyChrome(raw);
  } catch (e) {
    applyChrome('');
  }
}
`;
}
