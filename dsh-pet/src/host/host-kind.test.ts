/**
 * 宿主形态判定（ticket 08）的纯逻辑测试。
 *
 * 三种形态，对应「打开网站」的三种语义：
 *   desktop  = 跑在 DSH 桌面应用里 → 唤起 DSH 主窗口（helper 走 dsh://open）
 *   site     = dsh web / 独立模式 CLI → 系统浏览器打开站点
 *   packaged = 安装版自带 Electron 运行时 → 系统浏览器打开**本机服务地址**（与 site 同一语义）
 *
 * 判据必须由启动方显式传入（DSH_PET_HOST_KIND）：打包宿主自己就是 Electron 进程，
 * 单看 `process.versions.electron` 会把它误判成 DSH 桌面应用（ticket 08 的 bug）。
 * 嗅探只作为兼容回退保留给「DSH 桌面应用启动插件、无法注入环境变量」这一种形态。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openTargetForHostKind, resolveHostKind } from './host-kind.ts';

describe('resolveHostKind —— 显式 DSH_PET_HOST_KIND 优先于运行时嗅探', () => {
  test('显式 desktop：即使进程里没有 Electron 字段也判定为桌面应用', () => {
    assert.equal(resolveHostKind({ DSH_PET_HOST_KIND: 'desktop' }, {}), 'desktop');
  });

  test('显式 site：即使运行在 Electron 里也判定为站点', () => {
    assert.equal(resolveHostKind({ DSH_PET_HOST_KIND: 'site' }, { electron: '43.3.0' }), 'site');
  });

  test('显式 packaged：自带 Electron 运行时的安装版，绝不能被当成 DSH 桌面应用', () => {
    assert.equal(resolveHostKind({ DSH_PET_HOST_KIND: 'packaged' }, { electron: '43.3.0' }), 'packaged');
  });
});

describe('resolveHostKind —— 未设置时回退嗅探（只兼容 DSH 启动的插件形态）', () => {
  test('未设置 + 有 Electron → desktop（DSH 以 ELECTRON_RUN_AS_NODE 跑插件，该字段仍在）', () => {
    assert.equal(resolveHostKind({}, { electron: '43.3.0' }), 'desktop');
  });

  test('未设置 + 无 Electron → site（dsh web / 独立模式 CLI）', () => {
    assert.equal(resolveHostKind({}, {}), 'site');
  });

  test('空值与未知值等同未设置，仍走嗅探（脏环境不能把行为改坏）', () => {
    assert.equal(resolveHostKind({ DSH_PET_HOST_KIND: '' }, { electron: '43.3.0' }), 'desktop');
    assert.equal(resolveHostKind({ DSH_PET_HOST_KIND: '' }, {}), 'site');
    assert.equal(resolveHostKind({ DSH_PET_HOST_KIND: 'bogus' }, { electron: '43.3.0' }), 'desktop');
    assert.equal(resolveHostKind({ DSH_PET_HOST_KIND: 'bogus' }, {}), 'site');
  });

  test('纯函数：不修改传入的 env', () => {
    const env: Record<string, string | undefined> = { DSH_PET_HOST_KIND: 'packaged' };
    resolveHostKind(env, { electron: '43.3.0' });
    assert.deepEqual(env, { DSH_PET_HOST_KIND: 'packaged' });
  });
});

describe('openTargetForHostKind —— 注入给桌面壳的「打开网站」去向', () => {
  test('只有 DSH 桌面应用走 desktop；site 与 packaged 都必须走 site', () => {
    assert.equal(openTargetForHostKind('desktop'), 'desktop');
    assert.equal(openTargetForHostKind('site'), 'site');
    assert.equal(openTargetForHostKind('packaged'), 'site');
  });
});
