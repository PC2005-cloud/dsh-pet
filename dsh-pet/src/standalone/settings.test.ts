import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { validateSettings, publicSettings } from './settings.ts';
import { settingsPage, settingsScript, settingsStyle } from './settings-page.ts';

/** 记录到的一条请求。 */
type RecordedRequest = {
  url: string;
  options: { method: string; body?: string; headers: Record<string, string> };
};

/** getElementById 的替身：只实现页面脚本用到的那几个属性。 */
type FakeElement = {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  dataset: Record<string, string>;
  children: unknown[];
  listeners: Record<string, (event?: unknown) => Promise<void> | void>;
  addEventListener: (name: string, fn: (event?: unknown) => Promise<void> | void) => void;
  append: (...kids: unknown[]) => void;
  setAttribute: () => void;
  reportValidity: () => boolean;
  getBoundingClientRect: () => {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
};

/** createElement 的替身：能追加、能设属性、能点、能被读值。 */
type FakeNode = {
  nodeType: number;
  isConnected: boolean;
  hidden: boolean;
  value: string;
  checked: boolean;
  disabled: boolean;
  textContent: string;
  className: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, () => void>;
  classList: { toggle(): void };
  append(...kids: unknown[]): void;
  setAttribute(): void;
  addEventListener(name: string, fn: () => void): void;
  removeEventListener(): void;
  remove(): void;
  focus(): void;
  scrollIntoView(): void;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  readonly firstElementChild: FakeNode | null;
};

/** 一次页面启动后的句柄：各 test 自己起一份，互不共享状态。 */
interface Page {
  /** 按 id 取到启动时被脚本访问过的元素。 */
  element(id: string): FakeElement;
  /** 脚本发出的全部请求，按发出顺序。 */
  requests: RecordedRequest[];
  /** createElement 造出来的节点都会挂到 body 上（菜单、弹窗）。 */
  body: FakeNode;
  /** 地址片段是否已被清掉，清成什么。 */
  stripped(): string;
  /** 打到 AI 设置端点的请求。 */
  aiRequests(): RecordedRequest[];
  /** 最后一次 AI 设置请求的请求体。 */
  lastAiBody(): Record<string, unknown>;
  /** 最近一次确认框的两个按钮；没弹过就是空数组。 */
  lastDialogActions(): FakeNode[];
}

/**
 * 起一份页面：假 DOM + 真脚本。
 *
 * 每个 test 都新建，避免用例之间互相污染——脚本在启动时会发请求、改元素状态。
 */
async function setupPage(): Promise<Page> {
  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        checked: false,
        disabled: false,
        hidden: false,
        textContent: '',
        dataset: {},
        children: [],
        listeners: {},
        addEventListener(name, fn) {
          this.listeners[name] = fn;
        },
        append(...kids) {
          this.children.push(...kids);
        },
        setAttribute() {},
        reportValidity: () => true,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 36, width: 200, height: 36 }),
      });
    return elements.get(id)!;
  };
  const node = (): FakeNode => {
    const el: Record<string, unknown> = {
      nodeType: 1,
      isConnected: true,
      hidden: false,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      className: '',
      style: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      children: [] as unknown[],
      listeners: {} as Record<string, () => void>,
      classList: { toggle() {} },
      append(...kids: unknown[]) {
        (el.children as unknown[]).push(...kids);
      },
      setAttribute() {},
      addEventListener(name: string, fn: () => void) {
        (el.listeners as Record<string, () => void>)[name] = fn;
      },
      removeEventListener() {},
      remove() {
        el.isConnected = false;
      },
      focus() {},
      scrollIntoView() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 36, width: 200, height: 36 }),
      get firstElementChild() {
        return (el.children as Array<{ nodeType?: number }>).find((kid) => kid && kid.nodeType === 1) ?? null;
      },
    };
    return el as unknown as FakeNode;
  };

  const body = node();
  const requests: RecordedRequest[] = [];
  let stripped = '';
  runInNewContext(settingsScript, {
    URLSearchParams,
    // Page polling should not keep this isolated VM fixture alive after the test finishes.
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms).unref(),
    clearTimeout,
    console,
    window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800, confirm: () => false },
    document: {
      getElementById: element,
      createElement: node,
      createElementNS: node,
      createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      body,
    },
    location: { hash: '#token=process-capability', pathname: '/standalone-ai/' },
    history: {
      replaceState: (_a: unknown, _b: unknown, path: string) => {
        stripped = path;
      },
    },
    fetch: async (url: string, options: RecordedRequest['options']) => {
      requests.push({ url, options });
      if (url === '/standalone-ai/models') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            models: [
              { id: 'm-one', name: 'M One' },
              { id: 'm-two', name: 'm-two' },
            ],
          }),
        };
      }
      if (url === '/standalone-ai/balance') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            provider: 'deepseek-official',
            shape: 'money',
            data: { wallets: [{ currency: 'CNY', total: '12.34', granted: '0.00', toppedUp: '12.34' }] },
          }),
        };
      }
      const clearing =
        url === '/standalone-ai/settings' && options.body ? JSON.parse(options.body).clearApiKey === true : false;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          protocol: 'anthropic',
          baseUrl: 'https://example.test',
          model: 'x',
          balanceProvider: 'deepseek-official',
          hasKey: !clearing,
          automaticWhispers: false,
          whisperIntervalSec: 300,
          maxTokens: 1024,
        }),
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const aiRequests = () => requests.filter(({ url }) => url === '/standalone-ai/settings');
  return {
    element,
    requests,
    body,
    stripped: () => stripped,
    aiRequests,
    lastAiBody: () => {
      const list = aiRequests();
      return JSON.parse(list[list.length - 1].options.body ?? '{}');
    },
    lastDialogActions: () => {
      const masks = body.children.filter((kid) => kid.className === 'dialogMask');
      const panel = masks[masks.length - 1]?.children[0];
      return panel ? panel.children[2].children : [];
    },
  };
}

