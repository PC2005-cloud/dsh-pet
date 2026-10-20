/**
 * 应用托盘的动作分发（ticket 06）。
 *
 * 托盘本身是 Electron 的系统 UI，没法在 node:test 里点；能钉住的是「点了之后应该发生什么」：
 * 模板项（id/action/petId/display/url）+ 当前应用状态 → 副作用描述。desktop/tray.mjs 只负责
 * 把描述翻译成 Electron 调用，翻译层用源码契约测试钉住。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  dispatchTrayAction,
  flattenConfigPets,
  helpText,
  nextPetDisplay,
  trayIconPath,
  trayMenuScenario,
} from './tray-actions.ts';

const require = createRequire(import.meta.url);
const { buildTrayMenuTemplate } = require('../../runtime/electron-helper/tray-menu.js');

type MenuItem = {
  id?: string;
  action?: string;
  type?: string;
  label?: string;
  checked?: boolean;
  petId?: string;
  display?: string;
  url?: string;
};

describe('nextPetDisplay —— 与桌面壳相同的翻转规则', () => {
  test('both↔web、desktop↔none，浏览器位不被无声吞掉', () => {
    assert.equal(nextPetDisplay('both'), 'web');
    assert.equal(nextPetDisplay('web'), 'both');
    assert.equal(nextPetDisplay('desktop'), 'none');
    assert.equal(nextPetDisplay('none'), 'desktop');
  });

  test('缺失/未知 display 按「送到桌面」处理（与壳里的 toggleDisplay 一致）', () => {
    assert.equal(nextPetDisplay(''), 'desktop');
    assert.equal(nextPetDisplay('weird'), 'desktop');
  });
});

describe('dispatchTrayAction —— 模板项到副作用描述', () => {
  test('toggle-pet：带 petId 与当前 display，翻转后提交 pet-display', () => {
    assert.deepEqual(dispatchTrayAction({ action: 'toggle-pet', petId: 'blue', display: 'both' }, {}), {
      type: 'pet-display',
      id: 'blue',
      display: 'web',
    });
    assert.deepEqual(dispatchTrayAction({ action: 'toggle-pet', petId: 'blue', display: 'none' }, {}), {
      type: 'pet-display',
      id: 'blue',
      display: 'desktop',
    });
  });

  test('toggle-pet：缺 petId 时不发请求（避免把空 id 提交给宿主）', () => {
    assert.deepEqual(dispatchTrayAction({ action: 'toggle-pet', display: 'both' }, {}), {
      type: 'noop',
      action: 'toggle-pet',
    });
    assert.deepEqual(dispatchTrayAction({ action: 'toggle-pet', petId: '  ', display: 'both' }, {}), {
      type: 'noop',
      action: 'toggle-pet',
    });
  });

  test('open-settings：输出要打开的 URL', () => {
    assert.deepEqual(
      dispatchTrayAction({ action: 'open-settings', url: 'http://127.0.0.1:3080/standalone-ai/#token=abc' }, {}),
      { type: 'open-url', url: 'http://127.0.0.1:3080/standalone-ai/#token=abc' },
    );
  });

  test('open-settings：没有 URL 时不做任何事', () => {
    assert.deepEqual(dispatchTrayAction({ action: 'open-settings' }, {}), {
      type: 'noop',
      action: 'open-settings',
    });
    assert.deepEqual(dispatchTrayAction({ action: 'open-settings', url: '   ' }, {}), {
      type: 'noop',
      action: 'open-settings',
    });
  });

  test('toggle-autostart：翻转当前系统登录项状态', () => {
    assert.deepEqual(dispatchTrayAction({ action: 'toggle-autostart' }, { autostart: false }), {
      type: 'set-autostart',
      enabled: true,
    });
    assert.deepEqual(dispatchTrayAction({ action: 'toggle-autostart' }, { autostart: true }), {
      type: 'set-autostart',
      enabled: false,
    });
    assert.deepEqual(dispatchTrayAction({ action: 'toggle-autostart' }, {}), {
      type: 'set-autostart',
      enabled: true,
    });
  });

  test('open-data-dir / show-help / quit 各自映射到明确动作', () => {
    assert.deepEqual(dispatchTrayAction({ action: 'open-data-dir' }, {}), { type: 'open-data-dir' });
    assert.deepEqual(dispatchTrayAction({ action: 'show-help' }, {}), { type: 'show-help' });
    assert.deepEqual(dispatchTrayAction({ action: 'quit' }, {}), { type: 'quit' });
  });

  test('分隔符与未知 action 不产生副作用（点击也不应崩）', () => {
    assert.deepEqual(dispatchTrayAction({ action: 'separator' }, {}), { type: 'noop', action: 'separator' });
    assert.deepEqual(dispatchTrayAction({ action: 'future-action' }, {}), { type: 'noop', action: 'future-action' });
    assert.deepEqual(dispatchTrayAction({}, {}), { type: 'noop', action: '' });
  });
});

describe('flattenConfigPets —— GET /dsh-pet-7340/config 的聚合形状', () => {
  const config = {
    main: {
      pets: [
        { id: 'main', name: '小蓝', display: 'both' },
        { id: 'hidden', name: '', display: 'web' },
      ],
    },
    second: {
      pets: [{ id: 'second', name: '  二号  ', display: 'none' }],
    },
    // 顶层还有条目级元数据，不是宠物；不得被当成宠物读出来（壳里踩过的坑）
    meta: { version: 1 },
  };

  test('展开每个条目的 pets 数组，只保留托盘需要的 id/name/display', () => {
    assert.deepEqual(flattenConfigPets(config), [
      { id: 'main', name: '小蓝', display: 'both' },
      { id: 'hidden', name: '', display: 'web' },
      { id: 'second', name: '二号', display: 'none' },
    ]);
  });

  test('缺 id 的宠物被丢弃；条目不是对象 / pets 不是数组时跳过', () => {
    assert.deepEqual(
      flattenConfigPets({
        a: { pets: [{ name: '没有 id', display: 'both' }, null, { id: 'ok', display: 'desktop' }] },
        b: { pets: 'nope' },
        c: null,
      }),
      [{ id: 'ok', name: '', display: 'desktop' }],
    );
    assert.deepEqual(flattenConfigPets(null), []);
    assert.deepEqual(flattenConfigPets('nope'), []);
  });
});

describe('trayMenuScenario → buildTrayMenuTemplate —— 宿主托盘的完整菜单输入', () => {
  test('宠物勾选、设置项、自启勾选、退出项一次到位', () => {
    const scenario = trayMenuScenario({
      config: {
        main: {
          pets: [
            { id: 'main', name: '小蓝', display: 'both' },
            { id: 'second', name: '二号', display: 'web' },
          ],
        },
      },
      settingsUrl: 'http://127.0.0.1:3080/standalone-ai/#token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      autostart: true,
    });
    const template: MenuItem[] = buildTrayMenuTemplate(scenario);

    const pets = template.filter((item) => item.action === 'toggle-pet');
    assert.deepEqual(
      pets.map((item) => ({ id: item.petId, label: item.label, checked: item.checked })),
      [
        { id: 'main', label: '小蓝', checked: true },
        { id: 'second', label: '二号', checked: false },
      ],
    );
    const settings = template.find((item) => item.action === 'open-settings');
    assert.equal(settings?.url, scenario.settingsUrl);
    assert.equal(template.find((item) => item.action === 'toggle-autostart')?.checked, true);
    assert.ok(template.find((item) => item.action === 'open-data-dir'));
    assert.ok(template.find((item) => item.action === 'show-help'));
    assert.ok(template.find((item) => item.action === 'quit'));
  });

  test('读不到配置 / 没有设置页 URL 时仍能构造菜单（只有应用项）', () => {
    const template: MenuItem[] = buildTrayMenuTemplate(
      trayMenuScenario({ config: undefined, settingsUrl: undefined, autostart: false }),
    );
    assert.equal(template.filter((item) => item.action === 'toggle-pet').length, 0);
    assert.equal(
      template.find((item) => item.action === 'open-settings'),
      undefined,
    );
    assert.equal(template.find((item) => item.action === 'toggle-autostart')?.checked, false);
    assert.ok(template.find((item) => item.action === 'quit'));
  });

  test('settingsUrl 的空白被清除：纯空白不产生「打开 AI 设置…」', () => {
    const scenario = trayMenuScenario({ config: {}, settingsUrl: '   ', autostart: false });
    assert.equal(scenario.settingsUrl, undefined);
    const template: MenuItem[] = buildTrayMenuTemplate(scenario);
    assert.equal(
      template.find((item) => item.action === 'open-settings'),
      undefined,
    );
  });
});

describe('路径 —— 托盘图标来自应用根', () => {
  test('图标路径可预测（打包后 appPath 是 asar 根）', () => {
    assert.equal(trayIconPath('/opt/dsh-pet'), join('/opt/dsh-pet', 'assets', 'logo.png'));
  });
});

describe('helpText —— 使用说明必须覆盖的入口与不可用能力', () => {
  test('写明右键宠物、托盘退出入口，以及独立模式不可用的三块能力', () => {
    const text = helpText();
    assert.match(text, /右键宠物/);
    assert.match(text, /退出/);
    assert.match(text, /托盘/);
    assert.match(text, /余额/);
    assert.match(text, /会话工作状态/);
    assert.match(text, /系统通知/);
  });
});
