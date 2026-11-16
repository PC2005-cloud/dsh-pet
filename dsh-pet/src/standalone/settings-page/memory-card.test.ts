/**
 * 独立模式设置页「长期记忆」卡的契约测试。
 *
 * 三条契约：缺段时草稿给空实现（不提交，保留配置旧值）、整段读写含查询优化开关、
 * PowerContext 的三项只在选中该实现时才显示。
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
  checked?: boolean;
  value?: string;
  className?: string;
  append(...kids: FakeNode[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, fn: () => void): void;
  readonly firstElementChild: FakeNode | undefined;
}

interface MemoryDraft {
  provider: string;
  powercontext: { endpoint: string; token: string; optimizeQuery: boolean };
}

interface Probe {
  state: { globals: { memory: MemoryDraft }; pets: Record<string, unknown[]> };
  initDrafts(config: Record<string, unknown>): void;
  memoryCard(): FakeNode;
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
    'globalThis.__probe = { state, initDrafts, memoryCard, petsBody };',
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

/** 深度优先收集节点。 */
function walk(node: FakeNode, out: FakeNode[] = []): FakeNode[] {
  out.push(node);
  for (const kid of node.children) if (kid && kid.nodeType === 1) walk(kid, out);
  return out;
}

/** 包住地址与令牌的栅格容器。 */
const detailsBox = (page: Probe): FakeNode | undefined =>
  walk(page.memoryCard()).find(
    (item) =>
      item.className === 'grid2' && walk(item).some((kid) => kid.type === 'password' || kid.attrs.type === 'password'),
  );

describe('独立模式长期记忆', () => {
  test('成品里没有这一段 → 草稿给空实现', () => {
    const page = probe();
    page.initDrafts({ main: { pets: [] } });
    assert.equal(page.state.globals.memory.provider, '');
    assert.equal(page.state.globals.memory.powercontext.endpoint, '');
    assert.equal(page.state.globals.memory.powercontext.optimizeQuery, false);
  });

  test('成品里写了 → 原样读进草稿，含查询优化开关', () => {
    const page = probe();
    page.initDrafts({
      main: {
        pets: [],
        memory: {
          provider: POWERCONTEXT_MEMORY_ID,
          powercontext: { endpoint: 'http://127.0.0.1:8000', token: 'tk', optimizeQuery: true },
        },
      },
    });
    assert.equal(page.state.globals.memory.provider, POWERCONTEXT_MEMORY_ID);
    assert.equal(page.state.globals.memory.powercontext.endpoint, 'http://127.0.0.1:8000');
    assert.equal(page.state.globals.memory.powercontext.token, 'tk');
    assert.equal(page.state.globals.memory.powercontext.optimizeQuery, true);
  });

  test('保存体：实现与地址都填了才带上 memory，缺一个都不提交', () => {
    const page = probe();
    page.initDrafts({ main: { pets: [] } });
    assert.equal('memory' in page.petsBody(), false, '空实现不该进保存体');

    page.state.globals.memory = {
      provider: POWERCONTEXT_MEMORY_ID,
      powercontext: { endpoint: '', token: '', optimizeQuery: false },
    };
    assert.equal('memory' in page.petsBody(), false, '空地址不该进保存体');

    page.state.globals.memory = {
      provider: POWERCONTEXT_MEMORY_ID,
      powercontext: { endpoint: 'http://127.0.0.1:8000', token: '', optimizeQuery: true },
    };
    const sent = page.petsBody().memory as MemoryDraft;
    assert.equal(sent.provider, POWERCONTEXT_MEMORY_ID);
    assert.equal(sent.powercontext.optimizeQuery, true);
  });

  test('未选中该实现 → 地址、令牌与开关整块隐藏', () => {
    const page = probe();
    page.initDrafts({ main: { pets: [] } });
    const box = detailsBox(page);
    assert.ok(box, '容器要存在，靠 hidden 切换');
    assert.equal(box.hidden, true);
    const checkboxes = walk(page.memoryCard()).filter((item) => item.attrs.type === 'checkbox');
    assert.equal(checkboxes.length, 1, '查询优化开关存在但在隐藏容器里');
  });

  test('选中该实现 → 整块显示，值带回草稿', () => {
    const page = probe();
    page.initDrafts({
      main: {
        pets: [],
        memory: {
          provider: POWERCONTEXT_MEMORY_ID,
          powercontext: { endpoint: 'http://127.0.0.1:8000', token: 'tk', optimizeQuery: true },
        },
      },
    });
    const box = detailsBox(page);
    assert.ok(box);
    assert.ok(!box.hidden, '选中后不该再隐藏');
    const token = walk(page.memoryCard()).find((item) => item.type === 'password');
    assert.equal(token?.value, 'tk');
    const checkbox = walk(page.memoryCard()).find((item) => item.attrs.type === 'checkbox');
    assert.equal(checkbox?.checked, true);
  });
});
