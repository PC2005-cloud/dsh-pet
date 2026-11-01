/**
 * 宠物配置卡（src/client/settings/pet-card.ts）的契约测试。
 *
 * 三条契约：
 *   1. 选中宠物为空时只显示「暂无宠物」提示，不渲染半张表单；
 *   2. 每个控件都改自己那个字段：名字 / 大小走顶层，角落 / 偏移走 position 子补丁（错位会静默写坏配置）；
 *   3. 表单忙时全部控件禁用，保存结果就近显示在卡片右上角。
 *
 * 用假的 `h` 记录节点树（不引 jsdom）；两个下拉是自绘组件，节点上直接存 `value` 与 `onChange(id)`。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { jsx } from 'react/jsx-runtime';

import { makePetCard, type PetPatch } from './pet-card.ts';
import { PET_DISPLAYS } from '../../shared/config.ts';
import type { Pet } from '../../shared/types.ts';

interface Node {
  tag: string;
  props: Record<string, unknown>;
}

const h = ((tag: unknown, props: Record<string, unknown>) => ({ tag, props })) as unknown as typeof jsx;
/** 假 runtime：hook 只在组件体内被调用，这里只需能返回初值、能装 ref。 */
const rt = {
  h,
  t: (key: string) => key,
  useState: <T>(init: T) => [init, () => {}] as [T, (next: T) => void],
  useEffect: () => {},
  useRef: <T>(init: T) => ({ current: init }),
};
const PetCard = makePetCard(rt as never);

