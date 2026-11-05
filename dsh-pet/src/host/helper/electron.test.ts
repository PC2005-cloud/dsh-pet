/**
 * Helper 启动参数（src/host/helper/electron.ts 的 helperLaunchArgs 与 shouldForceXWayland）的契约测试：
 * 开关排在脚本路径之前；Wayland 只有在 XWayland（DISPLAY）存在时才强制 X11。
 * 不断言 DESKTOP_DEBUG_PORT 的具体取值：它是可以手动切换的排障开关，断言取值会让本地调试与测试互相打架。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DESKTOP_DEBUG_PORT, helperLaunchArgs, shouldForceXWayland } from './electron.ts';

describe('helperLaunchArgs —— 桌面 Helper 启动参数', () => {
  test('端口 0：只有脚本路径，不挂调试开关', () => {
    assert.deepEqual(helperLaunchArgs('/x/main.js', { debugPort: 0 }), ['/x/main.js']);
  });

  test('给定端口：调试开关排在脚本路径之前', () => {
    assert.deepEqual(helperLaunchArgs('/x/main.js', { debugPort: 9222 }), [
      '--remote-debugging-port=9222',
      '/x/main.js',
    ]);
  });

  test('强制 XWayland：ozone 开关同样排在脚本路径之前', () => {
    assert.deepEqual(helperLaunchArgs('/x/main.js', { debugPort: 0, forceX11: true }), [
      '--ozone-platform=x11',
      '/x/main.js',
    ]);
  });

  test('XWayland 与调试开关同时存在：先 ozone 后调试端口，脚本仍在最后', () => {
    assert.deepEqual(helperLaunchArgs('/x/main.js', { debugPort: 9222, forceX11: true }), [
      '--ozone-platform=x11',
      '--remote-debugging-port=9222',
      '/x/main.js',
    ]);
  });

  test('默认参数跟随 DESKTOP_DEBUG_PORT：0 关、非 0 开', () => {
    const expected =
      DESKTOP_DEBUG_PORT > 0 ? ['--remote-debugging-port=' + DESKTOP_DEBUG_PORT, '/x/main.js'] : ['/x/main.js'];
    assert.deepEqual(helperLaunchArgs('/x/main.js'), expected);
  });
});

describe('shouldForceXWayland —— Wayland 会话是否强制 X11', () => {
  test('linux + Wayland + XWayland：强制', () => {
    assert.equal(shouldForceXWayland({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'linux'), true);
  });

  test('纯 Wayland（无 DISPLAY）：不强制', () => {
    assert.equal(shouldForceXWayland({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), false);
  });

  test('X11 会话（无 WAYLAND_DISPLAY）：不强制', () => {
    assert.equal(shouldForceXWayland({ DISPLAY: ':0' }, 'linux'), false);
  });

  test('非 linux 平台：不强制', () => {
    assert.equal(shouldForceXWayland({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'win32'), false);
    assert.equal(shouldForceXWayland({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, 'darwin'), false);
  });
});
