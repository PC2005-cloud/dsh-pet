/**
 * user-data 决策的单测：只测不碰 Electron 的部分。
 *
 * 为什么值得单测：回退路径算错时，受限令牌下 helper 仍会卡在 ready 之前，
 * 而真机 CI 复现不了受限令牌。这里用注入的 fs 把「可写 / 不可写 / 回退也失败」三条分支钉住。
 *
 * 跑法：node --test scripts/tests/user-data.test.mjs（npm run test:ui 会带上）
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { dshHomeDir, isWritableDir, resolveUserDataDir } = require('../../runtime/electron-helper/main/user-data.js');

/** 假 fs：只有列在 Set 里的目录可写，其余写入抛 EACCES。 */
function fakeFs(writableDirs) {
  return {
    mkdirSync: () => {},
    writeFileSync: (file) => {
      if (!writableDirs.has(dirname(file))) {
        const error = new Error('EACCES: permission denied');
        error.code = 'EACCES';
        throw error;
      }
    },
    unlinkSync: () => {},
  };
}

describe('dshHomeDir —— DSH 主目录解析', () => {
  test('DSH_HOME 优先：设了环境变量就用它', () => {
    assert.equal(dshHomeDir({ DSH_HOME: join('root', 'custom') }, join('root', 'home')), join('root', 'custom'));
  });

  test('未设 DSH_HOME：回落到 ~/.dsh', () => {
    assert.equal(dshHomeDir({}, join('root', 'home')), join('root', 'home', '.dsh'));
  });
});

describe('isWritableDir —— 必须真的写进去才算可写', () => {
  test('真实临时目录：可写', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-userdata-'));
    try {
      assert.equal(isWritableDir(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('写入被拒：不可写', () => {
    assert.equal(isWritableDir(join('appdata', 'helper'), { fs: fakeFs(new Set()) }), false);
  });
});

describe('resolveUserDataDir —— 回退决策', () => {
  const currentDir = join('appdata', 'dsh-pet-electron-helper');
  const dshHome = join('root', '.dsh');

  test('原目录可写：不改变目录', () => {
    const out = resolveUserDataDir({ currentDir, dshHome, appMode: false, fs: fakeFs(new Set([currentDir])) });
    assert.deepEqual(out, { dir: currentDir, fallback: false, error: null });
  });

  test('原目录不可写：回退到 $DSH_HOME 下的 electron-profile', () => {
    const fallbackDir = join(dshHome, 'dsh-pet', 'electron-profile');
    const out = resolveUserDataDir({ currentDir, dshHome, appMode: false, fs: fakeFs(new Set([fallbackDir])) });
    assert.deepEqual(out, { dir: fallbackDir, fallback: true, error: null });
  });

  test('独立应用模式：回退到 app-profile，避免与 helper 抢同一份 profile', () => {
    const fallbackDir = join(dshHome, 'dsh-pet', 'app-profile');
    const out = resolveUserDataDir({ currentDir, dshHome, appMode: true, fs: fakeFs(new Set([fallbackDir])) });
    assert.deepEqual(out, { dir: fallbackDir, fallback: true, error: null });
  });

  test('原目录与回退目录都不可写：保留原目录并带回错误', () => {
    const out = resolveUserDataDir({ currentDir, dshHome, appMode: false, fs: fakeFs(new Set()) });
    assert.equal(out.dir, currentDir);
    assert.equal(out.fallback, false);
    assert.ok(out.error instanceof Error, '应带回原始错误供日志输出');
  });
});
