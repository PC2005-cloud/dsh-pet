/**
 * helper-process 单元测试 —— 聚焦保留的 Electron 解析/定位纯逻辑。
 *
 * 下载（@electron/get）与解压（@electron-internal/extract-zip）已由官方库接管，
 * 不再有手写 zip 解析/平台命令链，故原 extractAttempts/extractZipWithNode 测试随代码删除。
 * 这里测的是 resolveElectronPath 的候选优先级、DSH_PET_ELECTRON_PATH 环境变量覆盖、
 * 以及 dshHomeDir/defaultElectronExe 的路径拼装——这些是本文件仍然自己实现的部分。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖：
 *   node --experimental-strip-types --test src/host/helper-process.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dshHomeDir, defaultElectronExe, resolveElectronPath } from './helper-process.ts';

/** 建一个隔离的临时目录,并归还原 DSH_HOME / DSH_PET_ELECTRON_PATH 环境变量 */
function withIsolatedHome(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-test-'));
  const savedHome = process.env.DSH_HOME;
  const savedPath = process.env.DSH_PET_ELECTRON_PATH;
  try {
    process.env.DSH_HOME = join(dir, 'dshhome');
    process.env.DSH_PET_ELECTRON_PATH = '';
    fn(dir);
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedPath === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
    else process.env.DSH_PET_ELECTRON_PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('dshHomeDir —— $DSH_HOME 解析', () => {
  test('优先认 DSH_HOME 环境变量', () => {
    withIsolatedHome((dir) => {
      process.env.DSH_HOME = join(dir, 'custom');
      assert.equal(dshHomeDir(), join(dir, 'custom'));
    });
  });

  test('未设 DSH_HOME 时回落到 ~/.dsh', () => {
    withIsolatedHome(() => {
      delete process.env.DSH_HOME;
      const userProfile = process.env.USERPROFILE || process.env.HOME || '';
      assert.equal(dshHomeDir(), join(userProfile, '.dsh'));
    });
  });
});

describe('defaultElectronExe —— 落地可执行文件路径', () => {
  test('在 $DSH_HOME/electron 下按平台拼可执行文件', () => {
    withIsolatedHome((dir) => {
      process.env.DSH_HOME = join(dir, 'custom');
      const rel =
        process.platform === 'win32'
          ? 'electron.exe'
          : process.platform === 'darwin'
            ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
            : 'electron';
      assert.equal(defaultElectronExe(), join(dir, 'custom', 'electron', rel));
    });
  });
});

describe('resolveElectronPath —— 候选优先级', () => {
  test('显式候选命中时直接返回（不读环境变量）', () => {
    withIsolatedHome((dir) => {
      const fake = join(dir, 'fake-electron.exe');
      writeFileSync(fake, '');
      const other = join(dir, 'other-electron.exe');
      writeFileSync(other, '');
      assert.equal(resolveElectronPath([fake, other]), fake);
    });
  });

  test('候选顺序：第一个存在的胜出', () => {
    withIsolatedHome((dir) => {
      const fake = join(dir, 'fake-electron.exe');
      writeFileSync(fake, '');
      assert.equal(resolveElectronPath([join(dir, 'missing.exe'), fake]), fake);
    });
  });

  test('DSH_PET_ELECTRON_PATH 环境变量参与候选（在显式候选之后）', () => {
    withIsolatedHome((dir) => {
      const viaEnv = join(dir, 'env-electron.exe');
      writeFileSync(viaEnv, '');
      process.env.DSH_PET_ELECTRON_PATH = viaEnv;
      assert.equal(resolveElectronPath([]), viaEnv);
    });
  });

  test('一个都不存在时返回 undefined', () => {
    withIsolatedHome((dir) => {
      assert.equal(resolveElectronPath([join(dir, 'missing-1.exe'), join(dir, 'missing-2.exe')]), undefined);
    });
  });

  test('候选去重：重复路径只保留一次（结果仍能命中）', () => {
    withIsolatedHome((dir) => {
      const fake = join(dir, 'fake-electron.exe');
      writeFileSync(fake, '');
      assert.equal(resolveElectronPath([fake, fake, join(dir, 'missing.exe')]), fake);
    });
  });

  test('空字符串 / null 候选被跳过', () => {
    withIsolatedHome((dir) => {
      const fake = join(dir, 'fake-electron.exe');
      writeFileSync(fake, '');
      assert.equal(resolveElectronPath(['', undefined, fake] as Array<string | undefined>), fake);
    });
  });

  test('$DSH_HOME/electron 落地路径在本地候选中（隔离 DSH_HOME 时可命中）', () => {
    withIsolatedHome((dir) => {
      process.env.DSH_HOME = join(dir, 'dshhome');
      const rel =
        process.platform === 'win32'
          ? 'electron.exe'
          : process.platform === 'darwin'
            ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
            : 'electron';
      const landed = join(dir, 'dshhome', 'electron', rel);
      mkdirSync(join(dir, 'dshhome', 'electron'), { recursive: true });
      writeFileSync(landed, '');
      assert.equal(resolveElectronPath([]), landed);
    });
  });
});
