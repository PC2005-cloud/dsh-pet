/**
 * 三条浮动对话命令的契约：命令 id、键位，以及触发后是否真的落到登记的那只宠物上。
 *
 * 键位值得钉：T 被浏览器占着，这里用的是 L（对话）、M（录音）、S（截图）；改错一个字母用户就按不出来，
 * 而「按不出来」在现场只会被当成快捷键没做出来。
 * 开关语义同样值得钉：同一个键第二次按必须是关，不是「把焦点塞回输入框」。
 *
 * 跑法：node --experimental-strip-types --test src/client/pet/card/shortcut.test.ts
 */
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { petBridge } from '../../settings/bridge.ts';
import { keycapOf, type ShortcutHost } from '../../app-shortcut.ts';
import { registerPetChatHandle } from './registry.ts';
import {
  PET_CAPTURE_COMMAND_ID,
  PET_FLOAT_COMMAND_ID,
  PET_HEAR_COMMAND_ID,
  petShortcutKeycap,
  registerPetCardShortcuts,
} from './shortcut.ts';

/** 一次注册的完整命令（断言用）。 */
interface Registered {
  id: string;
  label: () => string;
  defaults: Record<string, { code: string; modifiers: readonly string[] }>;
  resolve: () => { status: string; run?: () => void };
}

/** 目录行：服务按平台展开好的键帽片段。 */
type Row = { id: string; keys: string[] };

/** 假上下文：把注册过的命令按 id 收起来，并可选地暴露一份目录。 */
function makeHost(rows: Row[] = []): { host: ShortcutHost; commands: Map<string, Registered> } {
  const commands = new Map<string, Registered>();
  const host: ShortcutHost = {
    get: () => ({
      register: (command: Registered) => {
        commands.set(command.id, command);
        return () => {
          commands.delete(command.id);
        };
      },
      catalog: { getSnapshot: () => rows, subscribe: () => () => {} },
    }),
  };
  return { host, commands };
}

/** 造一个只记调用的句柄；`hearing` 可中途改，模拟正在录音。 */
function makeHandle(calls: string[], hearing = false) {
  const handle = {
    hearing,
    opened: false,
    open: () => {
      handle.opened = true;
      calls.push('open');
    },
    close: () => {
      handle.opened = false;
      calls.push('close');
    },
    isOpen: () => handle.opened,
    startHear: () => calls.push('start'),
    stopHear: () => calls.push('stop'),
    isHearing: () => handle.hearing,
    screenshot: () => calls.push('screenshot'),
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

/** 默认组合，与源码里的绑定同源；测试只用于断言兜底文案。 */
const FLOAT_DEFAULT_KEYCAP = keycapOf({ code: 'KeyL', modifiers: ['primary', 'shift'] });

describe('registerPetCardShortcuts —— 浮动对话的三条命令', () => {
  test('注册三条命令，键位分别是 Ctrl+Shift+L / M / S', () => {
    const { host, commands } = makeHost();
    registerPetCardShortcuts(host, (key) => key);
    assert.deepEqual(
      [...commands.keys()].sort(),
      [PET_FLOAT_COMMAND_ID, PET_HEAR_COMMAND_ID, PET_CAPTURE_COMMAND_ID].sort(),
    );
    assert.deepEqual(commands.get(PET_FLOAT_COMMAND_ID)?.defaults['web:windows'], {
      code: 'KeyL',
      modifiers: ['primary', 'shift'],
    });
    assert.deepEqual(commands.get(PET_HEAR_COMMAND_ID)?.defaults['desktop:windows'], {
      code: 'KeyM',
      modifiers: ['primary', 'shift'],
    });
    assert.deepEqual(commands.get(PET_CAPTURE_COMMAND_ID)?.defaults['web:windows'], {
      code: 'KeyS',
      modifiers: ['primary', 'shift'],
    });
  });

  test('标题取的是传进来的翻译键', () => {
    const { host, commands } = makeHost();
    registerPetCardShortcuts(host, (key) => 'T:' + key);
    assert.equal(commands.get(PET_FLOAT_COMMAND_ID)?.label(), 'T:shortcut.chat');
    assert.equal(commands.get(PET_HEAR_COMMAND_ID)?.label(), 'T:shortcut.hear');
    assert.equal(commands.get(PET_CAPTURE_COMMAND_ID)?.label(), 'T:shortcut.capture');
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

  test('再按一次「打开对话」→ 关掉，而不是再开一个', () => {
    const { host, commands } = makeHost();
    const calls: string[] = [];
    disposers.push(registerPetChatHandle('main', makeHandle(calls)));
    petBridge.template = asPet('main');
    registerPetCardShortcuts(host, (key) => key);
    const run = (): void => {
      commands.get(PET_FLOAT_COMMAND_ID)?.resolve().run?.();
    };
    run();
    run();
    assert.deepEqual(calls, ['open', 'close']);
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

  test('按「截图」→ 落到登记的那只宠物上', () => {
    const { host, commands } = makeHost();
    const calls: string[] = [];
    disposers.push(registerPetChatHandle('main', makeHandle(calls)));
    petBridge.template = asPet('main');
    registerPetCardShortcuts(host, (key) => key);
    commands.get(PET_CAPTURE_COMMAND_ID)?.resolve().run?.();
    assert.deepEqual(calls, ['screenshot']);
  });

  test('一只宠物都没有 → 触发也不抛', () => {
    const { host, commands } = makeHost();
    registerPetCardShortcuts(host, (key) => key);
    assert.doesNotThrow(() => commands.get(PET_FLOAT_COMMAND_ID)?.resolve().run?.());
    assert.doesNotThrow(() => commands.get(PET_HEAR_COMMAND_ID)?.resolve().run?.());
    assert.doesNotThrow(() => commands.get(PET_CAPTURE_COMMAND_ID)?.resolve().run?.());
  });
});

describe('petShortcutKeycap —— 设置页显示的键帽', () => {
  test('用户改绑后显示改绑后的键，不再念默认值', () => {
    const { host } = makeHost([{ id: PET_FLOAT_COMMAND_ID, keys: ['Ctrl', '+', 'Alt', '+', 'K'] }]);
    assert.equal(petShortcutKeycap(host, 'chat'), 'Ctrl+Alt+K');
  });

  test('目录里没有这一条 → 退回默认组合', () => {
    const { host } = makeHost();
    assert.equal(petShortcutKeycap(host, 'chat'), FLOAT_DEFAULT_KEYCAP);
  });

  test('宿主没有快捷键服务 → 退回默认组合，不抛', () => {
    assert.equal(petShortcutKeycap({ get: () => undefined }, 'chat'), FLOAT_DEFAULT_KEYCAP);
  });
});
