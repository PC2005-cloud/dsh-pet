/**
 * 注册壳的契约：默认键位铺哪几个环境、web:linux 为什么缺席、触发后跑不跑、服务缺失怎么降级。
 *
 * 这一层是三条命令共用的，错了会一起错：铺错档案会让某端悄悄没有默认键，
 * 漏掉 resolve 会让快捷键按下去毫无反应。
 *
 * 跑法：node --experimental-strip-types --test src/client/app-shortcut.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { keycapOf, registerAppShortcut, SHORTCUT_PROFILES, type ShortcutHost } from './app-shortcut.ts';

/** 一次注册的完整命令（断言用）。 */
interface Registered {
  id: string;
  label: () => string;
  defaults: Record<string, unknown>;
  regions: readonly string[];
  modals: readonly string[];
  resolve: () => { status: string; run?: () => void };
}

/** 假上下文：记录注册与注销。 */
function makeHost(mode: 'ok' | 'missing' | 'reject') {
  const state: { command?: Registered; disposed: number } = { disposed: 0 };
  const host: ShortcutHost =
    mode === 'missing'
      ? { get: () => undefined }
      : {
          get: () =>
            mode === 'reject'
              ? {
                  register: () => {
                    throw new Error('Unsupported Web shortcut');
                  },
                }
              : {
                  register: (command: Registered) => {
                    state.command = command;
                    return () => {
                      state.disposed += 1;
                    };
                  },
                },
        };
  return { host, state };
}

/** 被测命令：键位随便给，断言只关心它被原样铺开。 */
const BINDING = { code: 'KeyL', modifiers: ['primary', 'shift'] } as const;

describe('keycapOf —— 键帽推导', () => {
  /** 与实现同一套判据；测试只关心「推导规则」而不是具体平台。 */
  const primary = /Mac/i.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl';

  test('primary 按平台展开，Key 前缀去掉', () => {
    assert.equal(keycapOf({ code: 'KeyL', modifiers: ['primary', 'shift'] }), primary + '+Shift+L');
    assert.equal(keycapOf({ code: 'KeyM', modifiers: ['primary'] }), primary + '+M');
  });

  test('没有修饰键时只出字母', () => {
    assert.equal(keycapOf({ code: 'KeyV', modifiers: [] }), 'V');
  });
});

describe('registerAppShortcut —— 快捷键注册壳', () => {
  test('服务可用 → 五个环境都用同一个键位，web:linux 不在其中', () => {
    const { host, state } = makeHost('ok');
    const result = registerAppShortcut(host, {
      id: 'pet-chat.float',
      label: () => 'L',
      binding: BINDING,
      run: () => {},
    });
    assert.equal(result.registered, true);
    assert.deepEqual(Object.keys(state.command?.defaults ?? {}).sort(), [...SHORTCUT_PROFILES].sort());
    for (const profile of SHORTCUT_PROFILES) {
      assert.deepEqual(state.command?.defaults[profile], BINDING, profile);
    }
    assert.equal(state.command?.defaults['web:linux'], undefined, 'web:linux 进白名单会整条被拒');
  });

  test('是页面级命令，不在输入框里抢键', () => {
    const { host, state } = makeHost('ok');
    registerAppShortcut(host, { id: 'x.y', label: () => 'L', binding: BINDING, run: () => {} });
    assert.deepEqual(state.command?.regions, ['page']);
    assert.deepEqual(state.command?.modals, []);
  });

  test('触发 → 调用传入的动作', () => {
    const { host, state } = makeHost('ok');
    let ran = 0;
    registerAppShortcut(host, {
      id: 'x.y',
      label: () => 'L',
      binding: BINDING,
      run: () => {
        ran += 1;
      },
    });
    const resolution = state.command?.resolve();
    assert.equal(resolution?.status, 'handled');
    resolution?.run?.();
    assert.equal(ran, 1);
  });

  test('注销透传给快捷键服务', () => {
    const { host, state } = makeHost('ok');
    registerAppShortcut(host, { id: 'x.y', label: () => 'L', binding: BINDING, run: () => {} }).dispose();
    assert.equal(state.disposed, 1);
  });

  test('服务缺失 → 不注册、不抛，回报 registered=false', () => {
    const { host, state } = makeHost('missing');
    const result = registerAppShortcut(host, { id: 'x.y', label: () => 'L', binding: BINDING, run: () => {} });
    assert.equal(result.registered, false);
    assert.equal(state.command, undefined);
    assert.doesNotThrow(() => result.dispose());
  });

  test('注册被拒（键位不合白名单 / id 冲突）→ 回报 registered=false，不向上抛', () => {
    const { host } = makeHost('reject');
    const result = registerAppShortcut(host, { id: 'x.y', label: () => 'L', binding: BINDING, run: () => {} });
    assert.equal(result.registered, false);
    assert.doesNotThrow(() => result.dispose());
  });
});
