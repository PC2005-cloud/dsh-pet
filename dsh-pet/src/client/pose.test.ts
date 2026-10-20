/**
 * 网页端实况注册表（src/client/pose.ts）的单测 —— issue #122 第 1 条。
 *
 * 三条契约：
 *   1. **按需读**：每次调用都重新取值（不是快照），所以走位/抛掷**中途**也能读到；
 *   2. 没注册 / 空 id / 非字符串 → `null`，**绝不抛给第三方**；
 *   3. 同一 id 重新挂载时，旧实例的清理函数**不能**摘掉新读函数（否则口子静默失效）。
 *
 * 用 Node 内置 test runner，不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { poseReaderCount, readPose, registerPose } from './pose.ts';

const pose = (x: number, y: number, facing: 'left' | 'right') => ({ x, y, facing });

describe('registerPose / readPose —— 页面内实况', () => {
  test('注册后能读到当前值，且每次调用都重新取值（按需，不是快照）', () => {
    let x = 0.1;
    const off = registerPose('p1', () => pose(x, 0.2, 'left'));
    assert.deepEqual(readPose('p1'), { x: 0.1, y: 0.2, facing: 'left' });
    x = 0.9; // 模拟走位中途
    assert.deepEqual(readPose('p1'), { x: 0.9, y: 0.2, facing: 'left' }, '按需读：应取到最新值');
    off();
    assert.equal(readPose('p1'), null, '摘除后读不到');
  });

  test('没注册 / 空 id / 非字符串 → null（不抛）', () => {
    assert.equal(readPose('nope'), null);
    assert.equal(readPose(''), null);
    assert.equal(readPose(undefined as unknown as string), null);
    assert.equal(readPose(42 as unknown as string), null);
  });

  test('同一 id 重新挂载：旧清理函数不能摘掉新读函数', () => {
    const off1 = registerPose('p2', () => pose(0, 0, 'left'));
    const off2 = registerPose('p2', () => pose(1, 1, 'right'));
    off1(); // 旧实例卸载（晚于新实例挂载）
    assert.deepEqual(readPose('p2'), { x: 1, y: 1, facing: 'right' }, '新读函数必须还在');
    off2();
    assert.equal(readPose('p2'), null);
  });

  test('清理函数重复调用无害，注册数不泄漏', () => {
    const before = poseReaderCount();
    const off = registerPose('p3', () => pose(0, 0, 'left'));
    assert.equal(poseReaderCount(), before + 1);
    off();
    off();
    assert.equal(poseReaderCount(), before);
  });
});
