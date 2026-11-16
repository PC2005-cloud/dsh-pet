/**
 * 独立模式设置页「PowerContext 连接」的契约测试。
 *
 * 三条契约：缺段时草稿给空地址（空地址不提交，保留配置里的旧值）、填了地址才进保存体、
 * 两个输入框只在选中该实现时才显示。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { POWERCONTEXT_MEMORY_ID } from '../../shared/memory.ts';
import { coreScript } from './script/core.ts';
import { globalsScript } from './script/globals.ts';
import { overlayScript } from './script/overlay.ts';
import { petsScript } from './script/pets.ts';
import { widgetsScript } from './script/widgets.ts';

interface FakeNode {
  nodeType: number;
  attrs: Record<string, string>;
  children: FakeNode[];
  hidden?: boolean;
  type?: string;
  value?: string;
  className?: string;
  append(...kids: FakeNode[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, fn: () => void): void;
  readonly firstElementChild: FakeNode | undefined;
}

interface Probe {
  state: {
    globals: { memoryProvider: string; powercontext: { endpoint: string; token: string } };
    pets: Record<string, unknown[]>;
  };
  initDrafts(config: Record<string, unknown>): void;
  modelCard(): FakeNode;
  petsBody(): Record<string, unknown>;
}

/** 最小假 DOM：只够渲染一张卡并把节点翻出来。 */
function probe(): Probe {
  const node = (): FakeNode => ({
    nodeType: 1,
    attrs: {},
    children: [],
    value: '',
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    addEventListener() {},
    append(...kids) {
      this.children.push(...kids);
    },
    get firstElementChild() {
      return this.children.find((kid) => kid && kid.nodeType === 1);
    },
  });
  const document = {
    createElement: node,
    createElementNS: node,
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const script = [
    coreScript('/dsh-pet-7340', {
      voices: [],
      defaultVoice: 'edge/zh-CN-XiaoyiNeural',
      fonts: [],
      displays: [],
      corners: [],
      physics: {},
      font: {},
      weights: { idle: 10, turn: 5, move: 5 },
      powerContextProviderId: POWERCONTEXT_MEMORY_ID,
    }),
    widgetsScript(),
    overlayScript(),
    globalsScript(),
    petsScript(),
    'globalThis.__probe = { state, initDrafts, modelCard, petsBody };',
  ].join('\n');
  const context: Record<string, unknown> = {
    document,
    location: { hash: '' },
    history: { replaceState() {} },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
  };
  runInNewContext(script, context);
  return (context as unknown as { __probe: Probe }).__probe;
}

/** 深度优先收集节点，用来在卡片里定位输入框与它的容器。 */
function walk(node: FakeNode, out: FakeNode[] = []): FakeNode[] {
  out.push(node);
  for (const kid of node.children) if (kid && kid.nodeType === 1) walk(kid, out);
  return out;
}

/** 子树里有没有令牌输入框；显隐挂在包住它的那个栅格容器上。 */
function hasSecret(node: FakeNode): boolean {
  if (node.type === 'password') return true;
  return node.children.some((kid) => kid && kid.nodeType === 1 && hasSecret(kid));
}

/** 包住两个连接字段的栅格容器。 */
const powerContextBox = (page: Probe): FakeNode | undefined =>
  walk(page.modelCard()).find((item) => item.className === 'grid2' && hasSecret(item));

describe('独立模式 PowerContext 连接', () => {
  test('成品里没有这一段 → 草稿给空地址', () => {
    const page = probe();
    page.initDrafts({ main: { pets: [] } });
    // 草稿对象在 VM 里造，跨 realm 整体 deepEqual 不成立，逐字段断言
    assert.equal(page.state.globals.powercontext.endpoint, '');
    assert.equal(page.state.globals.powercontext.token, '');
  });

  test('成品里写了 → 原样读进草稿', () => {
    const page = probe();
    page.initDrafts({
      main: { pets: [], powercontext: { endpoint: 'http://127.0.0.1:8000', token: 'tk' } },
    });
    assert.equal(page.state.globals.powercontext.endpoint, 'http://127.0.0.1:8000');
    assert.equal(page.state.globals.powercontext.token, 'tk');
  });

  test('保存体：填了地址才带上这一段，空地址不提交（免得被宿主判成非法）', () => {
    const page = probe();
    page.initDrafts({ main: { pets: [] } });
    assert.equal('powercontext' in page.petsBody(), false, '空地址不该进保存体');
    page.state.globals.powercontext = { endpoint: 'http://127.0.0.1:8000', token: '' };
    const sent = page.petsBody().powercontext as { endpoint: string; token: string };
    assert.equal(sent.endpoint, 'http://127.0.0.1:8000');
    assert.equal(sent.token, '');
  });

  test('未选中该实现 → 两个输入框整块隐藏', () => {
    const page = probe();
    page.initDrafts({ main: { pets: [] } });
    const box = powerContextBox(page);
    assert.ok(box, '卡片里要有包住令牌输入框的容器');
    assert.equal(box.hidden, true);
  });

  test('选中该实现 → 整块显示，地址与令牌都带回草稿值', () => {
    const page = probe();
    page.initDrafts({
      main: {
        pets: [],
        memoryProvider: POWERCONTEXT_MEMORY_ID,
        powercontext: { endpoint: 'http://127.0.0.1:8000', token: 'tk' },
      },
    });
    const box = powerContextBox(page);
    assert.ok(box);
    assert.ok(!box.hidden, '选中后不该再隐藏');
    const nodes = walk(page.modelCard());
    const token = nodes.find((item) => item.type === 'password');
    assert.equal(token?.value, 'tk');
    assert.ok(
      nodes.some((item) => item.value === 'http://127.0.0.1:8000'),
      '地址输入框应该带回成品值',
    );
  });
});
