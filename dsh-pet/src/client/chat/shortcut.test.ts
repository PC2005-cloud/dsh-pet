/**
 * 快捷键注册的契约：命令长什么样、默认键位、触发后是否真的打开、服务缺失怎么降级。
 *
 * 不渲染界面，也不依赖真实键盘服务。
 *
 * 跑法：node --experimental-strip-types --test src/client/chat/shortcut.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PET_CHAT_COMMAND_ID, registerPetChatShortcut } from './shortcut.ts';

/** 标题的假翻译；测试只关心它是不是惰性调用。 */
const LABEL = '打开桌宠对话';

/** 一次注册的完整命令（断言用）。 */
interface Registered {
  id: string;
  label: () => string;
  defaults: Record<string, unknown>;
  regions: readonly string[];
  resolve: () => { status: string; run?: () => void };
}

/** 假上下文：记录注册与注销。 */
function makeHost(hasService: boolean) {
  const state: { command?: Registered; disposed: number } = { disposed: 0 };
  const ctx = {
    get: (name: string) =>
      hasService && name === 'shortcuts'
        ? {
            register: (command: Registered) => {
              state.command = command;
              return () => {
                state.disposed += 1;
              };
            },
          }
        : undefined,
  };
  return { ctx, state };
}

describe('registerPetChatShortcut —— 打开对话的快捷键', () => {
  test('服务可用 → 用固定 id 注册，默认 Ctrl+Shift+P（primary 在 macOS 展开为 Command）', () => {
    const host = makeHost(true);
    const result = registerPetChatShortcut(
      host.ctx,
      () => LABEL,
      () => {},
    );
    assert.equal(result.registered, true);
    assert.equal(host.state.command?.id, PET_CHAT_COMMAND_ID);
    assert.deepEqual(host.state.command?.defaults['web:windows'], { code: 'KeyP', modifiers: ['primary', 'shift'] });
    assert.deepEqual(host.state.command?.defaults['desktop:macos'], { code: 'KeyP', modifiers: ['primary', 'shift'] });
  });

  test('触发命令 → 调用传入的打开动作', () => {
    const host = makeHost(true);
    let opened = 0;
    registerPetChatShortcut(
      host.ctx,
      () => LABEL,
      () => {
        opened += 1;
      },
    );
    const resolution = host.state.command?.resolve();
    assert.equal(resolution?.status, 'handled');
    resolution?.run?.();
    assert.equal(opened, 1);
  });

  test('标题惰性求值：切语言后取到的是新文案', () => {
    const host = makeHost(true);
    let label = '打开桌宠对话';
    registerPetChatShortcut(
      host.ctx,
      () => label,
      () => {},
    );
    assert.equal(host.state.command?.label(), '打开桌宠对话');
    label = 'Open pet chat';
    assert.equal(host.state.command?.label(), 'Open pet chat', '不能把第一次的结果缓存下来');
  });

  test('注销透传给快捷键服务', () => {
    const host = makeHost(true);
    registerPetChatShortcut(
      host.ctx,
      () => LABEL,
      () => {},
    ).dispose();
    assert.equal(host.state.disposed, 1);
  });

  test('服务缺失 → 不注册、不抛，回报 registered=false', () => {
    const host = makeHost(false);
    const result = registerPetChatShortcut(
      host.ctx,
      () => LABEL,
      () => {},
    );
    assert.equal(result.registered, false);
    assert.equal(host.state.command, undefined);
    assert.doesNotThrow(() => result.dispose());
  });

  test('注册被拒（抛错）→ 回报 registered=false，不向上抛', () => {
    const ctx = {
      get: () => ({
        register: () => {
          throw new Error('unsupported code');
        },
      }),
    };
    const result = registerPetChatShortcut(
      ctx,
      () => LABEL,
      () => {},
    );
    assert.equal(result.registered, false);
    assert.doesNotThrow(() => result.dispose());
  });
});
