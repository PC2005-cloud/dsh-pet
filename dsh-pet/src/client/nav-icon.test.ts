/**
 * 设置面板导航图标补丁的契约测试 —— 钉住「按标题认行 + 打标记 + CSS 换字形」这套机制的
 * 全部前提。
 *
 * 为什么值得单独测：DSH 没有给第三方设置分区配图标的入口（`navIcon(id)` 是按 id 硬编码的
 * 白名单 + 兜底齿轮，slot 契约里也没有图标位），本插件只能靠 DOM 层补。这套机制一旦失效，
 * 表现是「图标还是齿轮」而不是报错，升级后极容易无声退化 —— 所以每条前提都要有断言兜住：
 *
 * - 只有标题匹配的那一行被打标记，其余行原样不动；
 * - 标题为空（locale 未就绪）时不打标记，避免误伤标题同为空的其它行；
 * - 标记打在 `data-*` 上，DSH 重渲染 / 切语言都不会摘掉（这是不换 DOM 节点的前提）；
 * - 样式只注入一次，且确实「盖住齿轮 + 画上 mask」；
 * - 两段式观察：body 只盯直接子节点，命中后改盯面板子树（不在全文档上跑 subtree）；
 * - 面板关掉再开、以及插件在面板已打开时装配，都能补上标记；
 * - dispose 后观察者断开，不再打标记；
 * - 图标渲不成 SVG / 缺 MutationObserver → 完全不装、只告警（齿轮照旧），绝不改 DOM。
 *
 * 假 DOM 只实现本模块用到的那几个成员（不引 jsdom）：选择器只支持 `tag` / `[attr]` /
 * `[attr="v"]` / `[attr*="v"]` 四种形态。
 *
 * 跑法：node --experimental-strip-types --test src/client/nav-icon.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { installSectionNavIcon, svgMaskUri } from './nav-icon.ts';

/** 标记属性名（与模块内 MARK 一致；这里独立写一份，避免测试跟着实现改名而失效）。 */
const MARK = 'data-dsh-pet-nav';

/** camelCase → `data-` 属性名（复刻 `dataset` 的映射规则）。 */
function dataName(key: string): string {
  return 'data-' + key.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase());
}

