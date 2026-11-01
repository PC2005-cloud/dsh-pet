/**
 * 快捷键卡的契约：五行都在、键位取自真源、改绑后跟着变，且与页尾参考卡一样是折叠卡。
 *
 * 这张卡唯一的价值就是「键位只有一处真源」——悬停键读共享常量，全局键读 DSH 的目录。
 * 哪天有人把键位写死，这里的断言就会红。
 *
 * 跑法：node --experimental-strip-types --test src/client/settings/shortcuts-card.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { HEAR_HOTKEY_HINT } from '../../shared/chat/hear-hold.ts';
import { CAPTURE_HOTKEY_HINT, CHAT_HOTKEY_HINT } from '../../shared/chat/hotkey.ts';
import { SLEEP_HOTKEY_HINT } from '../../shared/sleep-hotkey.ts';
import { TODO_HOTKEY_HINT } from '../../shared/todo/hotkey.ts';
import { keycapOf, type ShortcutHost } from '../app-shortcut.ts';
import { makeShortcutsCard } from './shortcuts-card.ts';

/** 节点桩：`h` 只把 tag 与 props 收集起来，不渲染。 */
interface Node {
  tag: string;
  props: Record<string, unknown>;
}

/** 目录行：服务按平台展开好的键帽片段。 */
type Row = { id: string; keys: string[] };

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
/** 假 useState：初始值原样收下，setter 只吞掉调用。 */
const useState = ((init: unknown) => [init, () => {}]) as never;
/** 假 useEffect：不在测试里挂订阅，只要求它存在。 */
const useEffect = (() => {}) as never;

/** 假上下文：目录内容由用例给。 */
function makeCtx(rows: Row[]): ShortcutHost {
  return {
    get: () => ({
      catalog: {
        getSnapshot: () => rows,
        subscribe: () => () => {},
      },
    }),
  };
}

/** 四条命令被改绑后的样子：键帽里出现的字母都不是默认值。 */
const REBOUND: Row[] = [
  { id: 'pet-chat.open', keys: ['Ctrl', '+', 'Alt', '+', 'J'] },
  { id: 'pet-chat.float', keys: ['Ctrl', '+', 'Alt', '+', 'K'] },
  { id: 'pet-chat.hear', keys: ['Ctrl', '+', 'Alt', '+', 'H'] },
  { id: 'pet-chat.capture', keys: ['Ctrl', '+', 'Alt', '+', 'Y'] },
];

/** 默认组合：目录里没有这一行时的兜底文案。 */
const CHAT_DEFAULT = keycapOf({ code: 'KeyP', modifiers: ['primary', 'shift'] });
const FLOAT_DEFAULT = keycapOf({ code: 'KeyL', modifiers: ['primary', 'shift'] });
const HEAR_DEFAULT = keycapOf({ code: 'KeyM', modifiers: ['primary', 'shift'] });
const CAPTURE_DEFAULT = keycapOf({ code: 'KeyS', modifiers: ['primary', 'shift'] });

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

/** 按给定目录渲染一次整张卡。 */
function render(rows: Row[] = []): unknown {
  const Card = makeShortcutsCard({ h, t: (key: string) => key, useState, useEffect } as never, makeCtx(rows));
  return Card({});
}

describe('ShortcutsCard —— 快捷键卡', () => {
  test('全局那组跟着目录走：改绑后显示改绑后的键', () => {
    const text = texts(render(REBOUND)).join('\n');
    assert.ok(text.includes('Ctrl+Alt+K'), '打开对话用改绑后的键');
    assert.ok(text.includes('Ctrl+Alt+H'), '语音输入用改绑后的键');
    assert.ok(text.includes('Ctrl+Alt+Y'), '截图用改绑后的键');
    assert.ok(text.includes('Ctrl+Alt+J'), '侧栏对话用改绑后的键');
  });

  test('没改绑 → 全局那组显示默认组合', () => {
    const text = texts(render()).join('\n');
    assert.ok(text.includes(FLOAT_DEFAULT), '打开对话');
    assert.ok(text.includes(HEAR_DEFAULT), '语音输入');
    assert.ok(text.includes(CAPTURE_DEFAULT), '截图');
    assert.ok(text.includes(CHAT_DEFAULT), '侧栏对话');
  });

  test('悬停那组读共享常量，且不受改绑影响', () => {
    const text = texts(render(REBOUND)).join('\n');
    assert.ok(text.includes(CHAT_HOTKEY_HINT), '打开对话');
    assert.ok(text.includes(HEAR_HOTKEY_HINT), '按住说话');
    assert.ok(text.includes(CAPTURE_HOTKEY_HINT), '截图');
    assert.ok(text.includes(TODO_HOTKEY_HINT), '待办');
    assert.ok(text.includes(SLEEP_HOTKEY_HINT), '睡觉');
  });

  test('两组标题与说明、以及全部行标签都在', () => {
    const text = texts(render()).join('\n');
    for (const key of [
      'shortcutGroupPet',
      'shortcutGroupPetHint',
      'shortcutGroupGlobal',
      'shortcutGroupGlobalHint',
      'shortcutRowChat',
      'shortcutRowHold',
      'shortcutRowHear',
      'shortcutRowCapture',
      'shortcutRowPaste',
      'shortcutRowTodo',
      'shortcutRowSleep',
      'shortcutRowDisplay',
      'shortcutRowSidebar',
    ]) {
      assert.ok(text.includes(key), key + ' 应该出现');
    }
  });

  test('是折叠卡，默认收起（与页尾两张参考卡同一套骨架）', () => {
    const all = nodes(render());
    const card = all.find((node) => String(node.props?.className ?? '').includes('dsh-pet-cfg__card'));
    assert.ok(String(card?.props?.className).includes('is-fold'), '应该是折叠卡');
    assert.ok(!String(card?.props?.className).includes('is-open'), '默认不该展开');
    const toggle = all.find((node) => String(node.props?.className ?? '').includes('dsh-pet-cfg__foldToggle'));
    assert.equal(toggle?.props?.['aria-expanded'], false);
    assert.equal(toggle?.props?.['aria-controls'], 'pet-cfg-shortcuts');
  });

  test('标题是卡片头文本，说明挂在问号气泡上', () => {
    const tree = render();
    assert.ok(texts(tree).join('\n').includes('shortcutCardTitle'), '标题应该在文本里');
    assert.ok(tips(tree).includes('shortcutCardHint'), '说明应该挂在 data-tip 上');
  });
});
