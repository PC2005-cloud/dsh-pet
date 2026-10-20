/**
 * 右键「桌宠配置」契约测试：两端菜单 → 打开 DSH 设置面板并定位到「桌宠配置」分区。
 *
 *   · 浏览器端：本页就是 DSH 页面，菜单直接调 openPetSettings()（src/client/open-settings.ts）。
 *   · 桌面端：透明小窗够不着 DSH 页面 → POST /open-settings → 宿主写 sections.openSettings →
 *     DSH 页面统一轮询读到即调 openPetSettings()。
 *
 * 本文件钉住跨半侧契约（两半各自构建、无法互相 import，只能读源码断言）+ 宿主状态叶子的行为。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PollStateStore } from './state.ts';
import { readOpenSettingsAt, PET_SETTINGS_SECTION_ID } from '../client/open-settings.ts';

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const host = readSource('./index.ts');
const sprite = readSource('../../runtime/electron-helper/sprite.js');
const clientPet = readSource('../client/pet.ts');
const app = readSource('../client/app.ts');
const menu = readSource('../shared/menu.ts');

describe('右键「桌宠配置」—— 打开设置面板并定位到桌宠配置分区', () => {
  test('两端菜单都有「桌宠配置」项，且动作有分支', () => {
    assert.ok(/label: '桌宠配置', action: 'open-settings'/.test(clientPet), '浏览器端菜单必须有「桌宠配置」项');
    assert.ok(
      /leaf\.action === 'open-settings'/.test(clientPet),
      '浏览器端 handleMenuAction 必须有 open-settings 分支',
    );
    assert.ok(/label: '桌宠配置', action: 'open-settings'/.test(sprite), '桌面端菜单必须有「桌宠配置」项');
    assert.ok(/leaf\.action === 'open-settings'/.test(sprite), '桌面端 onMenuAction 必须有 open-settings 分支');
    assert.ok(/'open-settings'/.test(menu), "shared/menu.ts 的 MenuLeaf.action 必须包含 'open-settings'");
  });

  test('桌面端请求的路由在宿主存在，且宿主只写指令叶子、不碰配置', () => {
    assert.ok(
      /fetch\(BASE \+ '\/open-settings', \{ method: 'POST' \}\)/.test(sprite),
      '桌面端必须 POST /open-settings',
    );
    const block = /if \(rest === 'open-settings'\) \{([\s\S]*?)\n {4}\}/.exec(host);
    assert.ok(block, '宿主必须有 /open-settings 路由');
    const body = block[1];
    assert.ok(/method !== 'POST'/.test(body), 'open-settings 只接受 POST');
    assert.ok(/state\.writeSection\('openSettings'/.test(body), '宿主必须写 sections.openSettings');
    assert.ok(!/writeFile|saveUserConfig|syncDesktop/.test(body), 'open-settings 不写配置、不重启 Helper');
  });

  test('浏览器端消费 sections.openSettings；分区 id 与设置页注册一致', () => {
    assert.ok(/path === 'sections\.openSettings'/.test(clientPet), '统一轮询必须处理 sections.openSettings');
    assert.ok(
      new RegExp(`name: 'settings\\.section', id: '${PET_SETTINGS_SECTION_ID}'`).test(app),
      `设置页分区 id 必须是 ${PET_SETTINGS_SECTION_ID}（openSection 用它定位）`,
    );
    assert.ok(/installSettingsOpener\(ctx/.test(app), 'app.ts 必须把 ctx 交给 open-settings 模块');
  });

  test('宿主状态：openSettings 叶子初始为空，写入后带 at 且 counter 前进', () => {
    const s = new PollStateStore();
    const before = s.read();
    assert.equal(before.sections.openSettings.data, null);
    s.writeSection('openSettings', { at: 123 });
    const after = s.read();
    assert.ok(after.sections.openSettings.counter > before.sections.openSettings.counter);
    assert.equal(readOpenSettingsAt(after.sections.openSettings.data), 123);
  });

  test('readOpenSettingsAt：只认有限数字的 at', () => {
    assert.equal(readOpenSettingsAt(null), undefined);
    assert.equal(readOpenSettingsAt({}), undefined);
    assert.equal(readOpenSettingsAt({ at: 'x' }), undefined);
    assert.equal(readOpenSettingsAt({ at: Number.NaN }), undefined);
    assert.equal(readOpenSettingsAt({ at: 5 }), 5);
  });
});
