/**
 * 两条浮动对话命令的契约：命令 id、键位，以及触发后是否真的落到登记的那只宠物上。
 *
 * 键位值得钉：T 被浏览器占着，这里用的是 L 与 V；改错一个字母用户就按不出来，
 * 而「按不出来」在现场只会被当成快捷键没做出来。
 *
 * 跑法：node --experimental-strip-types --test src/client/pet/card/shortcut.test.ts
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { petBridge } from '../../settings/bridge.ts';
import { registerPetChatHandle } from './registry.ts';
import { PET_FLOAT_COMMAND_ID, PET_HEAR_COMMAND_ID, registerPetCardShortcuts } from './shortcut.ts';

/** 一次注册的完整命令（断言用）。 */
interface Registered {
  id: string;
  label: () => string;
  defaults: Record<string, { code: string; modifiers: readonly string[] }>;
  resolve: () => { status: string; run?: () => void };
}

/** 假上下文：把注册过的命令按 id 收起来。 */
function makeHost(): { host: { get: () => unknown }; commands: Map<string, Registered> } {
  const commands = new Map<string, Registered>();
  const host = {
    get: () => ({
      register: (command: Registered) => {
        commands.set(command.id, command);
        return () => {
          commands.delete(command.id);
        };
      },
    }),
  };
  return { host, commands };
}

/** 造一个只记调用的句柄。 */
function makeHandle(calls: string[], hearing = false) {
  const handle = {
    hearing,
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

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  petBridge.template = undefined;
});

describe('registerPetCardShortcuts —— 浮动对话的两条命令', () => {
  test('注册两条命令，键位分别是 Ctrl+Shift+L 与 Ctrl+Shift+M', () => {
    const { host, commands } = makeHost();
    registerPetCardShortcuts(host, (key) => key);
    assert.deepEqual([...commands.keys()].sort(), [PET_FLOAT_COMMAND_ID, PET_HEAR_COMMAND_ID].sort());
    assert.deepEqual(commands.get(PET_FLOAT_COMMAND_ID)?.defaults['web:windows'], {
      code: 'KeyL',
      modifiers: ['primary', 'shift'],
    });
    assert.deepEqual(commands.get(PET_HEAR_COMMAND_ID)?.defaults['desktop:windows'], {
      code: 'KeyM',
      modifiers: ['primary', 'shift'],
    });
  });

  test('标题取的是传进来的翻译键', () => {
    const { host, commands } = makeHost();
    registerPetCardShortcuts(host, (key) => 'T:' + key);
    assert.equal(commands.get(PET_FLOAT_COMMAND_ID)?.label(), 'T:shortcut.chat');
    assert.equal(commands.get(PET_HEAR_COMMAND_ID)?.label(), 'T:shortcut.hear');
  });

  test('按「打开对话」→ 作用在登记的那只宠物上', () => {
    const { host, commands } = makeHost();
    const calls: string[] = [];
    disposers.push(registerPetChatHandle('main', makeHandle(calls)));
    petBridge.template = asPet('main');
    registerPetCardShortcuts(host, (key) => key);
    commands.get(PET_FLOAT_COMMAND_ID)?.resolve().run?.();
    assert.deepEqual(calls, ['open']);
  });

  test('按「语音输入」→ 没在录就开录，在录就收尾', () => {
    const calls: string[] = [];
    const handle = makeHandle(calls);
    disposers.push(registerPetChatHandle('main', handle));
    petBridge.template = asPet('main');
    const { host, commands } = makeHost();
    registerPetCardShortcuts(host, (key) => key);
    const run = (): void => {
      commands.get(PET_HEAR_COMMAND_ID)?.resolve().run?.();
    };
    run();
    handle.hearing = true;
    run();
    assert.deepEqual(calls, ['start', 'stop']);
  });

  test('一只宠物都没有 → 触发也不抛', () => {
    const { host, commands } = makeHost();
    registerPetCardShortcuts(host, (key) => key);
    assert.doesNotThrow(() => commands.get(PET_FLOAT_COMMAND_ID)?.resolve().run?.());
    assert.doesNotThrow(() => commands.get(PET_HEAR_COMMAND_ID)?.resolve().run?.());
  });
});
