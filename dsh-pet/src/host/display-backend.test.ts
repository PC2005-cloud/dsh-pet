/**
 * Linux 显示后端选择（`displayBackendArgs` / `withDisplayBackendArgs`）的测试。
 *
 * 桌面宠物在 Linux 上必须跑 X11（XWayland）：宠物的"移动"= 每帧让窗口跟着宠物走，而 Wayland
 * 协议里客户端无权定位自己的顶层窗口，Ozone/Wayland 后端会把 SetBounds 的 x/y 静默丢弃
 * （getBounds 却回显请求值，自检看不出来）。开关只能走命令行——ozone 后端在 JS 主脚本之前就定了。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { displayBackendArgs, withDisplayBackendArgs, OZONE_PLATFORM_ENV } from './helper-process.ts';

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe('displayBackendArgs —— 只有 Linux 需要补显示后端开关', () => {
  test('win32 / darwin 恒为空（行为与改造前逐位一致）', () => {
    for (const platform of ['win32', 'darwin'] as NodeJS.Platform[]) {
      assert.deepEqual(displayBackendArgs(platform, env({ DISPLAY: ':0' })), []);
      assert.deepEqual(displayBackendArgs(platform, env({})), []);
    }
  });

  test('linux 有 DISPLAY（X11 / XWayland）→ 强制 x11', () => {
    assert.deepEqual(displayBackendArgs('linux', env({ DISPLAY: ':0' })), ['--ozone-platform=x11']);
    // Wayland 会话里 XWayland 也会设 DISPLAY：这正是我们要的那条路
    assert.deepEqual(displayBackendArgs('linux', env({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-1' })), [
      '--ozone-platform=x11',
    ]);
  });

  test('linux 没有 DISPLAY（纯 Wayland / 无 XWayland）→ 不加，保持原行为', () => {
    assert.deepEqual(displayBackendArgs('linux', env({ WAYLAND_DISPLAY: 'wayland-1' })), []);
  });

  test(`${OZONE_PLATFORM_ENV} 可覆盖（排障逃生口），空白视为未设`, () => {
    assert.deepEqual(displayBackendArgs('linux', env({ DISPLAY: ':0', DSH_PET_OZONE_PLATFORM: 'wayland' })), [
      '--ozone-platform=wayland',
    ]);
    assert.deepEqual(displayBackendArgs('linux', env({ DISPLAY: ':0', DSH_PET_OZONE_PLATFORM: '   ' })), [
      '--ozone-platform=x11',
    ]);
  });
});

describe('withDisplayBackendArgs —— 开关必须插在 app 路径之前', () => {
  test('linux：开关在最前面（Electron 取第一个非开关参数当 app 路径）', () => {
    assert.deepEqual(
      withDisplayBackendArgs(['/pkg/runtime/electron-helper/main.js'], 'linux', env({ DISPLAY: ':0' })),
      ['--ozone-platform=x11', '/pkg/runtime/electron-helper/main.js'],
    );
  });

  test('已显式指定过就不再追加（两种写法都算）', () => {
    for (const given of ['--ozone-platform=x11', '--ozone-platform']) {
      assert.deepEqual(withDisplayBackendArgs([given, 'main.js'], 'linux', env({ DISPLAY: ':0' })), [given, 'main.js']);
    }
  });

  test('非 linux 原样返回', () => {
    assert.deepEqual(withDisplayBackendArgs(['main.js'], 'win32', env({ DISPLAY: ':0' })), ['main.js']);
  });

  test('linux 无 DISPLAY 时也原样返回', () => {
    assert.deepEqual(withDisplayBackendArgs(['main.js'], 'linux', env({})), ['main.js']);
  });
});

describe('源码守卫 —— 两个 spawn 路径都要补开关', () => {
  const electronSrc = readFileSync(fileURLToPath(new URL('./helper/electron.ts', import.meta.url)), 'utf8');
  const childSrc = readFileSync(fileURLToPath(new URL('./helper/child.ts', import.meta.url)), 'utf8');

  test('defaultLaunch 与 HelperProcess.start 都用 withDisplayBackendArgs 构造 argv', () => {
    assert.ok(
      /return \{ command: electronPath, args: withDisplayBackendArgs\(\[helperPath\]\) \};/.test(electronSrc),
      'defaultLaunch 必须补开关',
    );
    assert.ok(
      /const args = electronLike\s*\n?\s*\? withDisplayBackendArgs\(rawArgs, process\.platform, helperSpawnEnv\(process\.pid, this\.options\.env\)\)\s*\n?\s*: rawArgs;/.test(
        childSrc,
      ),
      'HelperProcess.start 必须补开关（自定义 command 只在确实是 Electron 时才补）',
    );
    assert.ok(/const electronLike = /.test(childSrc), '自定义 command 要先判定是不是 Electron');
  });

  test('纯 Wayland（无 DISPLAY）时宿主侧要告警，而不是静默失效', () => {
    assert.ok(/没有 DISPLAY/.test(childSrc), '必须有"无 DISPLAY"的告警');
  });
});
