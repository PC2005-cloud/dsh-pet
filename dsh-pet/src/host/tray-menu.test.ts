/**
 * 托盘菜单模板的纯逻辑测试（ticket 01）。
 *
 * 菜单模板住在运行时壳（CommonJS，随包发行的手写 JS），因此用 createRequire 加载；
 * 测试只断言「给定输入产出什么菜单项」，不关心 main.js 怎么把它交给 Electron。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const isPetItem = (item: MenuItem): boolean => item.action === 'toggle-pet';
const findAction = (template: MenuItem[], action: string): MenuItem | undefined =>
  template.find((item) => item.action === action);

describe('buildTrayMenuTemplate —— 宠物勾选（沿用现有行为）', () => {
  test('每只宠物一个 checkbox，label 优先用 name、缺失时回落 id', () => {
    const template: MenuItem[] = buildTrayMenuTemplate({
      pets: [
        { id: 'blue', name: '小蓝', display: 'desktop' },
        { id: 'red', name: '', display: 'web' },
      ],
    });
    const pets = template.filter(isPetItem);
    assert.equal(pets.length, 2);
    assert.equal(pets[0].label, '小蓝');
    assert.equal(pets[1].label, 'red');
  });

  test('勾选态 = display 含 desktop/both；desktop/both 勾上，web/none 不勾', () => {
    const template: MenuItem[] = buildTrayMenuTemplate({
      pets: [
        { id: 'a', name: 'A', display: 'desktop' },
        { id: 'b', name: 'B', display: 'both' },
        { id: 'c', name: 'C', display: 'web' },
        { id: 'd', name: 'D', display: 'none' },
      ],
    });
    assert.deepEqual(
      template.filter(isPetItem).map((item) => item.checked),
      [true, true, false, false],
    );
  });

  test('宠物项带上点击所需的数据（petId 与当前 display）', () => {
    const template: MenuItem[] = buildTrayMenuTemplate({
      pets: [{ id: 'blue', name: '小蓝', display: 'both' }],
    });
    const pet = template.find(isPetItem);
    assert.ok(pet);
    assert.equal(pet.petId, 'blue');
    assert.equal(pet.display, 'both');
    assert.equal(pet.type, 'checkbox');
  });
});

describe('buildTrayMenuTemplate —— 应用菜单项（ticket 06 接线用）', () => {
  test('有设置页 URL：出现「打开 AI 设置…」并带上 URL', () => {
    const template: MenuItem[] = buildTrayMenuTemplate({
      pets: [{ id: 'blue', name: '小蓝', display: 'desktop' }],
      settingsUrl: 'http://127.0.0.1:3080/settings?token=abc',
    });
    const settings = findAction(template, 'open-settings');
    assert.ok(settings, '有 URL 时必须有设置项');
    assert.equal(settings.label, '打开 AI 设置…');
    assert.equal(settings.url, 'http://127.0.0.1:3080/settings?token=abc');
  });

  test('无设置页 URL（未提供 / 空串 / 纯空白）：该项不出现', () => {
    for (const settingsUrl of [undefined, '', '   ']) {
      const template: MenuItem[] = buildTrayMenuTemplate({
        pets: [{ id: 'blue', name: '小蓝', display: 'desktop' }],
        settingsUrl,
      });
      assert.equal(findAction(template, 'open-settings'), undefined, `settingsUrl=${JSON.stringify(settingsUrl)}`);
    }
  });

  test('自启开关是 checkbox，勾选态跟随输入', () => {
    for (const autostart of [true, false]) {
      const template: MenuItem[] = buildTrayMenuTemplate({
        pets: [{ id: 'blue', name: '小蓝', display: 'desktop' }],
        autostart,
      });
      const item = findAction(template, 'toggle-autostart');
      assert.ok(item, '自启项必须存在');
      assert.equal(item.type, 'checkbox');
      assert.equal(item.checked, autostart);
    }
  });

  test('数据目录 / 使用说明 / 退出三项都在，且退出项始终存在', () => {
    const template: MenuItem[] = buildTrayMenuTemplate({ pets: [] });
    assert.ok(findAction(template, 'open-data-dir'));
    assert.ok(findAction(template, 'show-help'));
    assert.ok(findAction(template, 'quit'));
  });

  test('宠物列表为空时菜单仍能构造（不抛错、没有宠物项、退出项仍在）', () => {
    const template: MenuItem[] = buildTrayMenuTemplate({ pets: [] });
    assert.ok(Array.isArray(template));
    assert.equal(template.filter(isPetItem).length, 0);
    assert.ok(findAction(template, 'quit'));
  });

  test('菜单项带稳定的 id/action，后续接线不需要改纯函数', () => {
    const template: MenuItem[] = buildTrayMenuTemplate({
      pets: [{ id: 'blue', name: '小蓝', display: 'desktop' }],
      settingsUrl: 'http://127.0.0.1:3080/settings',
      autostart: true,
    });
    assert.equal(findAction(template, 'toggle-pet')?.id, 'pet:blue');
    assert.equal(findAction(template, 'open-settings')?.id, 'settings');
    assert.equal(findAction(template, 'toggle-autostart')?.id, 'autostart');
    assert.equal(findAction(template, 'open-data-dir')?.id, 'data-dir');
    assert.equal(findAction(template, 'show-help')?.id, 'help');
    assert.equal(findAction(template, 'quit')?.id, 'quit');
    // 每项都有 id（分隔符也有），后续按 id/action 接线即可
    for (const item of template) assert.equal(typeof item.id, 'string');
  });
});

describe('守卫：tray-menu.js 必须在发布必需清单里', () => {
  test('prepack-check.js 的 required 含它（main.js require，缺了会启动即崩）', () => {
    const src = readFileSync(fileURLToPath(new URL('../../scripts/prepack-check.js', import.meta.url)), 'utf8');
    assert.ok(/'runtime\/electron-helper\/tray-menu\.js'/.test(src), '漏了它，npm 包里就少一个 main.js 必需的模块');
  });
});
