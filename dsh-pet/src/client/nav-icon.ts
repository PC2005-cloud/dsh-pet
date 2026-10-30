/**
 * 设置面板导航图标补丁：把「桌宠配置」那一行的兜底齿轮换成指定图标。
 * DSH 的导航图标按分区 id 硬编码白名单，且私有、外部拿不到引用，只能在 DOM 层做。
 * 只打 `data-*` 标记并用 `::before` + mask 画字形，不动 DOM 结构，否则 React 会对被替换的节点 removeChild 崩。
 * mask 是 data URI，即独立图像文档：宿主 0.2.2 起图标改成 sprite 引用（`<use>` 指向页面里的 `<symbol>`），
 * 必须先展开成自包含 SVG，否则 mask 全透明、齿轮又被盖住，那一行直接变成零图标。
 * sprite 由宿主在挂载后才注入，装配这一刻取不到，所以字形推迟到认出面板时才解析。
 * 认行只能靠标题文本：投影到 DOM 的只有 label，而 account 行条件出现、位置会漂，不能用 `:nth-child`。
 * 降级：缺 document / MutationObserver、取不到字形时不装（齿轮留着），认不出那一行时什么都不做，只告警。
 * @module dsh-pet/src/client/nav-icon
 */

/** 注入的样式表去重标记（与宠物页面 / 设置页同一套 `data-plugin-css` 约定）。 */
const STYLE_TAG = 'dsh-pet/nav-icon.css';

/** 打在目标行 `<button>` 上的标记属性：React 从不 diff 它，重渲染 / 切语言都不会掉。 */
const MARK = 'data-dsh-pet-nav';

/** 设置面板根节点：shell 用 `createPortal` 挂到 body 上。 */
const PANEL_SELECTOR = '[data-shortcut-modal="settings"]';

/**
 * 类名来自 CSS Modules，哈希前缀会随 DSH 构建变，只匹配 `navList` / `navCell` / `navLabel` 这些名字部分。
 */
const LIST_SELECTOR = '[class*="navList"]';
const CELL_SELECTOR = '[class*="navCell"]';
const LABEL_SELECTOR = '[class*="navLabel"]';

/** 换图标的目标：一行导航的标题与该行要画上的字形。 */
export interface SectionNavIcon {
  /** 目标行标题，与注册 `settings.section` 时的 label 同源；每次现取。 */
  label: () => string;
  /** 把图标渲成内联 SVG 源码；由调用方注入，本模块因此不依赖 react / react-dom。 */
  renderSvg: () => string;
}

/**
 * 把内联 SVG 源码转成可作 CSS mask 的 data URI。
 * 需要补 `xmlns`（data URI 按独立图像文档解析，缺了不渲染）并把 `currentColor` 定成不透明黑（mask 只看 alpha）。
 * @param svg - 内联 SVG 源码。
 * @returns `url("data:image/svg+xml,...")`；源码为空时返回空串。
 */
export function svgMaskUri(svg: string): string {
  const source = svg.trim();
  if (source === '') return '';
  const namespaced = /<svg[^>]*\sxmlns=/i.test(source)
    ? source
    : source.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return 'url("data:image/svg+xml,' + encodeURIComponent(namespaced.split('currentColor').join('#000')) + '")';
}

/** 宿主文档里 `<symbol>` 的定义：展开 `<use>` 时要搬过去的属性和内容。 */
export interface SpriteSymbol {
  /** 逐个搬过去的属性（viewBox、fill、stroke 等），宿主加什么就带什么。 */
  readonly attrs: Readonly<Record<string, string>>;
  /** `<symbol>` 的子内容。 */
  readonly content: string;
}

/** 按 id 取 `<symbol>`；取不到返回 undefined，调用方据此保留兜底齿轮。 */
export type SymbolLookup = (id: string) => SpriteSymbol | undefined;

/**
 * 把 SVG 里的 `<use href="#id">` 展开成自包含图形。
 *
 * data URI 是一份独立图像文档，`<use>` 在里面找不到宿主文档的 `<symbol>`；不展开就只剩一片空白。
 * 只展开第一个引用：图标字形不会引用多个 symbol。
 *
 * @param svg - 渲染出的内联 SVG 源码；没有引用的（老版本内联 `<path>`）原样返回。
 * @param lookup - 按 id 取 `<symbol>` 的查找函数。
 * @returns 自包含的 SVG 源码；引用的 symbol 取不到时返回 undefined。
 */
export function expandUseRefs(svg: string, lookup: SymbolLookup): string | undefined {
  const ref = /<use\b[^>]*\s(?:xlink:)?href="#([^"]+)"/i.exec(svg);
  if (ref === null) return svg;
  const symbol = lookup(ref[1]);
  if (symbol === undefined) return undefined;
  const attrs = Object.entries(symbol.attrs)
    .map(([name, value]) => ' ' + name + '="' + value + '"')
    .join('');
  return '<svg xmlns="http://www.w3.org/2000/svg"' + attrs + '>' + symbol.content + '</svg>';
}

/**
 * 造一个「按 id 取 `<symbol>`」的查找器：搬属性时跳过 id，内容原样带过去。
 * @param find - 按 id 查元素的函数，通常是 `document.getElementById`。
 * @returns `expandUseRefs` 需要的查找函数；查不到时返回 undefined。
 * @internal
 */
