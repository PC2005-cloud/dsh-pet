// i18n（首版：简体中文 zh-CN / 繁體中文 zh-TW）—— 浏览器与桌面共用同一份。
//
// 设计：界面源文案保持简体中文不动（不在业务代码里到处包 t()），选 zh-TW 时在**渲染层**把 DOM 文本即时换成
// 台湾繁体译文，选 zh-CN 时还原。这样新增文案不需要登记 key，缺译文也只会退回简体/兜底转换而不是空白。
//
// 转换三层（优先级从高到低）：
//   1. 整句译文表 ZH_TW_CATALOG：逐条人工在地化（台湾用语，非单纯简繁转换），整个文本节点命中即替换；
//   2. 片段替换：译文表里长度 ≥ 4 的条目 + 台湾用语词组表 ZH_TW_PHRASES，按长度从长到短，覆盖动态拼接出的文字；
//   3. 单字兜底 ZH_TW_CHARS：前两层都没命中的残余汉字逐字转繁体（例如大模型生成的碎碎念）。
//
// 语言持久化：宿主 GET/PUT <base>/lang（浏览器与桌面所有宠物窗口共享，约 3s 轮询同步），localStorage 兜底；
// 都没有时按 navigator.language 判定（zh-TW / zh-HK / zh-MO / zh-Hant → 繁体，其余 → 简体）。
import type { MenuBranch } from './menu';
import { ZH_TW_CATALOG } from './i18n-data/zh-tw-catalog';
import { ZH_TW_CHARS } from './i18n-data/zh-tw-chars';
import { ZH_TW_PHRASES } from './i18n-data/zh-tw-phrases';

export type PetLang = 'zh-CN' | 'zh-TW';
export const PET_LANGS: readonly PetLang[] = ['zh-CN', 'zh-TW'];

const STORE_KEY = 'dsh-pet-lang';
const POLL_MS = 3000;
const HAN = /[㐀-鿿]/;
/** 语言名称本身（菜单项）不参与转换：每种语言用它自己的写法显示 */
const LANG_LABELS = new Set(['简体中文', '繁體中文', '語言 / 语言']);
/** 不转换的元素：代码/命令、输入区域 */
const SKIP_SELECTOR = 'pre,code,textarea,[contenteditable="true"]';
const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'] as const;

const CHAR_MAP = new Map<string, string>();
for (let i = 0; i + 1 < ZH_TW_CHARS.length; i += 2) CHAR_MAP.set(ZH_TW_CHARS[i]!, ZH_TW_CHARS[i + 1]!);

/** 片段表：词组表 + 译文表里够长的条目（译文表优先） */
const FRAGMENTS = new Map<string, string>();
for (const [from, to] of ZH_TW_PHRASES) FRAGMENTS.set(from, to);
for (const [from, to] of Object.entries(ZH_TW_CATALOG)) {
  if (from.length >= 4 && from !== to) FRAGMENTS.set(from, to);
}
const FRAGMENT_RE = new RegExp(
  [...FRAGMENTS.keys()]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g',
);

/** 纯函数：把一段简体文案转成 zh-TW（lang 不是 zh-TW 时原样返回） */
export function convertText(lang: PetLang, text: string): string {
  if (lang !== 'zh-TW' || typeof text !== 'string' || !HAN.test(text)) return text;
  if (LANG_LABELS.has(text.replace(/^✓ /, ''))) return text;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const core = m?.[2] ?? '';
  if (core && Object.prototype.hasOwnProperty.call(ZH_TW_CATALOG, core)) {
    return (m?.[1] ?? '') + ZH_TW_CATALOG[core] + (m?.[3] ?? '');
  }
  const replaced = text.replace(FRAGMENT_RE, (frag) => FRAGMENTS.get(frag) ?? frag);
  return replaced.replace(/[㐀-鿿]/g, (c) => CHAR_MAP.get(c) ?? c);
}

/** 无存储时按浏览器语言判定默认语言 */
export function detectLang(navLang: string | undefined): PetLang {
  return /^zh[-_](TW|HK|MO|Hant)/i.test(navLang ?? '') ? 'zh-TW' : 'zh-CN';
}

export interface PetI18nInitOptions {
  /** 宿主路由前缀（浏览器 '/dsh-pet-7340'；桌面 BASE，可能是 bridge 方案）；缺省则只用本地存储，不同步 */
  base?: string;
  /** 限定转换范围的 CSS 选择器（浏览器内嵌在 DSH 页面里，只能碰 dsh-pet 自己的节点）；缺省 = 整个文档（桌面） */
  scope?: string;
}

export interface PetI18n {
  init(opts?: PetI18nInitOptions): void;
  lang(): PetLang;
  setLang(lang: PetLang): void;
  convert(text: string): string;
  onChange(fn: (lang: PetLang) => void): void;
}

