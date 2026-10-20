/**
 * 单实例唤回的接线契约（ticket 05）。
 *
 * 纯逻辑（cb 推导/等待/时序闸门）在 single-instance.test.ts 里测；这里只钉**跨文件/跨进程**
 * 的接线，防止后续重构把关键顺序改掉：
 *   - 单实例锁只在宿主分支、且在启动服务之前：被 spawn 的桌面壳（--dsh-pet-helper）
 *     与 DPI 探测（--dsh-pet-dpi-probe）绝不能参与锁，否则第二个宠物窗口会被判成重复实例；
 *   - second-instance 必须经 createFocusGate 延后到 startStandalone 返回之后
 *     （自启延迟启动期间的手动双击不能提前唤出）；
 *   - 唤回入口经 startStandalone 句柄暴露，主进程不再另开通道；
 *   - 新增的 lib/single-instance.js 要进 tsdown 产物与安装包白名单。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 读包根下的文件（本测试位于 src/host/，包根是两级之上） */
function readPackageFile(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
}

const mainSource = readPackageFile('desktop/main.mjs');
const appSource = readPackageFile('src/standalone/app.ts');
const helperProcessSource = readPackageFile('src/host/helper-process.ts');

describe('desktop/main.mjs —— 单实例锁与二次启动唤回', () => {
  test('宿主分支在启动服务前取锁；拿不到锁立即退出', () => {
    const lock = mainSource.indexOf('requestSingleInstanceLock(');
    const start = mainSource.indexOf('startStandalone(');
    assert.ok(lock >= 0, '必须取单实例锁');
    assert.ok(start >= 0, '必须启动独立模式');
    assert.ok(lock < start, '锁必须在启动服务/窗口之前');
    assert.match(mainSource, /if\s*\(\s*!\s*app\.requestSingleInstanceLock\(\)\s*\)/);
    assert.match(mainSource, /app\.exit\(0\)/);
  });

  test('锁只出现在宿主分支：角色分流先于取锁，且全文件只有一处取锁', () => {
    const roleBranch = mainSource.search(/invocation\.role === ['"]helper['"]/);
    const lock = mainSource.indexOf('requestSingleInstanceLock(');
    assert.ok(roleBranch >= 0, '必须先按角色分流');
    assert.ok(roleBranch < lock, '被 spawn 的壳 / DPI 探测不能走到取锁分支');
    assert.equal(mainSource.split('requestSingleInstanceLock(').length - 1, 1, '取锁只允许出现在宿主分支（一处）');
  });

  test('second-instance 经 createFocusGate 延后到启动完成之后', () => {
    assert.match(mainSource, /app\.on\(\s*['"]second-instance['"]/);
    assert.match(mainSource, /createFocusGate\(/);
    assert.match(mainSource, /gate\.request\(\)/);
    const start = mainSource.indexOf('startStandalone(');
    const ready = mainSource.indexOf('gate.markReady()');
    assert.ok(start >= 0 && ready >= 0, '必须启动服务并在完成后调用 markReady');
    assert.ok(start < ready, 'markReady 必须在 startStandalone 返回之后（延迟启动不被提前打断）');
  });
});

describe('startStandalone 句柄 —— 宿主级唤回入口', () => {
  test('句柄暴露 focusWindows，并委派给 helper-process 的登记表入口', () => {
    assert.match(appSource, /focusWindows/);
    assert.match(appSource, /focusDesktopWindows/);
    assert.match(helperProcessSource, /export async function focusDesktopWindows/);
  });
});

describe('构建产物 —— lib/single-instance.js 必须进包', () => {
  test('tsdown 产出 single-instance 入口，desktop/main.mjs 从 lib 引它', () => {
    const tsdown = readPackageFile('tsdown.config.mjs');
    assert.match(tsdown, /['"]single-instance['"]\s*:\s*['"]src\/host\/single-instance\.ts['"]/);
    assert.match(mainSource, /\.\.\/lib\/single-instance\.js/);
  });

  test('electron-builder 的 lib/** 白名单覆盖新入口', () => {
    const yml = readPackageFile('electron-builder.yml');
    assert.match(yml, /lib\/\*\*\/\*/);
  });
});
