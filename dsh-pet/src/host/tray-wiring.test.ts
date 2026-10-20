/**
 * 应用托盘的跨进程接线契约（ticket 06）。
 *
 * 托盘是系统 UI，node:test 点不到；这里钉住的是两条「接线不能错」的事实：
 *   - 打包形态只有宿主建托盘（壳里跳过），插件形态壳仍建托盘（唯一入口）；
 *   - Electron 调用集中在 desktop/tray.mjs，菜单文案/动作语义仍来自纯函数，
 *     退出必须走独立模式的 shutdown（不是裸 app.exit）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 读包根下的文件（本测试位于 src/host/，包根是两级之上） */
function readPackageFile(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

describe('桌面壳 —— 打包形态不再自建托盘', () => {
  const source = readPackageFile('runtime/electron-helper/main.js');

  test('插件形态仍建托盘；打包形态（DSH_PET_PACKAGED=1）跳过，避免第二个图标', () => {
    assert.match(source, /async function startTray\(/);
    assert.match(source, /if \(process\.env\.DSH_PET_PACKAGED !== '1'\) void startTray\(\);/);
  });

  test('壳仍用纯函数模板（本 ticket 不改模板，也不在壳里另拼应用项）', () => {
    assert.match(source, /buildTrayMenuTemplate\(\{ pets \}\)/);
  });
});

describe('desktop/tray.mjs —— 宿主托盘接线', () => {
  const source = readPackageFile('desktop/tray.mjs');

  test('菜单模板复用 runtime/electron-helper/tray-menu.js，动作分发复用 lib/tray-actions.js', () => {
    assert.match(source, /require\('\.\.\/runtime\/electron-helper\/tray-menu\.js'\)/);
    assert.match(source, /buildTrayMenuTemplate\(/);
    assert.match(source, /\.\.\/lib\/tray-actions\.js/);
    assert.match(source, /dispatchTrayAction/);
    // 菜单文案住在模板里；这里不得再手写应用菜单项
    assert.ok(!/label:\s*'退出'/.test(source), '退出项文案必须来自模板');
    assert.ok(!/label:\s*'打开 AI 设置…'/.test(source), 'AI 设置项文案必须来自模板');
  });

  test('宠物勾选与配置读取走本机 HTTP + token，不直连 apply 内部', () => {
    assert.match(source, /x-dsh-pet-token/);
    assert.match(source, /\/dsh-pet-7340\/pet-display/);
    assert.match(source, /\/dsh-pet-7340\/config/);
    assert.match(source, /handle\.token/);
  });

  test('自启走 Electron 登录项 API，并使用 --autostart 参数', () => {
    assert.match(source, /getLoginItemSettings/);
    assert.match(source, /setLoginItemSettings/);
    assert.match(source, /--autostart/);
  });

  test('退出：先销毁托盘，再走 handle.shutdown，完成后 app.exit(0)', () => {
    const quitAt = source.indexOf("case 'quit'");
    assert.ok(quitAt > 0, '必须处理 quit 动作');
    const quitBranch = source.slice(quitAt, source.indexOf('default:', quitAt));
    assert.match(quitBranch, /quit\(/);
    assert.match(source, /tray\.destroy\(\)/);
    assert.match(source, /await handle\.shutdown\('tray-quit'\)/);
    assert.match(source, /app\.exit\(0\)/);
  });

  test('数据目录用 <DSH_HOME>/dsh-pet；设置 URL 是能力令牌，不得写日志', () => {
    assert.match(source, /petDataDir\(home\)/);
    assert.ok(!/console\.(?:log|info|warn|error)\([^)]*settingsUrl/i.test(source));
    assert.ok(!/console\.[a-z]+\([^)]*effect\.url/i.test(source));
  });

  test('只创建一个 Tray（单一图标），并暴露仅测试用的钩子', () => {
    assert.equal((source.match(/new Tray\(/g) ?? []).length, 1, '重复创建会得到多个托盘图标');
    assert.match(source, /globalThis\.__dshPetTray/);
  });
});

describe('desktop/main.mjs —— 宿主启动后接托盘', () => {
  const source = readPackageFile('desktop/main.mjs');

  test('仅在打包形态、startStandalone 之后创建托盘；失败不拖垮宿主', () => {
    const startAt = source.indexOf('await startStandalone(');
    const trayAt = source.indexOf("import('./tray.mjs')");
    assert.ok(startAt > 0, '宿主角色必须调用 startStandalone');
    assert.ok(trayAt > startAt, '托盘必须在宿主服务启动后创建（要用端口与 token 读配置）');
    assert.match(source, /process\.env\.DSH_PET_PACKAGED === '1'/);
    assert.match(source, /startAppTray/);
    assert.match(source, /托盘创建失败/);
  });

  test('托盘创建不得阻塞入口模块求值（否则与 app.whenReady() 死锁）', () => {
    assert.match(source, /void import\('\.\/tray\.mjs'\)/);
    assert.ok(!/await import\('\.\/tray\.mjs'\)/.test(source), 'top-level await 会让 Electron 永远不触发 ready');
    assert.ok(!/await startAppTray\(/.test(source), 'startAppTray 内部等 app.whenReady()，不能在入口里 await');
  });
});

describe('构建与发布 —— 新入口随包发行', () => {
  test('tsdown 产出 lib/tray-actions.js（desktop/tray.mjs 直接 import）', () => {
    assert.match(readPackageFile('tsdown.config.mjs'), /'tray-actions'/);
  });

  test('electron-builder 的 desktop/**/* 白名单覆盖 tray.mjs', () => {
    assert.match(readPackageFile('electron-builder.yml'), /desktop\/\*\*\/\*/);
  });
});

describe('startStandalone 句柄 —— 暴露托盘请求所需的能力令牌', () => {
  test('app.ts 返回 token（与 settingsUrl 同一份，不在 HTTP 响应/日志里泄漏）', () => {
    assert.match(readPackageFile('src/standalone/app.ts'), /token:\s*security\.token/);
  });
});
