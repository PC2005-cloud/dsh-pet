/**
 * 「显示哪些宠物」勾选卡（src/client/settings/visibility-card.ts）的契约测试。
 *
 * 三条契约：
 *   1. 全部实例各一行（跨种类），勾选态只由 `display` 是否 `none` 决定；
 *   2. 取消勾选回传该实例自己的 id 与 `false`，不会写错到当前选中项；
 *   3. 忙时全部禁用，数量提示按「已显示 / 总数」算。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { makeVisibilityCard } from './visibility-card.ts';
import type { Pet, PetDisplay } from '../../shared/types.ts';

interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;

/** 只给卡片用到的键，其余键原样返回——这样能断言数量提示确实做了插值。 */
const dictionary: Record<string, string> = {
  kindMain: '内置',
  visibleCount: '已显示 {n} / 共 {m} 只',
  'display.web': '仅浏览器',
  'display.both': '两者都显示',
  'display.none': '都不显示',
};
const t = (key: string): string => dictionary[key] ?? key;
const VisibilityCard = makeVisibilityCard({ h, t } as never);

function flatten(node: unknown): Node[] {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  const element = node as Node;
  return [element, ...flatten(element.props?.children)];
}

const text = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (node === null || node === undefined || typeof node !== 'object') return '';
  return text((node as Node).props?.children);
};

const pet = (id: string, display: PetDisplay, assetRoot?: string): Pet => ({
  id,
  name: id,
  size: 300,
  balanceEnabled: false,
  whisperEnabled: false,
  workStatusEnabled: false,
  fixedEnabled: false,
  display,
  position: { corner: 'top-right', marginX: 0, marginY: 0 },
  ...(assetRoot === undefined ? {} : { assetRoot }),
});

const boxes = (tree: unknown): Node[] => flatten(tree).filter((node) => node.tag === 'input');

describe('VisibilityCard —— 显示哪些宠物', () => {
  test('全部实例各一行，勾选态只由 display 是否 none 决定', () => {
    const tree = VisibilityCard({
      pets: [pet('main', 'both', 'main'), pet('chatgpt', 'none', 'chatgpt'), pet('qwen', 'web', 'qwen')],
      busy: false,
      onChange: () => {},
    } as never);
    const found = boxes(tree);
    assert.equal(found.length, 3, '每只实例一个勾选框，不能漏掉角色包里的实例');
    assert.deepEqual(
      found.map((box) => box.props.checked),
      [true, false, true],
      'none 之外（web / desktop / both）都算显示',
    );
  });

  test('取消勾选回传该实例自己的 id 与 false', () => {
    const seen: Array<[string, boolean]> = [];
    const tree = VisibilityCard({
      pets: [pet('main', 'both', 'main'), pet('chatgpt', 'both', 'chatgpt')],
      busy: false,
      onChange: (id: string, visible: boolean) => seen.push([id, visible]),
    } as never);
    for (const box of boxes(tree)) {
      (box.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: false } });
    }
    assert.deepEqual(seen, [
      ['main', false],
      ['chatgpt', false],
    ]);
  });

  test('忙时全部禁用', () => {
    const tree = VisibilityCard({
      pets: [pet('main', 'both', 'main')],
      busy: true,
      onChange: () => {},
    } as never);
    for (const box of boxes(tree)) assert.equal(box.props.disabled, true);
  });

  test('按种类分组，数量提示按已显示 / 总数插值', () => {
    const tree = VisibilityCard({
      pets: [pet('main', 'both', 'main'), pet('chatgpt', 'none', 'chatgpt'), pet('qwen', 'none', 'qwen')],
      busy: false,
      onChange: () => {},
    } as never);
    const body = text(tree);
    assert.ok(body.includes('已显示 1 / 共 3 只'), '数量提示应显示已显示数与总数');
    assert.ok(body.includes('内置'), 'main 种类沿用「内置」的说法');
    assert.ok(body.includes('chatgpt') && body.includes('qwen'), '角色包按目录前缀分组');
  });

  test('空列表只给提示，不渲染勾选框', () => {
    const tree = VisibilityCard({ pets: [], busy: false, onChange: () => {} } as never);
    assert.equal(boxes(tree).length, 0);
    assert.ok(text(tree).includes('emptyPets'), '空列表应回落到现有的空列表提示键');
  });
});
