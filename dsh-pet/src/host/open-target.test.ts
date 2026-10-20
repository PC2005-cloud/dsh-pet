/**
 * 「打开网站」按宿主形态自动分派的契约测试（三种形态，ticket 08）。
 *
 * 需求：同一个工具项，
 *   - DSH 桌面应用里 → "打开桌面端"（把主窗口叫回前台，helper 走 dsh://open）；
 *   - dsh web / 独立模式 CLI → "打开网站"（浏览器打开站点）；
 *   - **安装版（自带 Electron 运行时）** → 同样是浏览器打开**本机服务地址**，绝不能去唤起
 *     一个不存在的 dsh:// 协议。
 * 两半各自构建、无法互相 import，所以按本仓库既有做法读源码断言 + 直接测纯判定函数。
 *
 * 链路（改名/改判据只改一侧即失败）：
 *   启动方显式传入 DSH_PET_HOST_KIND（desktop/site/packaged；未设置时兼容嗅探）
 *   → 宿主 index.ts 经 resolveHostKind / openTargetForHostKind 注入 DSH_PET_OPEN_TARGET=desktop|site
 *   → helper main.js 读该变量（并沿 query 透给渲染端）→ desktop: shell.openExternal('dsh://open')，
 *     site: 原行为 shell.openExternal(站点 URL) → 渲染端据此改菜单文案。
 *
 * 为什么是 `dsh://open` 而不是 spawn 宿主 exe：DSH 桌面端自己 app.setAsDefaultProtocolClient('dsh') 并
 * 注册了 open-url → focusPrimaryWindow()，Windows 上再启动一次则由单实例锁把 second-instance 交给
 * 现有实例（claimDesktopSingleInstance(app, () => focusPrimaryWindow())）。spawn exe 会继承宿主的
 * ELECTRON_RUN_AS_NODE=1（起出来是 node 而非界面），还要自己探测安装路径——协议两样都不用管。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { openTargetForHostKind, resolveHostKind } from './host-kind.ts';

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const host = readSource('./index.ts');
const main = readSource('../../runtime/electron-helper/main.js');
const constants = readSource('../../runtime/electron-helper/constants.js');
const sprite = readSource('../../runtime/electron-helper/sprite.js');
const standaloneContext = readSource('../standalone/context.ts');

describe('「打开网站」按宿主形态自动分派', () => {
  test('宿主：形态由启动方显式传入 + 注入 Helper', () => {
    assert.ok(
      /const hostKind = \(\): HostKind => resolveHostKind\(process\.env, process\.versions\)/.test(host),
      '宿主必须读显式的 DSH_PET_HOST_KIND（经 resolveHostKind），不能再用裸 process.versions.electron 判定',
    );
    assert.ok(
      /DSH_PET_OPEN_TARGET: openTargetForHostKind\(hostKind\(\)\)/.test(host),
      'launchHelper 必须把形态注入 Helper（否则桌面宿主下仍只会打开浏览器站点）',
    );
    assert.ok(
      !/Boolean\(process\.versions\.electron\)/.test(host),
      '不得保留「是不是 Electron 进程」这种运行时嗅探式判定（打包形态自己就带 Electron）',
    );
  });

  test('三种形态 → 注入去向：packaged 必须得到 site 语义', () => {
    const cases = [
      ['desktop', 'desktop'],
      ['site', 'site'],
      ['packaged', 'site'],
    ] as const;
    for (const [kind, expected] of cases) {
      assert.equal(
        openTargetForHostKind(resolveHostKind({ DSH_PET_HOST_KIND: kind }, { electron: '43.3.0' })),
        expected,
        `${kind} 形态的去向必须是 ${expected}`,
      );
    }
    // 兼容回退：DSH 桌面应用启动插件时无法注入变量
    assert.equal(openTargetForHostKind(resolveHostKind({}, { electron: '43.3.0' })), 'desktop');
    // 独立模式 CLI：未设置且无 Electron
    assert.equal(openTargetForHostKind(resolveHostKind({}, {})), 'site');
  });

  test('helper 主进程：desktop 走 dsh:// 协议，site 保持原行为', () => {
    assert.ok(
      /const OPEN_TARGET = process\.env\.DSH_PET_OPEN_TARGET === 'desktop' \? 'desktop' : 'site'/.test(main),
      "main.js 必须把非 'desktop' 一律当 'site'（旧宿主 / 独立模式 / 手写 start-desktop 行为不得变）",
    );
    assert.ok(/openTarget: OPEN_TARGET/.test(main), '形态要沿窗口 query 透到渲染端（文案在那里决定）');
    assert.ok(/shell\.openExternal\('dsh:\/\/open'\)/.test(main), '桌面宿主必须走 dsh://open 唤起应用窗口');
    assert.ok(
      /OPEN_TARGET === 'desktop'\) \{[\s\S]*?openSite\(url\)/.test(main),
      'dsh:// 失败要回落成打开站点（协议未注册时不能"点了没反应"）',
    );
    assert.ok(
      /const openSite = \(url\) => \{[\s\S]*?shell\.openExternal\(target\)/.test(main),
      'site 路径（含回落）必须仍是原来那条打开站点的实现',
    );
    assert.ok(
      (main.match(/dsh:\/\/open/g) ?? []).length === 1,
      'dsh://open 只允许出现在 desktop 分支里（site 形态不得被顺带改成唤起应用）',
    );
  });

  test('helper 渲染端：文案随形态变，动作名不变', () => {
    assert.ok(
      /const OPEN_TARGET = params\.get\('openTarget'\) === 'desktop' \? 'desktop' : 'site'/.test(constants),
      "constants.js 必须从 query 读形态且默认 'site'",
    );
    assert.ok(
      /label: OPEN_TARGET === 'desktop' \? '打开 DeepSeek Harness' : '打开网站', action: 'open-site'/.test(sprite),
      '菜单文案要跟着变，但 action 仍是 open-site（另一端只认这个动作名）',
    );
  });

  test('独立模式不注入该变量 → 自动回落 site（不破坏"不打开 DSH 也能养桌宠"）', () => {
    assert.ok(!/DSH_PET_OPEN_TARGET/.test(standaloneContext), '独立模式必须不注入形态：默认 site，行为与以前一致');
  });
});
