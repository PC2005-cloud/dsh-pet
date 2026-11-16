/**
 * 「AI 模型与对话上下文」卡（src/client/settings/model-card.ts）的契约测试。
 *
 * 三条契约：
 *   1. 三个对话开关的勾选态来自 `values`，切换回传的是配置字段名（键名错位会静默写坏别的开关）；
 *   2. 忙时全部控件禁用，模型选择器也拿到同一个 busy；
 *   3. PowerContext 的地址与令牌只在选中该实现时渲染。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { POWERCONTEXT_MEMORY_ID } from '../../shared/memory.ts';
import { makeModelCard, type ChatFlagValues } from './model-card.ts';

interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
/** 模型选择器替身：只把 props 原样挂出来，方便断言 busy 传到了。 */
const Picker = ((props: Record<string, unknown>) => ({ tag: 'select', props })) as never;
const ModelCard = makeModelCard({ h, t: (key: string) => key } as never, Picker);

function flatten(node: unknown): Node[] {
  if (node === null || node === undefined || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  const element = node as Node;
  return [element, ...flatten(element.props?.children)];
}

const allOff: ChatFlagValues = {
  whisperImageEnabled: false,
  chatImageEnabled: false,
  chatAnimationEnabled: false,
};

/** 三个对话开关的框：数字输入的 props 里没有 checked，据此区分。 */
const toggles = (tree: unknown): Node[] =>
  flatten(tree).filter((node) => node.tag === 'input' && node.props.checked !== undefined);

/** 一张卡的完整输入；未覆盖的字段给固定值。 */
function props(values: ChatFlagValues, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    busy: false,
    catalog: null,
    failed: false,
    whisperModel: { kind: 'follow' },
    chatModel: { kind: 'follow' },
    onModelChange: () => {},
    chatMemory: 6,
    chatImageLimit: 10,
    onChatMemoryChange: () => {},
    onChatImageLimitChange: () => {},
    memoryProvider: 'native',
    memoryProviders: [{ id: 'native', name: '内置记忆' }],
    onMemoryProviderChange: () => {},
    powercontext: { endpoint: '', token: '' },
    onPowerContextChange: () => {},
    values,
    onFlagChange: () => {},
    ...over,
  };
}

describe('ModelCard —— 对话开关', () => {
  test('三个开关都在，勾选态来自 values', () => {
    const tree = ModelCard(
      props({ whisperImageEnabled: true, chatImageEnabled: false, chatAnimationEnabled: true }) as never,
    );
    const found = toggles(tree);
    assert.equal(found.length, 3, '应该有三个对话开关');
    assert.deepEqual(
      found.map((box) => box.props.checked),
      [true, false, true],
    );
  });

  test('每个开关回传自己的配置字段名', () => {
    const seen: Array<[string, boolean]> = [];
    const tree = ModelCard(
      props(allOff, { onFlagChange: (key: string, value: boolean) => seen.push([key, value]) }) as never,
    );
    for (const box of toggles(tree)) {
      (box.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    }
    assert.deepEqual(
      seen.map(([key]) => key),
      ['whisperImageEnabled', 'chatImageEnabled', 'chatAnimationEnabled'],
    );
    assert.ok(
      seen.every(([, value]) => value === true),
      '回传的必须是布尔值，不是事件对象',
    );
  });

  test('忙时开关与选择器全部禁用', () => {
    const tree = ModelCard(props(allOff, { busy: true }) as never);
    for (const box of toggles(tree)) assert.equal(box.props.disabled, true);
    // 选择器本身是组件，h 不会展开它：按组件引用找那两个格子。
    const pickers = flatten(tree).filter((node) => (node.tag as unknown) === Picker);
    assert.equal(pickers.length, 2, '两个模型格子各有一个选择器');
    for (const picker of pickers) assert.equal(picker.props.disabled, true);
  });
});

describe('ModelCard —— 长期记忆实现', () => {
  test('下拉的值与选项来自 props，不硬编码 id', () => {
    const tree = ModelCard(
      props(allOff, {
        memoryProvider: 'pc',
        memoryProviders: [
          { id: 'native', name: '内置记忆' },
          { id: 'pc', name: 'PowerContext' },
        ],
      }) as never,
    );
    const select = flatten(tree).find((node) => node.props?.label === 'memoryProviderLabel');
    assert.ok(select, '卡片上要有记忆实现下拉');
    assert.equal(select.props.value, 'pc');
    assert.deepEqual(
      (select.props.options as Array<{ id: string }>).map((option) => option.id),
      ['native', 'pc'],
    );
  });

  test('未选中 PowerContext 时不渲染地址与令牌输入框', () => {
    const secrets = flatten(ModelCard(props(allOff) as never)).filter(
      (node) => node.tag === 'input' && node.props.type === 'password',
    );
    assert.equal(secrets.length, 0, '选内置记忆时不该出现令牌输入框');
  });

  test('选中 PowerContext 时渲染地址与令牌，值来自 props', () => {
    const tree = ModelCard(
      props(allOff, {
        memoryProvider: POWERCONTEXT_MEMORY_ID,
        powercontext: { endpoint: 'http://127.0.0.1:8000', token: 'tk' },
      }) as never,
    );
    const password = flatten(tree).find((node) => node.tag === 'input' && node.props.type === 'password');
    assert.ok(password, '令牌输入框应该出现');
    assert.equal(password.props.value, 'tk');
    const endpoint = flatten(tree).find(
      (node) => node.tag === 'input' && node.props.type === 'text' && node.props.value === 'http://127.0.0.1:8000',
    );
    assert.ok(endpoint, '地址输入框应该出现且带回成品值');
  });
});
