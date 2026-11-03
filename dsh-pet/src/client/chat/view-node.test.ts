/**
 * 面板工具栏与输入区的契约测试：新增的「记忆线」「刷新」入口，以及生成中的灰化 + 转圈。
 *
 * 用假 `h` 把节点记成 `{ tag, props }` 树，断言的是渲染出来的形状与回调接线，不启动 react。
 * 跑法：node --experimental-strip-types --test src/client/chat/view-node.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChatPanelRuntime } from './runtime.ts';
import type { ChatPanelState } from './types.ts';
import { composerNode, toolsNode } from './view-node.ts';

/** 假节点：`h` 只记录标签与属性。 */
interface Node {
  readonly tag: unknown;
  readonly props: Record<string, unknown>;
}

const h = ((tag: unknown, props?: Record<string, unknown> | null): Node => ({
  tag,
  props: props ?? {},
})) as unknown as ChatPanelRuntime['h'];

/** 深度遍历节点树（children 可能是数组、单个节点或文本）。 */
function walk(node: unknown, visit: (one: Node) => void): void {
  if (node === null || typeof node !== 'object') return;
  const one = node as Node;
  visit(one);
  const children = one.props.children;
  if (Array.isArray(children)) {
    for (const child of children) walk(child, visit);
    return;
  }
  walk(children, visit);
}

/** 按按钮文案找元素；找不到返回 undefined。 */
function buttonByText(root: unknown, text: string): Node | undefined {
  let found: Node | undefined;
  walk(root, (one) => {
    if (one.tag === 'button' && one.props.children === text) found = one;
  });
  return found;
}

/** 按 class 找元素；找不到返回 undefined。 */
function byClass(root: unknown, className: string): Node | undefined {
  let found: Node | undefined;
  walk(root, (one) => {
    if (one.props.className === className) found = one;
  });
  return found;
}

/** 造一份够渲染的最小状态；动作默认是空实现，需要断言时再覆盖。 */
function stateOf(overrides: Partial<ChatPanelState> = {}): ChatPanelState {
  return {
    pets: [],
    petId: 'main',
    messages: [],
    draft: '',
    attachment: undefined,
    busy: false,
    loading: false,
    error: '',
    selected: [],
    selecting: false,
    orphans: [],
    pending: null,
    visibleRounds: 10,
    previewUrl: undefined,
    roundsByEntry: {},
    personas: {},
    personaOpen: false,
    speaking: null,
    rounds: [],
    hasOlder: false,
    petName: '鲸鲸',
    assetRoot: '',
    memoryRounds: 5,
    hasMemoryLine: true,
    persona: '',
    onDraftKeyDown: () => {},
    onDraftCompositionStart: () => {},
    onDraftCompositionEnd: () => {},
    ...overrides,
  } as unknown as ChatPanelState;
}

describe('toolsNode —— 记忆线与刷新入口', () => {
  test('配了记忆轮数 → 出现「记忆线」，点击走 jumpToMemory', () => {
    let jumped = 0;
    const node = toolsNode(h, stateOf({ jumpToMemory: () => (jumped += 1) }));
    const line = buttonByText(node, '记忆线');
    assert.ok(line !== undefined, '工具栏应有「记忆线」按钮');
    assert.equal(line?.props.disabled, false, '有分界线时按钮可用');
    (line?.props.onClick as () => void)();
    assert.equal(jumped, 1, '点击应触发跳转');
  });

  test('历史没超过记忆轮数 → 「记忆线」置灰（没有线可跳）', () => {
    const node = toolsNode(h, stateOf({ hasMemoryLine: false }));
    assert.equal(buttonByText(node, '记忆线')?.props.disabled, true);
  });

  test('配置里没有记忆轮数 → 不出现「记忆线」（本就不画线）', () => {
    const node = toolsNode(h, stateOf({ memoryRounds: undefined, hasMemoryLine: false }));
    assert.equal(buttonByText(node, '记忆线'), undefined);
  });

  test('「刷新」始终在，点击走 refresh', () => {
    let refreshed = 0;
    const node = toolsNode(h, stateOf({ memoryRounds: undefined, refresh: () => (refreshed += 1) }));
    const button = buttonByText(node, '刷新');
    assert.ok(button !== undefined, '工具栏应有「刷新」按钮');
    (button?.props.onClick as () => void)();
    assert.equal(refreshed, 1);
  });
});

describe('composerNode —— 生成中的灰化与转圈', () => {
  test('busy → 容器带 is-busy 与 aria-busy，发送键换成转圈', () => {
    const node = composerNode(h, stateOf({ busy: true }));
    const composer = node as Node;
    assert.match(String(composer.props.className), /is-busy/);
    assert.equal(composer.props['aria-busy'], 'true');

    const spinner = byClass(node, 'pet-chat-send-spinner');
    assert.ok(spinner !== undefined, '生成中应渲染转圈节点');
    assert.equal(spinner?.tag, 'span');
    const send = byClass(node, 'pet-chat-send is-busy');
    assert.equal(send?.props.disabled, true, '生成中发送键应禁用');
  });

  test('非 busy → 没有灰化与转圈，发送键是可点的箭头', () => {
    const node = composerNode(h, stateOf({ busy: false }));
    const composer = node as Node;
    assert.doesNotMatch(String(composer.props.className), /is-busy/);
    assert.equal(byClass(node, 'pet-chat-send-spinner'), undefined);
    const send = byClass(node, 'pet-chat-send');
    assert.equal(send?.props.disabled, false);
    assert.equal((send?.props.children as Node).tag, 'svg', '空闲时是箭头图标');
  });
});

describe('composerNode —— 回车发送要让开输入法', () => {
  test('输入框接上了组合事件与按键处理器', () => {
    const area = byClass(composerNode(h, stateOf()), 'pet-chat-input');
    assert.ok(area !== undefined, '应有输入框');
    assert.equal(typeof area?.props.onKeyDown, 'function');
    assert.equal(typeof area?.props.onCompositionStart, 'function');
    assert.equal(typeof area?.props.onCompositionEnd, 'function');
  });

  test('三个处理器原样转给 state（判定在 enter，发送在 state）', () => {
    const calls: string[] = [];
    const node = composerNode(
      h,
      stateOf({
        onDraftKeyDown: () => calls.push('keydown'),
        onDraftCompositionStart: () => calls.push('start'),
        onDraftCompositionEnd: () => calls.push('end'),
      }),
    );
    const area = byClass(node, 'pet-chat-input');
    const keydown = area?.props.onKeyDown as (e: unknown) => void;
    keydown({ key: 'Enter', shiftKey: false, preventDefault: () => {} });
    (area?.props.onCompositionStart as () => void)();
    (area?.props.onCompositionEnd as () => void)();
    assert.deepEqual(calls, ['keydown', 'start', 'end']);
  });
});
