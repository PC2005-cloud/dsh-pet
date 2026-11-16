/**
 * 「长期记忆」卡的契约测试。
 *
 * 三条契约：
 *   1. 实现下拉的值与选项来自 props，不硬编码 id；
 *   2. PowerContext 的地址、令牌、查询优化只在选中该实现时渲染；
 *   3. 三个控件回传的都是配置字段，不是事件对象。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { POWERCONTEXT_MEMORY_ID } from '../../shared/memory.ts';
import { zh } from './locales/zh.ts';
import { makeMemoryCard, type MemoryCardProps } from './memory-card.ts';

interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
const MemoryCard = makeMemoryCard({ h, t: (key: string) => key } as never);

function flatten(node: unknown): Node[] {
  if (node === null || node === undefined || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  const element = node as Node;
  return [element, ...flatten(element.props?.children)];
}

/** 一张卡的完整输入；未覆盖的字段给固定值。 */
function props(over: Partial<MemoryCardProps> = {}): MemoryCardProps {
  return {
    busy: false,
    provider: 'native',
    providers: [
      { id: 'native', name: '内置记忆' },
      { id: POWERCONTEXT_MEMORY_ID, name: 'PowerContext' },
    ],
    onProviderChange: () => {},
    powercontext: { endpoint: 'http://127.0.0.1:8000', token: 'tk', optimizeQuery: false },
    onPowerContextChange: () => {},
    ...over,
  };
}

/** 密码框＝令牌输入框，它只在选中 PowerContext 时存在。 */
const secrets = (tree: unknown): Node[] =>
  flatten(tree).filter((node) => node.tag === 'input' && node.props.type === 'password');

describe('MemoryCard —— 长期记忆', () => {
  test('下拉的值与选项来自 props，不硬编码 id', () => {
    const tree = MemoryCard(props({ provider: POWERCONTEXT_MEMORY_ID }));
    const select = flatten(tree).find((node) => node.props?.label === 'memoryProviderLabel');
    assert.ok(select, '卡片上要有记忆实现下拉');
    assert.equal(select.props.value, POWERCONTEXT_MEMORY_ID);
    assert.deepEqual(
      (select.props.options as Array<{ id: string }>).map((option) => option.id),
      ['native', POWERCONTEXT_MEMORY_ID],
    );
  });

  test('未选中 PowerContext → 地址、令牌、查询优化整块不渲染', () => {
    const tree = MemoryCard(props());
    assert.equal(secrets(tree).length, 0, '选内置记忆时不该出现令牌输入框');
    const toggle = flatten(tree).find((node) => node.tag === 'input' && node.props.type === 'checkbox');
    assert.equal(toggle, undefined, '查询优化开关也不该出现');
  });

  test('选中 PowerContext → 三项都在，且值来自 props', () => {
    const tree = MemoryCard(props({ provider: POWERCONTEXT_MEMORY_ID }));
    const password = secrets(tree);
    assert.equal(password.length, 1);
    assert.equal(password[0].props.value, 'tk');
    const endpoint = flatten(tree).find(
      (node) => node.tag === 'input' && node.props.type === 'text' && node.props.value === 'http://127.0.0.1:8000',
    );
    assert.ok(endpoint, '地址输入框应该带回成品值');
    const toggle = flatten(tree).find((node) => node.tag === 'input' && node.props.type === 'checkbox');
    assert.equal(toggle?.props.checked, false);
  });

  test('切换实现回传 id，改参数回传对应子键', () => {
    const calls: Array<[string, unknown]> = [];
    const tree = MemoryCard(
      props({
        provider: POWERCONTEXT_MEMORY_ID,
        onProviderChange: (value: string) => calls.push(['provider', value]),
        onPowerContextChange: (patch) => calls.push(['patch', patch]),
      }),
    );
    const select = flatten(tree).find((node) => node.props?.label === 'memoryProviderLabel');
    (select?.props.onChange as (value: string) => void)('native');
    assert.deepEqual(calls[0], ['provider', 'native']);

    const password = secrets(tree)[0];
    (password.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'new-token' } });
    assert.deepEqual(calls[1], ['patch', { token: 'new-token' }]);

    const toggle = flatten(tree).find((node) => node.tag === 'input' && node.props.type === 'checkbox');
    (toggle?.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    assert.deepEqual(calls[2], ['patch', { optimizeQuery: true }]);
  });

  test('忙时全部控件禁用', () => {
    const tree = MemoryCard(props({ busy: true, provider: POWERCONTEXT_MEMORY_ID }));
    for (const node of flatten(tree)) {
      if (node.tag === 'input') assert.equal(node.props.disabled, true);
    }
    const select = flatten(tree).find((node) => node.props?.label === 'memoryProviderLabel');
    assert.equal(select?.props.disabled, true);
  });

  test('渲染时请求的每个文案键都在字典里（缺键会原样显示键名）', () => {
    const missing: string[] = [];
    const SpyCard = makeMemoryCard({
      h,
      t: (key: string) => {
        if (!(key in zh)) missing.push(key);
        return key;
      },
    } as never);
    SpyCard(props({ provider: POWERCONTEXT_MEMORY_ID }));
    assert.deepEqual(missing, []);
  });
});
