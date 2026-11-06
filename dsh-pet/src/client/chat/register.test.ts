/**
 * 右侧栏标签的注册契约：注册了什么、服务缺失时如何降级、注销是否只是标签类型。
 *
 * 不渲染组件（组件行为属 UI 层），也不模拟插槽框架的完整生命周期——
 * 这里只钉注册顺序与「等插槽声明再注册」这一条路径。
 *
 * 跑法：node --experimental-strip-types --test src/client/chat/register.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { registerPetChatTab, type PetChatTabHost } from './register.ts';
import type { ChatPanelRuntime } from './panel.ts';

/** 组件不会被调用，桩只需形状正确。 */
const RT: ChatPanelRuntime = {
  h: () => null,
  useState: <T>(init: T) => [init, () => {}] as unknown as [T, (next: T | ((prev: T) => T)) => void],
  useEffect: () => {},
  useRef: <T>(initial: T) => ({ current: initial }),
  t: (key) => key,
};

/** 假上下文：记录调用顺序；inject 立即驱动生成器，模拟「插槽已声明」。 */
function makeHost(hasService: boolean) {
  const calls: string[] = [];
  let typeDisposed = 0;
  const host: PetChatTabHost = {
    get: (name: string) =>
      hasService && name === 'sidebarRightTabs'
        ? {
            register: (definition: { kind: string }) => {
              calls.push('type:' + definition.kind);
              return () => {
                typeDisposed += 1;
              };
            },
          }
        : undefined,
    slots: {
      inject: (name: string, generator: () => Generator<unknown, void, unknown>) => {
        calls.push('inject:' + name);
        const steps = generator();
        for (let step = steps.next(); !step.done; step = steps.next()) {
          // 生成器 yield 的是正文注册的 disposer，真实框架会收集它
        }
      },
      register: (registration: { name: string; key: string }) => {
        calls.push('slot:' + registration.name + ':' + registration.key);
        return () => {};
      },
    },
  };
  return { host, calls, disposed: () => typeDisposed };
}

describe('registerPetChatTab —— 右侧栏对话标签', () => {
  test('服务可用 → 先注册标签类型，再在插槽作用域里注册正文', () => {
    const fake = makeHost(true);
    registerPetChatTab(fake.host, RT);
    assert.deepEqual(fake.calls, [
      'type:pet-chat',
      'inject:sidebar.right.pane.tab',
      'slot:sidebar.right.pane.tab:dsh-pet-chat',
    ]);
  });

  test('注销只摘标签类型（正文插槽归 slots.inject 的作用域）', () => {
    const fake = makeHost(true);
    registerPetChatTab(fake.host, RT)();
    assert.equal(fake.disposed(), 1);
  });

  test('没有 sidebarRightTabs 服务 → 不注册任何东西，返回可安全调用的空注销', () => {
    const fake = makeHost(false);
    const dispose = registerPetChatTab(fake.host, RT);
    assert.deepEqual(fake.calls, []);
    assert.doesNotThrow(() => dispose());
  });
});
