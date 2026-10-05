/**
 * 「独立模式与 DSH 内运行各用一份 Electron 用户数据目录」的纯判定 + 接线守卫。
 *
 * 事实链（0.3.5 发版后真机复现）：
 *   ① helper 用 `app.setName('dsh-pet-electron-helper')` 定名 → userData 落在
 *      `%APPDATA%\dsh-pet-electron-helper`，**与哪个宿主把它拉起来无关**；
 *   ② 于是「DSH 内那只」与「独立模式那只」默认共用同一个 Chromium profile；
 *   ③ 后启动的那只拿不到 profile 锁 —— 真机日志
 *      `ERROR:net\disk_cache\cache_util_win.cc:25 Unable to move the cache: 拒绝访问。 (0x5)`、
 *      `Unable to create cache`、`Gpu Cache Creation failed: -2`；helper 只起来 1 个子进程
 *      （正常 3 个）、渲染端**一个素材请求都没有** → 宠物画不出来。
 *      也就是说：这不是"良性缓存警告"（0.3.2 的 PR 里我是这么写的），是硬冲突。
 *   ④ 旁路全部无效：只给这个子进程改 `%APPDATA%`（Windows 上 Electron 取路径走系统 API，
 *      不读环境变量 —— 实测隔离目录里空无一物、缓存错误照旧）；没有 Chromium 参数的注入口；
 *      `hasGraphicalDisplay()` 在 win32 恒为 true（没有"关掉某一侧桌面小窗"的开关）。
 *
 * 所以由**独立模式**（src/standalone/cli.ts）默认声明 `DSH_PET_USER_DATA_DIR`，main.js 在
 * **任何一次 getPath('userData') 之前**把它设进 Electron；helper 的 DPI 探测子进程继承同一份
 * env，于是也落在同一目录。DSH 内运行不设这个变量，行为与以前完全一致。
 *
 * 与 host-liveness.test.ts 同样的限制：helper 是随包发行的手写 JS，而开发机上跑不起 Electron，
 * 因此这里的接线只能靠源码断言 + 纯函数测试（node:test，不引入依赖）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { resolveUserDataDir } = require(helper + 'user-data-dir.js');

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('resolveUserDataDir —— 覆盖目录解析', () => {
  test('未设 / 空串 / 纯空白 → null（维持 Electron 默认，绝不动老行为）', () => {
    for (const raw of [undefined, null, '', '   ', '\t\n']) {
      assert.equal(resolveUserDataDir({ DSH_PET_USER_DATA_DIR: raw as string }), null, 'raw=' + JSON.stringify(raw));
    }
    assert.equal(resolveUserDataDir({}), null);
    assert.equal(resolveUserDataDir(undefined as never), null);
  });

  test('非字符串（被上游传成数字/对象）→ null，且不抛', () => {
    assert.equal(resolveUserDataDir({ DSH_PET_USER_DATA_DIR: 42 as never }), null);
    assert.equal(resolveUserDataDir({ DSH_PET_USER_DATA_DIR: { dir: 'x' } as never }), null);
  });

  test('相对路径 → 绝对路径（app.setPath 只吃绝对路径），首尾空白裁掉', () => {
    const dir = resolveUserDataDir({ DSH_PET_USER_DATA_DIR: '  tmp/standalone-profile  ' });
    assert.equal(dir, resolve('tmp/standalone-profile'));
    assert.ok(dir !== null && (dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir)), '必须是绝对路径：' + String(dir));
  });

  test('已是绝对路径则原样返回（只做规范化）', () => {
    const abs = resolve(resolve('.'), 'dsh-pet-standalone-profile');
    assert.equal(resolveUserDataDir({ DSH_PET_USER_DATA_DIR: abs }), abs);
  });
});

describe('守卫：main.js 必须在任何 getPath(userData) 之前设好目录', () => {
  const main = readSource(helper + 'main.js');

  test('接线：require 新模块 → 纯函数解析 → app.setPath', () => {
    assert.ok(/require\('\.\/user-data-dir\.js'\)/.test(main), '必须 require user-data-dir.js');
    assert.ok(
      /const userDataDir = resolveUserDataDir\(process\.env\)/.test(main),
      '解析必须走纯函数（env 显式注入，便于单测）',
    );
    assert.ok(/app\.setPath\('userData', userDataDir\)/.test(main), '必须真的设进 Electron');
  });

  test('顺序：setPath 早于首次使用（DPI 缓存是模块级调用，加载时就真读一次）', () => {
    const setAt = main.indexOf("app.setPath('userData', userDataDir)");
    // 锚点必须精确到 `app.getPath(...)`：本块的注释里也出现了 getPath('userData') 这个词
    const firstGetAt = main.indexOf("app.getPath('userData')");
    const firstUseAt = main.indexOf('PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();');
    assert.ok(setAt > 0, '找不到 setPath 调用点（文件结构变了，请同步本断言）');
    assert.ok(firstGetAt > 0, "找不到 app.getPath('userData') 的使用点");
    assert.ok(firstUseAt > 0, '找不到 DPI 缓存的模块级调用点（文件结构变了，请同步本断言）');
    assert.ok(setAt < firstGetAt, "必须早于 app.getPath('userData')：晚了 profile 与 DPI 缓存仍落在默认目录");
    assert.ok(setAt < firstUseAt, '必须早于模块级的 DPI 缓存读取——那是函数体之外第一次真的用它');
  });

  test('顺序：也必须早于 app ready（Chromium 在启动时定 profile）', () => {
    const setAt = main.indexOf("app.setPath('userData', userDataDir)");
    const readyAt = main.indexOf('app.whenReady()');
    assert.ok(readyAt > 0, '找不到 app.whenReady()（文件结构变了，请同步本断言）');
    assert.ok(setAt < readyAt, '必须早于 ready');
  });

  test('设置失败只报警不阻断启动（一个读不懂的环境变量不该让桌宠起不来）', () => {
    assert.ok(
      /catch \(error\) \{/.test(
        main.slice(main.indexOf("app.setPath('userData'"), main.indexOf("app.setPath('userData'") + 400),
      ),
      'setPath 必须有兜底',
    );
    assert.ok(/DSH_PET_USER_DATA_DIR=/.test(main), '失败信息要带上这个变量名，便于定位');
  });
});

describe('守卫：user-data-dir.js 必须在发布必需清单里', () => {
  test('prepack-check.js 的 required 含它（main.js require，缺了会启动即崩）', () => {
    const src = readSource('../../scripts/prepack-check.js');
    assert.ok(/'runtime\/electron-helper\/user-data-dir\.js'/.test(src), '漏了它，npm 包里就少一个 main.js 必需的模块');
  });
});
