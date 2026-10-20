/**
 * 宠物右键菜单「AI 设置…」的跨进程接线契约（ticket 07）。
 *
 * 两半（Electron 主进程 / 渲染端 preload+sprite）各自构建、无法互相 import，按仓库既有做法
 * 读源码断言 + 用 runtime-settings.test.ts 钉住纯逻辑：
 *   - 只在安装版（DSH_PET_PACKAGED=1）且运行时文件可用时出现，插件形态不显示（没有本机设置页）；
 *   - 主进程点击时**重新读取并校验**运行时文件，缺失/过期/损坏给出可读提示，不打开空白页；
 *   - 设置页 URL 与 token 是能力令牌，任何日志都不得出现；
 *   - 托盘与右键菜单共用同一份读取/校验实现（runtime-settings.ts 的构建产物）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readPackageFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');

const preload = readPackageFile('runtime/electron-helper/preload.js');
const main = readPackageFile('runtime/electron-helper/main.js');
const sprite = readPackageFile('runtime/electron-helper/sprite.js');
const tray = readPackageFile('desktop/tray.mjs');
const sharedMenu = readPackageFile('src/shared/menu.ts');
const standaloneApp = readPackageFile('src/standalone/app.ts');

describe('preload —— 渲染端只暴露两个原语', () => {
  test('aiSettingsAvailable 走 invoke；openAiSettings 走 send', () => {
    assert.match(preload, /aiSettingsAvailable\(\)\s*\{\s*return ipcRenderer\.invoke\('pet:ai-settings-available'\)/);
    assert.match(preload, /openAiSettings\(\)\s*\{\s*ipcRenderer\.send\('pet:open-settings'\)/);
  });
});

describe('helper 主进程 —— 安装版才可用，点击时重新校验', () => {
  test('AI 设置能力只在打包形态启用（插件形态没有本机设置页）', () => {
    assert.match(main, /const AI_SETTINGS_ENABLED = process\.env\.DSH_PET_PACKAGED === '1'/);
    assert.match(main, /if \(!AI_SETTINGS_ENABLED\) return \{ available: false/);
  });

  test('运行时状态读取复用 lib/runtime-settings.js（与托盘同一份），不自己解析 JSON', () => {
    assert.match(main, /runtime-settings\.js/);
    assert.match(main, /readRuntimeSettings\(/);
    assert.ok(!/parseRuntimeSettingsUrl|JSON\.parse\([^)]*settingsUrl/.test(main), '不得在壳里另写一份解析');
    // 动态 import：lib/ 是 ESM，而桌面壳是 CJS；只有打包形态才加载
    assert.match(main, /AI_SETTINGS_ENABLED\s*\?[\s\S]{0,200}?import\(/);
  });

  test('可用性查询走 ipcMain.handle，点击走 ipcMain.on(pet:open-settings)', () => {
    assert.match(main, /ipcMain\.handle\('pet:ai-settings-available'/);
    assert.match(main, /ipcMain\.on\('pet:open-settings'/);
  });

  test('不可用时弹可读提示并 return，绝不把过期 URL 交给 shell.openExternal', () => {
    const handler = main.slice(main.indexOf("ipcMain.on('pet:open-settings'"));
    assert.ok(handler.length > 0, '必须处理 pet:open-settings');
    assert.match(handler, /openAiSettings\(\)/);
    const open = main.slice(
      main.indexOf('async function openAiSettings()'),
      main.indexOf("ipcMain.handle('pet:ai-settings-available'"),
    );
    assert.ok(open.length > 0, '必须有 openAiSettings 实现');
    assert.match(open, /readAiSettings\(\)/);
    assert.match(
      open,
      /if \(!settings\.available\)[\s\S]*?showSettingsUnavailable\(settings\.message\)[\s\S]*?return;/,
    );
    assert.match(open, /shell\.openExternal\(settings\.settingsUrl\)/);
    // 提示必须是「启动 / 重试」这类可操作文案，而不是空话
    assert.match(main, /暂时无法打开 AI 设置/);
  });

  test('日志中不得出现 settingsUrl / token', () => {
    assert.ok(!/console\.(?:log|info|warn|error)\([^)]*settingsUrl/i.test(main));
    assert.ok(!/console\.(?:log|info|warn|error)\([^)]*\.token\b/i.test(main));
    assert.ok(!/console\.(?:log|info|warn|error)\([^)]*effect\.url/i.test(main));
  });
});

describe('渲染端右键菜单 —— 仅在可用时注入「AI 设置…」', () => {
  test('菜单项条件出现，文案与 action 固定', () => {
    assert.match(
      sprite,
      /if \(settingsAvailable\)\s*tools\.push\(\{\s*label: 'AI 设置…', action: 'open-settings'\s*\}\)/,
    );
    assert.ok(!/tools\s*=\s*\[[^\]]*'AI 设置…'/.test(sprite), '不得无条件出现在工具项列表里');
  });

  test('打开菜单前向主进程查询可用性，查询失败按不可用处理', () => {
    assert.match(sprite, /await window\.petBridge\.aiSettingsAvailable\(\)/);
    assert.match(sprite, /catch\s*\{[\s\S]{0,80}settingsAvailable = false|\.catch\(\(\) => false\)/);
  });

  test('点击 open-settings 调 preload 的 openAiSettings()', () => {
    assert.match(sprite, /leaf\.action === 'open-settings'[\s\S]{0,160}?openAiSettings\(\)/);
  });
});

describe('共享菜单类型 —— 新增动作名', () => {
  test("MenuLeaf.action 联合类型包含 'open-settings'", () => {
    assert.match(sharedMenu, /'open-site'\s*\|\s*'show-balance'[\s\S]*?'open-settings'/);
  });
});

describe('托盘 —— 与右键菜单共用同一份读取/校验', () => {
  test('从 lib/runtime-settings.js 读 runtime settings，不再自带 parseRuntimeSettingsUrl', () => {
    assert.match(tray, /from '\.\.\/lib\/runtime-settings\.js'/);
    assert.match(tray, /readRuntimeSettings\(home\)/);
    assert.ok(!/parseRuntimeSettingsUrl/.test(tray), '托盘不得保留第二份解析实现');
  });

  test('点击设置项时重新读取；过期时提示而不是打开旧 URL', () => {
    const openAt = tray.indexOf("case 'open-url'");
    assert.ok(openAt > 0);
    const branch = tray.slice(openAt, tray.indexOf("case 'set-autostart'", openAt));
    assert.match(branch, /readRuntimeSettings\(home\)/);
    assert.match(branch, /if \(!settings\.available\)/);
    assert.match(branch, /showSettingsUnavailable\(settings\.message\)/);
  });

  test('tsdown 产出 lib/runtime-settings.js（壳动态 import 的路径）', () => {
    assert.match(readPackageFile('tsdown.config.mjs'), /'runtime-settings': 'src\/host\/runtime-settings\.ts'/);
  });
});

describe('独立模式横幅 —— 提示语与实际菜单一致', () => {
  test('不再声称右键“打开 AI 设置”；说明安装版可从托盘/右键菜单打开', () => {
    assert.ok(!/右键“打开 AI 设置”/.test(standaloneApp), '独立模式 CLI 没有托盘，旧文案与事实不符');
    assert.match(standaloneApp, /安装版/);
    assert.match(standaloneApp, /托盘|右键菜单/);
  });
});