function readStoredLang(): PetLang | null {
  try {
    const s = globalThis.localStorage?.getItem(STORE_KEY);
    return s === 'zh-CN' || s === 'zh-TW' ? s : null;
  } catch {
    return null; // 无存储（隐私模式 / 沙箱）时忽略
  }
}

export function createI18n(): PetI18n {
  let lang: PetLang = readStoredLang() ?? detectLang(globalThis.navigator?.language);
  let base = '';
  let scope = '';
  let started = false;
  let observer: MutationObserver | null = null;
  const listeners: Array<(l: PetLang) => void> = [];
  // 记录每个文本节点/属性的「原文」：切换语言可无损还原；应用自己改了内容（≠ 我们写入的）则视为新原文
  const textStore = new WeakMap<Text, { o: string; s: string }>();
  const attrStore = new WeakMap<Element, Record<string, { o: string; s: string }>>();

  const inScope = (el: Element | null): boolean => {
    if (!el) return false;
    if (el.closest(SKIP_SELECTOR)) return false;
    return scope ? !!el.closest(scope) : true;
  };

  const doText = (n: Text): void => {
    if (!inScope(n.parentElement)) return;
    let rec = textStore.get(n);
    const cur = n.data;
    if (!rec || cur !== rec.s) {
      rec = { o: cur, s: cur };
      textStore.set(n, rec);
    }
    const want = convertText(lang, rec.o);
    if (n.data !== want) n.data = want;
    rec.s = n.data;
  };

  const doAttrs = (el: Element): void => {
    if (!inScope(el)) return;
    let rec = attrStore.get(el);
    if (!rec) {
      rec = {};
      attrStore.set(el, rec);
    }
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a) ?? '';
      let r = rec[a];
      if (!r || cur !== r.s) {
        r = { o: cur, s: cur };
        rec[a] = r;
      }
      const want = convertText(lang, r.o);
      if (cur !== want) el.setAttribute(a, want);
      r.s = want;
    }
  };

  const walk = (root: Node): void => {
    if (root.nodeType === 3) {
      doText(root as Text);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    const el = root.nodeType === 9 ? (root as Document).documentElement : (root as Element);
    if (el) doAttrs(el);
    const tw = document.createTreeWalker(root, 1 | 4);
    let n: Node | null;
    while ((n = tw.nextNode())) {
      if (n.nodeType === 3) doText(n as Text);
      else doAttrs(n as Element);
    }
  };

  const observe = (): void => {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') doText(r.target as Text);
        else if (r.type === 'attributes') doAttrs(r.target as Element);
        else r.addedNodes.forEach((node) => walk(node));
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRS],
    });
  };

  const applyAll = (): void => {
    if (typeof document !== 'undefined') walk(document);
    for (const fn of listeners) {
      try {
        fn(lang);
      } catch {
        /* 监听器异常不影响其它监听器 */
      }
    }
  };

  const commit = (next: PetLang): void => {
    if (next === lang) return;
    lang = next;
    try {
      globalThis.localStorage?.setItem(STORE_KEY, next);
    } catch {
      /* 无存储时忽略 */
    }
    applyAll();
  };

  const pull = (): void => {
    if (!base) return;
    fetch(base + '/lang', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { lang?: unknown } | null) => {
        if (j && (j.lang === 'zh-CN' || j.lang === 'zh-TW')) commit(j.lang);
      })
      .catch(() => {
        /* 宿主暂时不可达：保持当前语言 */
      });
  };

  return {
    init(opts = {}) {
      if (started) return;
      started = true;
      base = opts.base ?? '';
      scope = opts.scope ?? '';
      const start = (): void => {
        observe();
        applyAll();
        pull();
        if (base) setInterval(pull, POLL_MS);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
      else start();
    },
    lang: () => lang,
    setLang(next) {
      if (!PET_LANGS.includes(next)) return;
      commit(next);
      if (base) {
        fetch(base + '/lang', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lang: next }),
        }).catch(() => {
          /* 保存失败不影响本次切换 */
        });
      }
    },
    convert: (text) => convertText(lang, text),
    onChange: (fn) => {
      listeners.push(fn);
    },
  };
}

/** 单例：浏览器 bundle 与桌面 shared-core 各自一份（各自的 JS 上下文） */
export const petI18n: PetI18n = createI18n();

/** 「语言」子菜单：两端注入同一份；当前语言前加 ✓ */
export function languageMenuBranch(current: PetLang = petI18n.lang()): MenuBranch {
  return {
    label: '語言 / 语言',
    children: [
      { label: (current === 'zh-CN' ? '✓ ' : '') + '简体中文', action: 'set-lang', lang: 'zh-CN' },
      { label: (current === 'zh-TW' ? '✓ ' : '') + '繁體中文', action: 'set-lang', lang: 'zh-TW' },
    ],
  };
}