/** 等两轮事件循环，让脚本里的 await 链落定。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('settings validation accepts explicit costs and write-only blank/clear key semantics', () => {
  const input = {
    protocol: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model',
    apiKey: '',
    automaticWhispers: false,
    whisperIntervalSec: 300,
    maxTokens: 512,
  };
  assert.deepEqual(validateSettings(input), input);
  assert.deepEqual(validateSettings({ clearApiKey: true }), { clearApiKey: true });
  for (const input of [
    null,
    [],
    { protocol: 'other' },
    { clearApiKey: 'yes' },
    { whisperIntervalSec: 59 },
    { whisperIntervalSec: 1.5 },
    { maxTokens: 99999 },
    { apiKey: 123 },
    { hasKey: true },
    { enabled: true },
    { baseUrl: 'file:///a' },
    { baseUrl: 'https://user:secret@example.test/v1' },
    { baseUrl: 'https://example.test/?key=secret' },
  ]) {
    assert.throws(() => validateSettings(input), Error, JSON.stringify(input));
  }
});

test('public settings are an allowlist even if backend accidentally includes credentials', () => {
  const actual = publicSettings({
    protocol: 'anthropic',
    apiKey: 'never expose',
    token: 'never expose',
    hasKey: true,
    model: 'x',
    enabled: false,
  });
  assert.deepEqual(actual, { protocol: 'anthropic', hasKey: true, model: 'x' });
  assert.equal(JSON.stringify(actual).includes('never expose'), false);
});

test('settings shell is accessible, self contained, and never saves browser secrets', () => {
  assert.match(settingsPage, /lang="zh-CN"/);
  assert.match(settingsPage, /type="password"/);
  assert.match(settingsPage, /aria-live="polite"/);
  assert.match(settingsPage, /data-tab="config"/);
  assert.match(settingsPage, /data-tab="chat"/);
  assert.match(settingsPage, /id="panel-config"/);
  assert.match(settingsScript, /history\.replaceState/);
  assert.match(settingsScript, /X-DSH-Pet-Token/);
  assert.doesNotMatch(settingsScript, /localStorage|sessionStorage|document\.cookie|innerHTML/);
  // Public provider presets are form values; the shell must not load remote resources or submit remotely.
  assert.doesNotMatch(settingsPage, /(?:src|href|action)=["']https?:\/\//);
  assert.match(settingsStyle, /focus-visible/);
});

test('启动：地址片段被清掉，密钥框清空并显示已保存', async () => {
  const page = await setupPage();
  assert.equal(page.stripped(), '/standalone-ai/');
  assert.equal(page.element('apiKey').value, '');
  assert.equal(page.element('key-state').textContent, '已保存 · 不回显');
  assert.ok(
    page.aiRequests().every(({ options }) => options.headers['X-DSH-Pet-Token'] === 'process-capability'),
    'AI 请求必须带本次运行的访问令牌',
  );
});

test('保存：密钥只写不回显，且不再提交启用位', async () => {
  const page = await setupPage();
  page.element('apiKey').value = 'write-only-fake-key';
  await page.element('settings').listeners.submit({ preventDefault() {} });
  assert.equal(page.element('apiKey').value, '');
  assert.equal(page.lastAiBody().apiKey, 'write-only-fake-key');
  assert.equal('enabled' in page.lastAiBody(), false, '页面不再提交启用位');
  assert.equal(page.lastAiBody().balanceProvider, 'deepseek-official', '余额服务商随设置一起提交');
});

test('查询余额：选了服务商才可点，结果拼成一行金额并带上访问令牌', async () => {
  const page = await setupPage();
  await settle();
  const button = page.element('balance-btn');
  const result = page.element('balance-result');
  assert.equal(button.disabled, false, '已保存 deepseek-official，按钮应可点');

  const balanceRequests = () => page.requests.filter(({ url }) => url === '/standalone-ai/balance');
  await button.listeners.click();
  await settle();

  assert.equal(balanceRequests().length, 1);
  assert.equal(balanceRequests()[0].options.headers['X-DSH-Pet-Token'], 'process-capability');
  assert.match(result.textContent, /CNY 12\.34/);
  assert.equal(result.dataset.ok, 'true');
  assert.equal(button.disabled, false, '查询结束后按钮恢复可点');
});

test('删除密钥：先弹确认框，取消不发请求，确认才提交 clearApiKey', async () => {
  const page = await setupPage();
  page.element('key-delete').listeners.click();
  await settle();
  assert.equal(page.lastDialogActions().length, 2, '删除前必须先弹确认框');

  const before = page.aiRequests().length;
  page.lastDialogActions()[0].listeners.click();
  await settle();
  assert.equal(page.aiRequests().length, before, '取消后不得发出删除请求');

  page.element('key-delete').listeners.click();
  await settle();
  page.lastDialogActions()[1].listeners.click();
  await settle();
  assert.equal(page.lastAiBody().clearApiKey, true);
  assert.equal(page.element('key-state').textContent, '尚未设置');
  assert.equal(page.element('key-actions').hidden, true, '没有密钥时不再显示删除入口');
});

test('拉取模型：用表单草稿请求端点，选中后写回输入框并标记未保存', async () => {
  const page = await setupPage();
  page.element('baseUrl').value = 'https://draft.test/v1';
  page.element('apiKey').value = 'draft-key';
  page.element('model-toggle').listeners.click();
  await settle();

  const modelRequests = () => page.requests.filter(({ url }) => url === '/standalone-ai/models');
  assert.equal(modelRequests().length, 1);
  assert.deepEqual(JSON.parse(modelRequests()[0].options.body ?? '{}'), {
    protocol: 'anthropic',
    baseUrl: 'https://draft.test/v1',
    apiKey: 'draft-key',
  });
  assert.equal(modelRequests()[0].options.headers['X-DSH-Pet-Token'], 'process-capability');
  assert.match(page.element('model-result').textContent, /已拉取 2 个模型/);
  assert.equal(page.element('model').value, 'x', '拉取本身不得改动已填的模型');

  const menus = page.body.children.filter((kid) => kid.className === 'selectMenu');
  const menu = menus[menus.length - 1];
  assert.ok(menu, '拉到模型后必须直接弹出候选菜单');
  menu.children[0].listeners.click();
  assert.equal(page.element('model').value, 'm-one');
  assert.equal(page.element('dirty').hidden, false);
});
