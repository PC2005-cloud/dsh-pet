/**
 * 全局快捷键「对哪只宠物动手」的契约：优先主条目、主条目缺席时退化、注销只摘自己那一次。
 *
 * 为什么值得钉：这里选错不会报错，只会让快捷键作用在另一只宠物身上——用户看到的现象是
 * 「弹窗开在了奇怪的位置」，很难联想到是目标选择的问题。
 *
 * 跑法：node --experimental-strip-types --test src/client/pet/card/registry.test.ts
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { petBridge } from '../../settings/bridge.ts';
import { pickPetChatHandle, registerPetChatHandle, togglePetChatHear, type PetChatHandle } from './registry.ts';

/** 造一个只记调用顺序的句柄；`hearing` 可中途改，模拟正在录音。 */
function makeHandle(calls: string[]): PetChatHandle & { hearing: boolean } {
  const handle = {
    hearing: false,
    open: () => calls.push('open'),
    startHear: () => calls.push('start'),
    stopHear: () => calls.push('stop'),
    isHearing: () => handle.hearing,
  };
  return handle;
}

/** 主配置第一只宠物的形状；测试只关心 id。 */
const asPet = (id: string): NonNullable<typeof petBridge.template> =>
  ({ id }) as unknown as NonNullable<typeof petBridge.template>;

const disposers: Array<() => void> = [];

/** 登记并在每个用例后自动摘掉，避免模块级 Map 串用例。 */
function register(id: string, handle: PetChatHandle): void {
  disposers.push(registerPetChatHandle(id, handle));
}

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  petBridge.template = undefined;
});

describe('pickPetChatHandle —— 快捷键作用于哪只宠物', () => {
  test('主条目在场 → 取主条目，与登记顺序无关', () => {
    const calls: string[] = [];
    const main = makeHandle(calls);
    register('other', makeHandle(calls));
    register('main', main);
    petBridge.template = asPet('main');
    assert.equal(pickPetChatHandle(), main);
  });

  test('主条目不在网页端（只在桌面显示）→ 退到第一个登记过的', () => {
    const calls: string[] = [];
    const first = makeHandle(calls);
    register('first', first);
    register('second', makeHandle(calls));
    petBridge.template = asPet('only-on-desktop');
    assert.equal(pickPetChatHandle(), first);
  });

  test('一只都没登记 → undefined', () => {
    petBridge.template = asPet('main');
    assert.equal(pickPetChatHandle(), undefined);
  });

  test('注销后不再取到；只摘自己那一次', () => {
    const calls: string[] = [];
    const first = makeHandle(calls);
    const second = makeHandle(calls);
    const offFirst = registerPetChatHandle('first', first);
    register('second', second);
    offFirst();
    petBridge.template = asPet('first');
    assert.equal(pickPetChatHandle(), second, '主条目已注销，应退到还在的那只');
    offFirst(); // 幂等：重复注销不该把后来的登记一起摘掉
    assert.equal(pickPetChatHandle(), second);
  });
});

describe('togglePetChatHear —— 开关录音', () => {
  test('没在录 → 开始', () => {
    const calls: string[] = [];
    const handle = makeHandle(calls);
    handle.hearing = false;
    togglePetChatHear(handle);
    assert.deepEqual(calls, ['start']);
  });

  test('正在录 → 收尾', () => {
    const calls: string[] = [];
    const handle = makeHandle(calls);
    handle.hearing = true;
    togglePetChatHear(handle);
    assert.deepEqual(calls, ['stop']);
  });

  test('没有目标宠物 → 什么都不做，也不抛', () => {
    assert.doesNotThrow(() => togglePetChatHear(undefined));
  });
});