/** 摊平整棵树。 */
function flatten(node: unknown): Node[] {
  if (node === null || node === undefined || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  const element = node as Node;
  return [element, ...flatten(element.props?.children)];
}

const pet = {
  id: 'pet-1',
  name: '小桌宠',
  size: 260,
  display: 'both',
  balanceEnabled: true,
  whisperEnabled: false,
  workStatusEnabled: true,
  fixedEnabled: false,
  position: { corner: 'bottom-left', marginX: 40, marginY: 60 },
  whisperPrompt: '你是一只猫',
} as unknown as Pet;

/** 按标签 + 值找控件，避免依赖节点顺序。 */
function control(tree: unknown, tag: string, match: (props: Record<string, unknown>) => boolean): Node {
  const found = flatten(tree).find((node) => node.tag === tag && match(node.props));
  assert.ok(found, `没找到满足条件的 ${tag}`);
  return found;
}

/** 按当前值找下拉：下拉节点带 `options` 数组，值直接挂在 props 上。 */
function picker(tree: unknown, value: string): Node {
  const found = flatten(tree).find((node) => node.props.value === value && Array.isArray(node.props.options));
  assert.ok(found, `没找到当前值为 ${value} 的下拉`);
  return found;
}

const render = (onChange: (patch: PetPatch) => void, extra: Record<string, unknown> = {}) =>
  PetCard({ pet, busy: false, msg: { kind: '', text: '' }, entryPrompt: '条目人设', onChange, ...extra } as never);

describe('PetCard —— 宠物配置卡', () => {
  test('没有选中宠物：只给「暂无宠物」提示', () => {
    const tree = PetCard({
      pet: null,
      busy: false,
      msg: { kind: '', text: '' },
      entryPrompt: '',
      onChange: () => {},
      onSave: () => {},
      onRemove: () => {},
    } as never);
    assert.equal(flatten(tree).length, 1);
    assert.equal(flatten(tree)[0].props.children, 'emptyPets');
  });

  test('名字与大小走顶层字段', () => {
    const patches: PetPatch[] = [];
    const tree = render((patch) => patches.push(patch));
    const name = control(tree, 'input', (props) => props.value === '小桌宠');
    (name.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '新名字' } });
    // 数字框非受控：失焦才提交，删空时不会被写回。
    const size = control(tree, 'input', (props) => props.defaultValue === '260');
    (size.props.onBlur as (e: { target: { value: string } }) => void)({ target: { value: '300' } });
    assert.deepEqual(patches, [{ name: '新名字' }, { size: 300 }]);
  });

  test('百分比输入：空框失焦不回写，有新值才提交', () => {
    const patches: PetPatch[] = [];
    const tree = render((patch) => patches.push(patch));
    const percent = control(tree, 'input', (props) => props.min === '1' && props.step === '1');
    assert.equal(percent.props.defaultValue, '20', '没配时按默认 20 显示');
    const fire = percent.props.onBlur as (e: { target: { value: string } }) => void;
    fire({ target: { value: '  ' } });
    assert.deepEqual(patches, [], '空框失焦 = 放弃这次编辑');
    fire({ target: { value: '30' } });
    assert.deepEqual(patches, [{ sizePercent: 30 }]);
  });

  test('显示位置下拉：改的是顶层 display', () => {
    const patches: PetPatch[] = [];
    const tree = render((patch) => patches.push(patch));
    const display = picker(tree, 'both');
    assert.deepEqual(
      (display.props.options as { id: string }[]).map((option) => option.id),
      [...PET_DISPLAYS],
      '选项来自 PET_DISPLAYS，文案由 t 提供',
    );
    (display.props.onChange as (id: string) => void)('desktop');
    assert.deepEqual(patches, [{ display: 'desktop' }]);
  });

  test('角落与两个偏移走 position 子补丁', () => {
    const patches: PetPatch[] = [];
    const tree = render((patch) => patches.push(patch));
    const corner = picker(tree, 'bottom-left');
    (corner.props.onChange as (id: string) => void)('top-right');
    const marginX = control(tree, 'input', (props) => props.defaultValue === '40');
    (marginX.props.onBlur as (e: { target: { value: string } }) => void)({ target: { value: '12' } });
    const marginY = control(tree, 'input', (props) => props.defaultValue === '60');
    (marginY.props.onBlur as (e: { target: { value: string } }) => void)({ target: { value: '34' } });
    assert.deepEqual(patches, [
      { position: { corner: 'top-right' } },
      { position: { marginX: 12 } },
      { position: { marginY: 34 } },
    ]);
  });

  test('四个功能开关各自回传自己的键', () => {
    const patches: PetPatch[] = [];
    const tree = render((patch) => patches.push(patch));
    const checkboxes = flatten(tree).filter((node) => node.tag === 'input' && node.props.type === 'checkbox');
    assert.equal(checkboxes.length, 4);
    for (const box of checkboxes) {
      (box.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    }
    assert.deepEqual(patches, [
      { balanceEnabled: true },
      { whisperEnabled: true },
      { workStatusEnabled: true },
      { fixedEnabled: true },
    ]);
  });

  test('人设：回显当前值、占位符用条目人设、右下角显示字数', () => {
    const tree = render(() => {});
    const area = control(tree, 'textarea', () => true);
    assert.equal(area.props.value, '你是一只猫');
    assert.equal(area.props.placeholder, '条目人设');
    assert.ok(flatten(tree).some((node) => node.props.children === 'personaCount'));
  });

  test('忙时全部控件禁用；保存结果就近显示', () => {
    const tree = PetCard({
      pet,
      busy: true,
      msg: { kind: 'err', text: '保存失败' },
      entryPrompt: '',
      onChange: () => {},
      onSave: () => {},
      onRemove: () => {},
    } as never);
    const controls = flatten(tree).filter((node) => node.tag === 'input' || node.tag === 'textarea');
    assert.ok(controls.length > 0);
    for (const node of controls) assert.equal(node.props.disabled, true, `${node.tag} 应被禁用`);
    const pickers = flatten(tree).filter((node) => Array.isArray(node.props.options));
    assert.equal(pickers.length, 2, '显示位置与角落两个下拉都要渲染');
    for (const node of pickers) assert.equal(node.props.disabled, true, '下拉应被禁用');
    assert.ok(
      flatten(tree).some(
        (node) => node.props.children === '保存失败' && String(node.props.className).includes('is-err'),
      ),
      '错误反馈要带 is-err（红字）',
    );
  });
});
