/**
 * 独立模式设置页「动作频率」卡的契约测试。
 *
 * 三条契约：
 *   1. 成品配置里的 animationWeights 被读进草稿，缺项回落内置默认；
 *   2. 改一项时另两项不动、超上限被夹住，只读的随机动作同步更新；
 *   3. 保存体带上 animationWeights。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import { coreScript } from './script/core.ts';
import { globalsScript } from './script/globals.ts';
import { petsScript } from './script/pets.ts';
import { widgetsScript } from './script/widgets.ts';

interface FakeNode {
  nodeType: number;
  attrs: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, () => void>;
  value?: string;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, fn: () => void): void;
  append(...kids: FakeNode[]): void;
}

interface Probe {
  state: {
    globals: { animationWeights: { idle: number; turn: number; move: number } };
    pets: Record<string, unknown[]>;
  };
  motionCard(): FakeNode;
  pickGlobals(main: Record<string, unknown>): { animationWeights: { idle: number; turn: number; move: number } };
  petsBody(): { animationWeights: { idle: number; turn: number; move: number } };
}

/** 最小假 DOM：只够脚本渲染卡片并触发一次 input。 */
function probe(): Probe {
  const byId = new Map<string, FakeNode>();
  const node = (): FakeNode => {
    const el: FakeNode = {
      nodeType: 1,
      attrs: {},
      children: [],
      listeners: {},
      value: '',
      setAttribute(name, value) {
        el.attrs[name] = String(value);
        if (name === 'id') byId.set(String(value), el);
      },
      addEventListener(name, fn) {
        el.listeners[name] = fn;
      },
      append(...kids) {
        el.children.push(...kids);
      },
    };
    return el;
  };
  const document = {
    createElement: node,
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const script = [
    coreScript('/dsh-pet-7340', {
      voices: [],
      fonts: [],
      displays: [],
      corners: [],
      physics: {},
      font: {},
      weights: { idle: 10, turn: 5, move: 5 },
    }),
    widgetsScript(),
    globalsScript(),
    petsScript(),
    'globalThis.__probe = { state, motionCard, pickGlobals, petsBody };',
  ].join('\n');
  const context: Record<string, unknown> = {
    document,
    location: { hash: '' },
    history: { replaceState() {} },
    URLSearchParams,
  };
  runInNewContext(script, context);
  return context.__probe as Probe;
}

/** 深度遍历渲染树里的输入框；文本节点没有 attrs，直接跳过。 */
function inputs(node: FakeNode, out: FakeNode[] = []): FakeNode[] {
  if (!node || !node.attrs) return out;
  if (node.attrs.id) out.push(node);
  for (const kid of node.children ?? []) inputs(kid, out);
  return out;
}

const weightsOf = (node: FakeNode) => node.attrs.id;

describe('独立模式 动作频率卡', () => {
  test('读取：三项原样带出，缺项回落内置默认', () => {
    const api = probe();
    assert.deepEqual(
      { ...api.pickGlobals({ animationWeights: { idle: 30, turn: 5, move: 5 } }).animationWeights },
      { idle: 30, turn: 5, move: 5 },
    );
    assert.deepEqual({ ...api.pickGlobals({}).animationWeights }, { idle: 10, turn: 5, move: 5 });
  });

  test('四个框顺序固定；改待机时夹取并同步只读的随机动作', () => {
    const api = probe();
    api.state.globals = api.pickGlobals({ animationWeights: { idle: 10, turn: 5, move: 5 } });
    const fields = inputs(api.motionCard()).filter((node) => weightsOf(node).startsWith('g-motion-'));
    assert.deepEqual(
      fields.map((node) => weightsOf(node)),
      ['g-motion-idle', 'g-motion-turn', 'g-motion-move', 'g-motion-action'],
    );
    assert.equal(fields[3].value, '80');
    fields[0].value = '95';
    fields[0].listeners.input();
    assert.deepEqual({ ...api.state.globals.animationWeights }, { idle: 90, turn: 5, move: 5 });
    assert.equal(fields[3].value, '0', '随机动作应随三项重算');
  });

  test('保存体带上 animationWeights', () => {
    const api = probe();
    api.state.globals = api.pickGlobals({});
    api.state.pets = { main: [] };
    assert.deepEqual({ ...api.petsBody().animationWeights }, { idle: 10, turn: 5, move: 5 });
  });
});