export function symbolIn(find: (id: string) => Element | null): SymbolLookup {
  return (id) => {
    const symbol = find(id);
    if (symbol === null) return undefined;
    const attrs: Record<string, string> = {};
    for (let index = 0; index < symbol.attributes.length; index += 1) {
      const attr = symbol.attributes.item(index);
      if (attr === null || attr.name === 'id') continue;
      attrs[attr.name] = attr.value;
    }
    return { attrs, content: symbol.innerHTML };
  };
}

/** 换字形用的 CSS：盖住齿轮，用 `::before` + mask 画上我们的图标。 */
function cssFor(glyph: string): string {
  return [
    '/* 「桌宠配置」行的导航图标：盖住齿轮，换成本模块的图形 */',
    '[' + MARK + '] [class*="navIcon"]{display:none}',
    '[' +
      MARK +
      ']::before{content:"";flex:none;width:16px;height:16px;background-color:currentColor;' +
      '-webkit-mask:' +
      glyph +
      ' center/16px 16px no-repeat;mask:' +
      glyph +
      ' center/16px 16px no-repeat}',
  ].join('\n');
}

/** 注入样式表（只注入一次）。 */
function injectCss(doc: Document, glyph: string): void {
  if (doc.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') !== null) return;
  const tag = doc.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = STYLE_TAG;
  tag.textContent = cssFor(glyph);
  doc.head.appendChild(tag);
}

/** 异常 → 单行文案（告警用）。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把设置面板导航里目标分区的兜底齿轮换成指定图标。
 * @param target - 目标行标题与字形渲染器。
 * @returns 断开观察者的清理函数；已注入的样式与标记留在原地，不影响正确性。
 */
export function installSectionNavIcon(target: SectionNavIcon): () => void {
  const doc = typeof document === 'undefined' ? undefined : document;
  const Observer = typeof MutationObserver === 'undefined' ? undefined : MutationObserver;
  if (doc === undefined || Observer === undefined || doc.body === null) {
    console.warn('[dsh-pet] 设置页导航图标不可用：缺少 document / body / MutationObserver（齿轮照旧）');
    return () => {};
  }

  // sprite 由宿主在挂载后注入，装配这一刻取不到（见模块头），所以推迟到认出面板时再解析。
  let injected = false;
  let warnedGlyph = false;

  /** 告警只报一次：面板反复开关会反复走到同一条失败路径。 */
  const warnGlyph = (reason: string): void => {
    if (warnedGlyph) return;
    warnedGlyph = true;
    console.warn('[dsh-pet] 设置页导航图标不可用：' + reason + '（齿轮照旧）');
  };

  /** 解析并注入换字形样式；成功一次后不再重算，失败时留待面板下次出现再试。 */
  const ensureCss = (): void => {
    if (injected) return;
    let glyph: string;
    try {
      const expanded = expandUseRefs(
        target.renderSvg(),
        symbolIn((id) => doc.getElementById(id)),
      );
      if (expanded === undefined) {
        warnGlyph('sprite 里找不到引用的 <symbol>');
        return;
      }
      glyph = svgMaskUri(expanded);
    } catch (error) {
      warnGlyph('图标渲染失败：' + describe(error));
      return;
    }
    if (glyph === '') {
      warnGlyph('图标渲成了空 SVG');
      return;
    }
    injectCss(doc, glyph);
    injected = true;
  };

  // 认不出那一行是预期内的（比如 DSH 改了标题来源），只记一次不刷屏。
  let warned = false;

  /** 给面板里标题匹配的那一行打标记（幂等；已打过的不再读标题）。 */
  const markPanel = (panel: Element): void => {
    try {
      const wanted = target.label();
      if (wanted === '') return;
      const list = panel.querySelector(LIST_SELECTOR);
      if (list === null) return;
      for (const cell of list.querySelectorAll(CELL_SELECTOR)) {
        if (cell.getAttribute(MARK) !== null) continue;
        if (cell.querySelector(LABEL_SELECTOR)?.textContent === wanted) cell.setAttribute(MARK, '');
      }
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn('[dsh-pet] 设置页导航图标补丁异常，本次跳过（齿轮照旧）：' + describe(error));
      }
    }
  };

  // 两段式观察：body 只盯直接子节点，命中面板后改盯面板子树——聊天区 DOM 抖动频繁，全文档扫太贵。
  let watched: Element | undefined;
  let panelObserver: MutationObserver | undefined;

  const sync = (): void => {
    const panel = doc.querySelector(PANEL_SELECTOR);
    if (panel === null) {
      panelObserver?.disconnect();
      panelObserver = undefined;
      watched = undefined;
      return;
    }
    markPanel(panel);
    if (panel === watched) return;
    // 面板第一次出现（或重新打开）时才试解析字形：sprite 到这时通常已经挂载。
    ensureCss();
    panelObserver?.disconnect();
    watched = panel;
    panelObserver = new Observer(() => {
      markPanel(panel);
    });
    panelObserver.observe(panel, { childList: true, subtree: true });
  };

  // 插件可能在面板已打开时装配（刷新 / 热更新），所以先同步扫一遍。
  sync();
  const bodyObserver = new Observer(sync);
  bodyObserver.observe(doc.body, { childList: true });

  return () => {
    bodyObserver.disconnect();
    panelObserver?.disconnect();
  };
}