/** 极简元素替身。 */
class El {
  readonly tag: string;
  readonly attrs = new Map<string, string>();
  readonly children: El[] = [];
  readonly dataset: Record<string, string>;
  /** 自身的文本（真实 DOM 里 textContent 是读写属性，模块用它写 `<style>` 内容）。 */
  ownText = '';

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag;
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
    // dataset 写回属性：模块用 `tag.dataset.pluginCss = ...` 打去重标记，
    // 随后又用 `style[data-plugin-css="..."]` 查重，两者必须连通。
    this.dataset = new Proxy({} as Record<string, string>, {
      set: (_target, key, value: string) => {
        this.attrs.set(dataName(String(key)), value);
        return true;
      },
    });
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.length = 0;
  }

  append(...nodes: El[]): void {
    this.children.push(...nodes);
  }

  appendChild(node: El): void {
    this.children.push(node);
  }

  removeChild(node: El): void {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  querySelectorAll(selector: string): El[] {
    return this.descendants().filter((el) => matches(el, selector));
  }

  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  private descendants(): El[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

/** 支持 `tag` / `[attr]` / `[attr="v"]` / `[attr*="v"]` 四种形态。 */
function matches(el: El, selector: string): boolean {
  const parsed = /^([a-z]*)(?:\[([a-zA-Z-]+)(?:(\*?=)"([^"]*)")?\])?$/.exec(selector);
  if (parsed === null) throw new Error('假 DOM 不支持的 selector：' + selector);
  const [, tag, attr, op, value] = parsed;
  if (tag !== '' && el.tag !== tag) return false;
  if (attr === undefined) return true;
  const actual = el.attrs.get(attr);
  if (actual === undefined) return false;
  if (op === undefined) return true;
  return op === '*=' ? actual.includes(value ?? '') : actual === value;
}

/** 极简 document 替身：querySelector 同时覆盖 body 与 head（模块两处都查）。 */
class FakeDocument {
  readonly head = new El('head');
  readonly body = new El('body');

  createElement(tag: string): El {
    return new El(tag);
  }

  querySelector(selector: string): El | null {
    return this.body.querySelector(selector) ?? this.head.querySelector(selector);
  }
}

/** 极简 MutationObserver 替身：手动 `fire()` 模拟一次 DOM 变化。 */
class FakeObserver {
  static created: FakeObserver[] = [];
  readonly callback: () => void;
  readonly observed: Array<{ target: unknown; options: unknown }> = [];
  disconnected = false;

  constructor(callback: () => void) {
    this.callback = callback;
    FakeObserver.created.push(this);
  }

  observe(target: unknown, options?: unknown): void {
    this.observed.push({ target, options });
  }

  disconnect(): void {
    this.disconnected = true;
  }

  fire(): void {
    if (!this.disconnected) this.callback();
  }
}

/** 造一个设置面板：`[data-shortcut-modal="settings"]` > `[class*="navList"]` > N 个 navCell。 */
function panelWith(labels: string[]): { panel: El; cells: El[] } {
  const panel = new El('div', { 'data-shortcut-modal': 'settings' });
  const list = new El('div', { class: 'VOzbGW_navList' });
  const cells = labels.map((label) => {
    const cell = new El('button', { class: 'VOzbGW_navCell' });
    const span = new El('span', { class: 'VOzbGW_navLabel' });
    span.textContent = label;
    cell.append(new El('svg', { class: 'VOzbGW_navIcon' }), span);
    list.append(cell);
    return cell;
  });
  panel.append(list);
  return { panel, cells };
}

/** 触发所有仍存活的观察者（模拟「DOM 变了」）。 */
function poke(): void {
  for (const observer of FakeObserver.created) observer.fire();
}

/** 装一套假 DOM 全局，返回 document 与还原函数。 */
function withFakeDom(): { doc: FakeDocument; restore: () => void } {
  const doc = new FakeDocument();
  const previousDocument = globalThis.document;
  const previousObserver = globalThis.MutationObserver;
  FakeObserver.created = [];
  (globalThis as { document?: unknown }).document = doc;
  (globalThis as { MutationObserver?: unknown }).MutationObserver = FakeObserver;
  return {
    doc,
    restore: () => {
      globalThis.document = previousDocument;
      globalThis.MutationObserver = previousObserver;
      FakeObserver.created = [];
    },
  };
}

/**
 * 临时接管 `console.warn`，返回收集到的消息与还原函数。
 * 降级路径的告警既要断言（否则「静默失效」这条就没人守），又不该污染测试输出。
 */
function captureWarn(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(' '));
  };
  return {
    messages,
    restore: () => {
      console.warn = original;
    },
  };
}

/** 一个能用的假字形渲染器（记录调用次数）。 */
function fakeRenderer(svg = '<svg viewBox="0 0 16 16" stroke="currentColor"><path d="M1 1h2"/></svg>'): {
  calls: number;
  renderSvg: () => string;
} {
  const renderer = {
    calls: 0,
    renderSvg: (): string => {
      renderer.calls += 1;
      return svg;
    },
  };
  return renderer;
}

describe('svgMaskUri —— 内联 SVG 转 CSS mask 用的 data URI', () => {
  test('补上 xmlns（React 渲染出的 DOM svg 不带命名空间，data URI 里缺了就不渲染）', () => {
    const uri = svgMaskUri('<svg viewBox="0 0 16 16"><path d="M1 1"/></svg>');
    assert.ok(uri.startsWith('url("data:image/svg+xml,'));
    assert.ok(decodeURIComponent(uri).includes('xmlns="http://www.w3.org/2000/svg"'));
  });

  test('已经有 xmlns 时不重复插一份', () => {
    const uri = svgMaskUri('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"/>');
    const decoded = decodeURIComponent(uri);
    assert.equal(decoded.split('xmlns=').length - 1, 1);
  });

  test('currentColor 定成不透明黑（mask 只看 alpha，data URI 里 currentColor 会退化）', () => {
    const decoded = decodeURIComponent(svgMaskUri('<svg stroke="currentColor"/>'));
    assert.ok(decoded.includes('stroke="#000"'));
    assert.equal(decoded.includes('currentColor'), false);
  });

  test('引号与尖括号被编码，不会把 CSS 的 url("...") 提前闭合', () => {
    const uri = svgMaskUri('<svg a="b"/>');
    // 只该有包裹用的那一对引号；SVG 里的引号必须被编码掉
    assert.equal(uri.split('"').length - 1, 2);
    assert.ok(uri.includes('%22'));
    assert.ok(uri.includes('%3C'));
  });

  test('空 / 纯空白源码返回空串（调用方据此判定不可用）', () => {
    assert.equal(svgMaskUri(''), '');
    assert.equal(svgMaskUri('   \n '), '');
  });
});

describe('installSectionNavIcon —— 设置面板导航换图标', () => {
  test('只给标题匹配的那一行打标记，其余行原样不动', () => {
    const { doc, restore } = withFakeDom();
    try {
      const { panel, cells } = panelWith(['通用', '桌宠配置', '子智能体']);
      doc.body.append(panel);

      const dispose = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: fakeRenderer().renderSvg });

      assert.equal(cells[0].getAttribute(MARK), null);
      assert.equal(cells[1].getAttribute(MARK), '');
      assert.equal(cells[2].getAttribute(MARK), null);
      dispose();
    } finally {
      restore();
    }
  });

  test('标题为空（locale 未就绪）时不打标记，避免误伤标题同为空的其它行', () => {
    const { doc, restore } = withFakeDom();
    try {
      const { panel, cells } = panelWith(['', '']);
      doc.body.append(panel);

      const dispose = installSectionNavIcon({ label: () => '', renderSvg: fakeRenderer().renderSvg });

      assert.deepEqual(
        cells.map((cell) => cell.getAttribute(MARK)),
        [null, null],
      );
      dispose();
    } finally {
      restore();
    }
  });

  test('标记打在 React 从不 diff 的 data-* 上：标题变了也不会掉（重渲染不摘标记）', () => {
    const { doc, restore } = withFakeDom();
    try {
      const { panel, cells } = panelWith(['桌宠配置']);
      doc.body.append(panel);
      let label = '桌宠配置';
      const dispose = installSectionNavIcon({ label: () => label, renderSvg: fakeRenderer().renderSvg });
      assert.equal(cells[0].getAttribute(MARK), '');

      // 模拟切语言：DSH 重渲染这一行、标题文本变了；React 不会碰我们加的 data-*
      label = 'Pet Config';
      const span = cells[0].querySelector('[class*="navLabel"]');
      assert.ok(span !== null);
      span.textContent = 'Pet Config';
      poke();

      assert.equal(cells[0].getAttribute(MARK), '');
      dispose();
    } finally {
      restore();
    }
  });

  test('样式只注入一次，且确实「盖住齿轮 + 画上 mask」', () => {
    const { doc, restore } = withFakeDom();
    try {
      const { panel } = panelWith(['桌宠配置']);
      doc.body.append(panel);

      const dispose = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: fakeRenderer().renderSvg });
      poke();

      const styles = doc.head.querySelectorAll('style[data-plugin-css="dsh-pet/nav-icon.css"]');
      assert.equal(styles.length, 1);
      const css = styles[0].textContent;
      assert.ok(css.includes('[' + MARK + '] [class*="navIcon"]{display:none}'));
      assert.ok(css.includes('mask:url("data:image/svg+xml,'));
      assert.ok(css.includes('center/16px 16px no-repeat'));
      dispose();
    } finally {
      restore();
    }
  });

  test('字形只渲一次（图标是静态的，不该每次开面板都重渲）', () => {
    const { doc, restore } = withFakeDom();
    try {
      const { panel } = panelWith(['桌宠配置']);
      doc.body.append(panel);
      const renderer = fakeRenderer();

      const dispose = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: renderer.renderSvg });
      poke();
      poke();
      assert.equal(renderer.calls, 1);
      dispose();
    } finally {
      restore();
    }
  });

  test('两段式观察：body 只盯直接子节点，命中后改盯面板子树（不在全文档上跑 subtree）', () => {
    const { doc, restore } = withFakeDom();
    try {
      // 面板还没开：只有一个盯 body 的观察者，且没开 subtree（否则聊天区 DOM 抖动会拖慢整页）
      const disposeBefore = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: fakeRenderer().renderSvg });
      assert.equal(FakeObserver.created.length, 1);
      assert.equal(FakeObserver.created[0].observed[0].target, doc.body);
      assert.deepEqual(FakeObserver.created[0].observed[0].options, { childList: true });
      disposeBefore();

      // 面板已开：多一个盯面板子树的观察者，body 那个仍然只盯直接子节点
      FakeObserver.created = [];
      const { panel } = panelWith(['桌宠配置']);
      doc.body.append(panel);
      const disposeAfter = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: fakeRenderer().renderSvg });

      assert.equal(FakeObserver.created.length, 2);
      const onPanel = FakeObserver.created.find((observer) => observer.observed[0]?.target === panel);
      const onBody = FakeObserver.created.find((observer) => observer.observed[0]?.target === doc.body);
      assert.ok(onPanel !== undefined, '应该有一个盯面板的观察者');
      assert.ok(onBody !== undefined, '应该有一个盯 body 的观察者');
      assert.deepEqual(onPanel.observed[0].options, { childList: true, subtree: true });
      assert.deepEqual(onBody.observed[0].options, { childList: true });
      disposeAfter();
    } finally {
      restore();
    }
  });

  test('面板后开：body 变化触发同步后补上标记', () => {
    const { doc, restore } = withFakeDom();
    try {
      const dispose = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: fakeRenderer().renderSvg });
      const { panel, cells } = panelWith(['通用', '桌宠配置']);
      doc.body.append(panel);
      assert.equal(cells[1].getAttribute(MARK), null);

      poke();
      assert.equal(cells[1].getAttribute(MARK), '');
      dispose();
    } finally {
      restore();
    }
  });

  test('面板关掉再开：观察者换到新面板，新行照样打上标记', () => {
    const { doc, restore } = withFakeDom();
    try {
      const first = panelWith(['桌宠配置']);
      doc.body.append(first.panel);
      const dispose = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: fakeRenderer().renderSvg });
      assert.equal(first.cells[0].getAttribute(MARK), '');

      doc.body.removeChild(first.panel);
      const second = panelWith(['桌宠配置']);
      doc.body.append(second.panel);
      poke();

      assert.equal(second.cells[0].getAttribute(MARK), '');
      dispose();
    } finally {
      restore();
    }
  });

  test('dispose 后观察者断开，新面板不再被打标记', () => {
    const { doc, restore } = withFakeDom();
    try {
      const dispose = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: fakeRenderer().renderSvg });
      dispose();

      const { panel, cells } = panelWith(['桌宠配置']);
      doc.body.append(panel);
      poke();
      assert.equal(cells[0].getAttribute(MARK), null);
    } finally {
      restore();
    }
  });

  test('图标渲不成 SVG → 完全不装、只告警，且一行 DOM 都没碰', () => {
    const { doc, restore } = withFakeDom();
    const warn = captureWarn();
    try {
      const { panel, cells } = panelWith(['桌宠配置']);
      doc.body.append(panel);

      const dispose = installSectionNavIcon({
        label: () => '桌宠配置',
        renderSvg: () => {
          throw new Error('react-dom 缺失');
        },
      });

      assert.equal(cells[0].getAttribute(MARK), null);
      assert.equal(doc.head.querySelectorAll('style').length, 0);
      assert.equal(FakeObserver.created.length, 0);
      assert.equal(warn.messages.length, 1);
      assert.ok(warn.messages[0].includes('react-dom 缺失'));
      dispose();
    } finally {
      warn.restore();
      restore();
    }
  });

  test('渲成空 SVG → 不装、告警（不注入一条指向空图的 mask）', () => {
    const { doc, restore } = withFakeDom();
    const warn = captureWarn();
    try {
      const dispose = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: () => '  ' });
      assert.equal(doc.head.querySelectorAll('style').length, 0);
      assert.equal(warn.messages.length, 1);
      assert.ok(warn.messages[0].includes('空 SVG'));
      dispose();
    } finally {
      warn.restore();
      restore();
    }
  });

  test('缺 MutationObserver → 不装、告警', () => {
    const { restore } = withFakeDom();
    const warn = captureWarn();
    try {
      (globalThis as { MutationObserver?: unknown }).MutationObserver = undefined;
      const dispose = installSectionNavIcon({ label: () => '桌宠配置', renderSvg: fakeRenderer().renderSvg });
      assert.equal(warn.messages.length, 1);
      assert.ok(warn.messages[0].includes('MutationObserver'));
      dispose();
    } finally {
      warn.restore();
      restore();
    }
  });

  test('标题 thunk 抛错 → 跳过本轮、只告警一次（齿轮照旧，不刷屏）', () => {
    const { doc, restore } = withFakeDom();
    const warn = captureWarn();
    try {
      const { panel, cells } = panelWith(['桌宠配置']);
      doc.body.append(panel);

      const dispose = installSectionNavIcon({
        label: () => {
          throw new Error('locale 未就绪');
        },
        renderSvg: fakeRenderer().renderSvg,
      });
      poke();
      poke();

      assert.equal(cells[0].getAttribute(MARK), null);
      assert.equal(warn.messages.length, 1);
      assert.ok(warn.messages[0].includes('locale 未就绪'));
      dispose();
    } finally {
      warn.restore();
      restore();
    }
  });
});
