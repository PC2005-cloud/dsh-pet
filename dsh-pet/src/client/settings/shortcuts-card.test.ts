/**
 * 快捷键卡的契约：五行都在，且键位取自各自模块的常量而不是另写一份。
 *
 * 这张卡唯一的价值就是「键位只有一处真源」——所以断言直接引用那些常量，
 * 哪天有人改了键位却把卡片写死，这里就会红。
 *
 * 跑法：node --experimental-strip-types --test src/client/settings/shortcuts-card.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { HEAR_HOTKEY_HINT } from '../../shared/chat/hear-hold.ts';
import { CHAT_HOTKEY_HINT } from '../../shared/chat/hotkey.ts';
import { SLEEP_HOTKEY_HINT } from '../../shared/sleep-hotkey.ts';
import { TODO_HOTKEY_HINT } from '../../shared/todo/hotkey.ts';
import { PET_CHAT_SHORTCUT_HINT } from '../chat/shortcut.ts';
import { PET_FLOAT_SHORTCUT_HINT, PET_HEAR_SHORTCUT_HINT } from '../pet/card/shortcut.ts';
import { makeShortcutsCard } from './shortcuts-card.ts';

/** 节点桩：`h` 只把 tag 与 props 收集起来，不渲染。 */
interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
/** 假 useState：开合态固定为收起，setter 只吞掉调用。 */
const useState = ((init: unknown) => [init, () => {}]) as never;
/** 翻译桩：直接回键名，断言据此确认「用的是哪个键」。 */
const ShortcutsCard = makeShortcutsCard({ h, t: (key: string) => key, useState } as never);

/** 摊平节点树，把所有文本片段收成数组。 */
function texts(node: unknown): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts((node as Node).props?.children);
}

/** 摊平节点树，收集所有 `data-tip`（问号气泡的内容不在文本里）。 */
function tips(node: unknown): string[] {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(tips);
  const element = node as Node;
  const tip = element.props?.['data-tip'];
  return [...(typeof tip === 'string' ? [tip] : []), ...tips(element.props?.children)];
}

/** 摊平节点树，收集所有元素节点。 */
function nodes(node: unknown): Node[] {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  const element = node as Node;
  return [element, ...nodes(element.props?.children)];
}

/** 整张卡渲染出来的纯文本。 */
const rendered = (): string => texts(ShortcutsCard({})).join('\n');

describe('ShortcutsCard —— 快捷键卡', () => {
  test('键位取自各自模块的常量，不另写一份', () => {
    const text = rendered();
    assert.ok(text.includes(CHAT_HOTKEY_HINT + ' · ' + PET_FLOAT_SHORTCUT_HINT), '打开对话那行');
    assert.ok(text.includes(HEAR_HOTKEY_HINT + ' · ' + PET_HEAR_SHORTCUT_HINT), '语音输入那行');
    assert.ok(text.includes(TODO_HOTKEY_HINT), '待办那行');
    assert.ok(text.includes(SLEEP_HOTKEY_HINT), '睡觉那行');
    assert.ok(text.includes(PET_CHAT_SHORTCUT_HINT), '侧栏对话那行');
  });

  test('五个动作标签与注意事项都在', () => {
    const text = rendered();
    for (const key of [
      'shortcutRowChat',
      'shortcutRowHear',
      'shortcutRowTodo',
      'shortcutRowSleep',
      'shortcutRowSidebar',
      'shortcutNoteDesktop',
    ]) {
      assert.ok(text.includes(key), key + ' 应该出现');
    }
  });

  test('是折叠卡，默认收起（与页尾两张参考卡同一套骨架）', () => {
    const tree = ShortcutsCard({});
    const all = nodes(tree);
    const card = all.find((node) => String(node.props?.className ?? '').includes('dsh-pet-cfg__card'));
    assert.ok(String(card?.props?.className).includes('is-fold'), '应该是折叠卡');
    assert.ok(!String(card?.props?.className).includes('is-open'), '默认不该展开');
    const toggle = all.find((node) => String(node.props?.className ?? '').includes('dsh-pet-cfg__foldToggle'));
    assert.equal(toggle?.props?.['aria-expanded'], false);
    assert.equal(toggle?.props?.['aria-controls'], 'pet-cfg-shortcuts');
  });

  test('标题是卡片头文本，说明挂在问号气泡上', () => {
    const tree = ShortcutsCard({});
    assert.ok(texts(tree).join('\n').includes('shortcutCardTitle'), '标题应该在文本里');
    assert.ok(tips(tree).includes('shortcutCardHint'), '说明应该挂在 data-tip 上');
  });
});
