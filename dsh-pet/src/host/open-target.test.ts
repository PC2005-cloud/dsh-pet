/**
 * 菜单首项按宿主形态自动分派的契约测试（宿主 = DSH 桌面应用 / dsh web / 独立模式）。
 *
 * 需求：三种形态下同一个工具项要有三种去向与文案——桌面应用「打开软件」（把主窗口叫回前台）、
 * 独立模式「打开 AI 设置」（本机设置页）、dsh web「打开网站」（DSH 站点）。
 * 判定逻辑已抽成纯函数 {@link resolveOpenTarget}，直接断言行为；两侧装配（宿主注入与 helper 解析）
 * 各自构建、无法互相 import，仍用源码断言守住接线。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveOpenTarget } from './plugin/desktop/spawn.ts';

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const host =
  readSource('./index.ts') +
  '\n' +
  readSource('./plugin/desktop-helper.ts') +
  '\n' +
  readSource('./plugin/desktop/spawn.ts');
/** 主进程源码：main.js 是装配根，行为散在 main/ 下的模块里，守卫要读全份。 */
const mainSource = (dir: string): string =>
  [
    readSource(dir + 'main.js'),
    ...readdirSync(fileURLToPath(new URL(dir + 'main/', import.meta.url)))
      .filter((name) => name.endsWith('.js'))
      .map((name) => readSource(dir + 'main/' + name)),
  ].join('\n');
const main = mainSource('../../runtime/electron-helper/');
const constants = readSource('../../runtime/electron-helper/constants.js');
/** 渲染端宠物本体的源码：已按职责拆成 sprite.js 与 sprite-*.js，守卫要读全份。 */
const sprite = [
  readSource('../../runtime/electron-helper/sprite.js'),
  ...readdirSync(fileURLToPath(new URL('../../runtime/electron-helper/sprite/', import.meta.url))).map((name) =>
    readSource('../../runtime/electron-helper/sprite/' + name),
  ),
].join('\n');
const appMain = readSource('../app/main.ts');
const standaloneContext = readSource('../standalone/context.ts');

describe('resolveOpenTarget：形态判定', () => {
  test('Electron 宿主：无论地址指向哪里都是 desktop', () => {
    assert.equal(resolveOpenTarget('http://127.0.0.1:3080/', true), 'desktop');
    assert.equal(
      resolveOpenTarget('http://127.0.0.1:31380/standalone-ai/#token=test-only', true),
      'desktop',
      '桌面应用下不该因为设置页地址被误判成独立模式',
    );
  });

  test('独立模式：地址落在本机设置页 → standalone', () => {
    assert.equal(resolveOpenTarget('http://127.0.0.1:31380/standalone-ai/#token=test-only', false), 'standalone');
  });

  test('web 宿主：站点根地址 → web，不能被顺带判成独立模式', () => {
    assert.equal(
      resolveOpenTarget('http://127.0.0.1:3080/#token=test-only', false),
      'web',
      'dsh web 打开的是 DSH 站点，菜单应显示「打开网站」',
    );
  });
});

describe('装配接线：宿主注入 → helper 解析 → 渲染端文案', () => {
  test('宿主：桌面应用判定 + 三态注入', () => {
    assert.ok(
      /const isDesktopHost = \(\): boolean => Boolean\(process\.versions\.electron\)/.test(host),
      '宿主必须用 process.versions.electron 判定形态（桌面应用以 ELECTRON_RUN_AS_NODE 跑，该字段仍在；dsh web 是纯 Node）',
    );
    assert.ok(
      /DSH_PET_OPEN_TARGET: resolveOpenTarget\(siteUrl, isDesktopHost\(\)\)/.test(host),
      'launchHelper 必须注入三态（只注入 desktop/site 会让 web 与独立模式共用一档）',
    );
  });

  test('helper 主进程：三态解析，未注入回落 web（旧行为）', () => {
    assert.ok(
      /const OPEN_TARGET_RAW = process\.env\.DSH_PET_OPEN_TARGET;\s*const OPEN_TARGET = OPEN_TARGET_RAW === 'desktop' \|\| OPEN_TARGET_RAW === 'standalone' \? OPEN_TARGET_RAW : 'web'/.test(
        main,
      ),
      "非 desktop/standalone 一律回落 'web'（手写 start-desktop 无该变量时行为不得变）",
    );
    assert.ok(/openTarget: OPEN_TARGET/.test(main), '形态要沿窗口 query 透到渲染端（文案在那里决定）');
    assert.ok(/shell\.openExternal\('dsh:\/\/open'\)/.test(main), '桌面宿主必须走 dsh://open 唤起应用窗口');
    assert.ok(
      /(?:OPEN_TARGET|openTarget) === 'desktop'\) \{[\s\S]*?openSite\(url\)/.test(main),
      'dsh:// 失败要回落成打开站点（协议未注册时不能"点了没反应"）',
    );
    assert.ok(
      /const openSite = \(url\) => \{[\s\S]*?shell\.openExternal\(target\)/.test(main),
      'site 路径（含回落）必须仍是原来那条打开站点的实现',
    );
    assert.ok(
      (main.match(/dsh:\/\/open/g) ?? []).length === 1,
      'dsh://open 只允许出现在 desktop 分支里（standalone/web 不得被顺带改成唤起应用）',
    );
  });

  test('helper 渲染端：三态文案查表，动作名不变', () => {
    assert.ok(
      /const OPEN_TARGET_RAW = params\.get\('openTarget'\);\s*const OPEN_TARGET = OPEN_TARGET_RAW === 'desktop' \|\| OPEN_TARGET_RAW === 'standalone' \? OPEN_TARGET_RAW : 'web'/.test(
        constants,
      ),
      "constants.js 必须从 query 读三态且默认 'web'",
    );
    assert.ok(
      /\{ desktop: '打开软件', standalone: '打开 AI 设置', web: '打开网站' \}/.test(sprite),
      '三种形态必须有三种文案，web 不得再显示「打开 AI 设置」',
    );
    assert.ok(
      /OPEN_LABEL\[OPEN_TARGET\]/.test(sprite) && /action: 'open-site'/.test(sprite),
      '非俄语仍查中文表，action 仍是 open-site',
    );
  });

  test('独立模式：App 显式标 standalone，CLI 由地址判定，不另注入形态', () => {
    assert.ok(
      /process\.env\.DSH_PET_OPEN_TARGET = 'standalone'/.test(appMain),
      '独立 App 不经 spawn，必须自己把形态标成 standalone（否则回落 web，文案又变回「打开网站」）',
    );
    assert.ok(
      !/DSH_PET_OPEN_TARGET/.test(standaloneContext),
      '独立模式伪 ctx 不注入形态：App 归 main.ts，CLI 归 spawn 的地址判定',
    );
  });
});
