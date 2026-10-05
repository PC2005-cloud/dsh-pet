/**
 * 独立模式侧：默认声明自己的 Electron 用户数据目录（判定见 src/host/user-data-dir.test.ts）。
 *
 * 为什么必须由独立模式来声明：插件是被两个宿主共用的库（DSH 内 / 独立模式），而 helper 的
 * userData 由它自己的 `app.setName` 决定、与宿主是谁无关 —— 所以"各用一份 profile"这件事
 * 只能由**独立模式这个新宿主**提出；DSH 内运行不设该变量，行为一字不改。
 *
 * 这里钉四件事：目录落在 DSH_HOME 下、与 helper 的默认目录不同名、CLI 只在用户没显式指定时才设、
 * 且设置必须早于 `apply()`（helper 由 apply 拉起，晚设就来不及）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { standaloneUserDataDir } from './options.ts';

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('standaloneUserDataDir —— 独立模式的数据目录', () => {
  test('落在 DSH_HOME 的 dsh-pet 下（与配置、文件宠物同根，备份/清理/排障一处搞定）', () => {
    assert.equal(standaloneUserDataDir('/home/.dsh'), join('/home/.dsh', 'dsh-pet', 'standalone-electron'));
  });

  test('不得与 helper 的默认目录同名（默认是 %APPDATA%\\dsh-pet-electron-helper）', () => {
    assert.ok(!standaloneUserDataDir('/home/.dsh').includes('dsh-pet-electron-helper'));
  });
});

describe('守卫：独立模式 CLI 必须默认设好它，且早于 apply()', () => {
  const cli = readSource('./cli.ts');

  test('只在用户没显式指定时才设（尊重 DSH_PET_USER_DATA_DIR）', () => {
    assert.ok(/if \(!process\.env\.DSH_PET_USER_DATA_DIR\)/.test(cli), '用户的显式设置必须优先');
    assert.ok(
      /process\.env\.DSH_PET_USER_DATA_DIR = standaloneUserDataDir\(home\)/.test(cli),
      '默认值必须来自 options.standaloneUserDataDir（别在 CLI 里手拼路径）',
    );
  });

  test('必须早于 apply()：helper 由 apply 拉起，晚设就来不及', () => {
    const setAt = cli.indexOf('process.env.DSH_PET_USER_DATA_DIR = standaloneUserDataDir(home)');
    const applyAt = cli.indexOf('apply(context.ctx)');
    assert.ok(setAt > 0, '找不到设置点（文件结构变了，请同步本断言）');
    assert.ok(applyAt > 0, '找不到 apply 调用点');
    assert.ok(setAt < applyAt, 'env 必须在 apply 之前设好，helper 才会继承到');
  });

  test('启动横幅报出数据目录（桌宠没出现时第一眼看这里）', () => {
    assert.ok(/数据目录/.test(cli), '横幅要写明实际使用的 Electron 数据目录');
  });
});
