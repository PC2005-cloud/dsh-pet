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
import { readFileSync } from 'node:fs';

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

describe('独立模式 CLI —— 启动方显式传入 site（ticket 08 的契约）', () => {
  const cliSource = readFileSync(new URL('../standalone/cli.ts', import.meta.url), 'utf8');

  test('CLI 入口在启动服务前设置 DSH_PET_HOST_KIND=site', () => {
    assert.match(cliSource, /import \{ HOST_KIND_ENV \} from '\.\.\/host\/host-kind'/, '必须复用常量，不能散落字符串');
    const setAt = cliSource.search(/if \(!process\.env\[HOST_KIND_ENV\]\) process\.env\[HOST_KIND_ENV\] = 'site';/);
    assert.ok(setAt > 0, 'CLI 必须显式声明独立模式为 site');
    const startAt = cliSource.indexOf('await startStandalone(');
    assert.ok(startAt > setAt, '声明必须发生在启动服务之前');
  });

  test('已显式传入时不覆盖（环境变量优先），且未设置时 resolveHostKind 得到 site', () => {
    assert.match(cliSource, /if \(!process\.env\[HOST_KIND_ENV\]\)/, '只在缺省时写入，避免覆盖启动方的显式选择');
    // 与 CLI 的写入语义一致：缺省时置为 site，之后解析结果就是 site（纯 Node 进程的嗅探回退也是 site）
    const env: Record<string, string | undefined> = {};
    if (!env.DSH_PET_HOST_KIND) env.DSH_PET_HOST_KIND = 'site';
    assert.equal(resolveHostKind(env, {}), 'site');
  });
});
