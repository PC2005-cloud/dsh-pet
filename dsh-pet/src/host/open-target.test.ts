/**
 * 「打开网站」按宿主形态自动分派的契约测试（宿主 = DSH 桌面应用 / dsh web）。
 *
 * 需求：同一个工具项，宿主是**桌面应用**时要"打开桌面端"（把主窗口叫回前台），宿主是 web 时才是
 * "打开网站"（浏览器打开站点）。两半各自构建、无法互相 import，所以按本仓库既有做法读源码断言。
 *
 * 链路（改名/改判据只改一侧即失败）：
 *   宿主 index.ts 判 isDesktopHost → 注入 DSH_PET_OPEN_TARGET=desktop|site
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

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const host = readSource('./index.ts');
const main = readSource('../../runtime/electron-helper/main.js');
const constants = readSource('../../runtime/electron-helper/constants.js');
const sprite = readSource('../../runtime/electron-helper/sprite.js');
const standaloneContext = readSource('../standalone/context.ts');

describe('「打开网站」按宿主形态自动分派', () => {
  test('宿主：桌面应用判定 + 形态注入', () => {
    assert.ok(
      /const isDesktopHost = \(\): boolean => Boolean\(process\.versions\.electron\)/.test(host),
      '宿主必须用 process.versions.electron 判定形态（桌面应用以 ELECTRON_RUN_AS_NODE 跑，该字段仍在；dsh web 是纯 Node）',
    );
    assert.ok(
      /DSH_PET_OPEN_TARGET: isDesktopHost\(\) \? 'desktop' : 'site'/.test(host),
      'launchHelper 必须把形态注入 Helper（否则桌面宿主下仍只会打开浏览器站点）',
    );
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
