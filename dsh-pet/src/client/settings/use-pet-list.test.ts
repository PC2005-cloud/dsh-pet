/**
 * 种类归纳（groupPetsByKind / petKinds）的契约测试。
 *
 * 三条契约：
 *   1. 按首次出现顺序分组，`groupPetsByKind` 保留所属种类的全部实例；
 *   2. `petKinds` 在分组之上统计每种有多少只实例（标签上的括注）；
 *   3. 没有 `assetRoot` 的实例算 main —— 老数据 / 容器拍平缺字段时不能凭空造出一个种类。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { groupPetsByKind, mainPetsOf, petKinds } from './use-pet-list.ts';
import type { Pet } from '../../shared/types.ts';

/** 一只最小实例；`assetRoot` 省略时模拟「没打标的实例」。 */
const pet = (id: string, assetRoot?: string): Pet => ({
  id,
  name: id,
  size: 300,
  balanceEnabled: false,
  whisperEnabled: false,
  workStatusEnabled: false,
  fixedEnabled: false,
  display: 'web',
  position: { corner: 'top-right', marginX: 0, marginY: 0 },
  ...(assetRoot === undefined ? {} : { assetRoot }),
});

describe('groupPetsByKind —— 实例列表 → 分组', () => {
  test('按首次出现顺序分组，每组保留自己的实例', () => {
    const groups = groupPetsByKind([pet('m1', 'main'), pet('d1', 'daily'), pet('d2', 'daily'), pet('f1', 'festival')]);
    assert.deepEqual(
      groups.map((group) => [group.entry, group.kind, group.pets.map((item) => item.id)]),
      [
        ['main', 'main', ['m1']],
        ['daily', 'pack', ['d1', 'd2']],
        ['festival', 'pack', ['f1']],
      ],
    );
  });

  test('没有 assetRoot 的实例归到 main', () => {
    const groups = groupPetsByKind([pet('x1')]);
    assert.deepEqual(
      groups.map((group) => [group.entry, group.pets.map((item) => item.id)]),
      [['main', ['x1']]],
    );
  });

  test('空列表：没有分组', () => {
    assert.deepEqual(groupPetsByKind([]), []);
  });
});

describe('petKinds —— 实例列表 → 种类条', () => {
  test('按首次出现顺序去重，并统计每种的实例数', () => {
    assert.deepEqual(petKinds([pet('m1', 'main'), pet('d1', 'daily'), pet('d2', 'daily'), pet('f1', 'festival')]), [
      { entry: 'main', kind: 'main', count: 1 },
      { entry: 'daily', kind: 'pack', count: 2 },
      { entry: 'festival', kind: 'pack', count: 1 },
    ]);
  });

  test('没有 assetRoot 的实例归到 main', () => {
    assert.deepEqual(petKinds([pet('x1')]), [{ entry: 'main', kind: 'main', count: 1 }]);
  });

  test('空列表：没有种类', () => {
    assert.deepEqual(petKinds([]), []);
  });
});

describe('mainPetsOf —— PUT /config 的提交内容', () => {
  test('只留 main 层实例：pack 实例不得进用户主配置', () => {
    const pets = [pet('m1', 'main'), pet('d1', 'daily'), pet('f1', 'festival'), pet('x1')];
    assert.deepEqual(
      mainPetsOf(pets).map((item) => item.id),
      ['m1', 'x1'],
      '没有 assetRoot 的老实例算 main，pack 实例必须排除',
    );
  });
});
