/**
 * 有丝分裂的菜单构建（src/client/pet/mitosis/menu.ts）的契约测试。
 *
 * 钉住两件事：文案只随 mode 与 cloneCount 变，条数恒定（切模式不会让菜单位置跳动）；
 * 四条动作名与 shared/menu 的叶子词汇表一致，且分支节点只带 children 不带 action。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { cloneBranch, mainBranch } from './menu.ts';
import type { MenuBranch, MenuLeaf } from '../../../shared/menu.ts';

/** 取「模式」那条分支的子项。 */
const modeChildren = (mode: 'normal' | 'collide', count: number): MenuLeaf[] => {
  const branch = mainBranch(mode, count)[1] as MenuBranch;
  assert.equal(branch.label, '模式');
  return branch.children as MenuLeaf[];
};

describe('mainBranch —— 本体尾部两条', () => {
  test('条数恒为 2：有无分身、哪种模式都一样', () => {
    assert.equal(mainBranch('normal', 0).length, 2);
    assert.equal(mainBranch('collide', 30).length, 2);
  });

  test('清除项带上当前的分身只数，没有时写「暂无」而不是消失', () => {
    const [withClones] = mainBranch('normal', 3) as MenuLeaf[];
    const [empty] = mainBranch('normal', 0) as MenuLeaf[];
    assert.equal(withClones.action, 'mitosis-clear');
    assert.equal(withClones.label, '清除所有分裂体（3 只）');
    assert.equal(empty.label, '清除所有分裂体（暂无）');
  });

  test('模式两条：上限写进文案，当前那条带「（当前）」', () => {
    const items = modeChildren('collide', 0);
    assert.deepEqual(
      items.map((i) => i.action),
      ['mitosis-normal', 'mitosis-collide'],
    );
    assert.equal(items[0]?.label, '普通模式 · 上限 64');
    assert.equal(items[1]?.label, '碰撞模式 · 上限 32 · 互撞（当前）');
  });

  test('换一种模式只是「（当前）」换了个位置：条数与其余文案不变', () => {
    const normal = modeChildren('normal', 0);
    const collide = modeChildren('collide', 0);
    assert.equal(normal.length, collide.length);
    assert.equal(normal[0]?.label, '普通模式 · 上限 64（当前）');
    assert.equal(collide[0]?.label, normal[0]?.label.replace('（当前）', ''));
  });

  test('模式分支自己不可点：只有 children，没有 action', () => {
    const branch = mainBranch('normal', 0)[1] as MenuBranch;
    assert.equal('action' in branch, false);
    assert.ok(Array.isArray(branch.children) && branch.children.length === 2);
  });
});

describe('cloneBranch —— 分身只有一条', () => {
  test('删除我：动作是 mitosis-delete', () => {
    const [leaf] = cloneBranch() as MenuLeaf[];
    assert.equal(cloneBranch().length, 1);
    assert.equal(leaf.label, '删除我');
    assert.equal(leaf.action, 'mitosis-delete');
  });
});
