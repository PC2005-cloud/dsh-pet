/**
 * 存储位置清单单元测试 —— 钉住设置页「卸载与存储」展示的每一条路径：
 * 必须与真实写入方（index.ts 的 userRoot、helper-process.ts 的 Electron 落地目录、
 * main.js 的 app.setName、@electron/get 的 env-paths cacheRoot）逐平台一致。
 *
 * 其中 DESKTOP_APP_NAME 直接读 runtime/electron-helper/main.js 校验——两边改名不同步时
 * 设置页会显示一个永远不存在的目录，这里必须红。
 *
 * 跑法：node --experimental-strip-types --test src/host/storage-paths.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DESKTOP_APP_NAME, profileNameFrom, storageEntries } from './storage-paths.ts';

/** 各平台的注入输入（基准目录全部写死，避免用到真实环境） */
const base = {
  userDataRoot: '/dsh-home/dsh-pet',
  electronDir: '/dsh-home/electron',
  home: '/home/u',
  packageRoot: '/dsh-home/profiles/web/node_modules/dsh-pet',
};

/** 取出某条目的路径 */
function pathOf(entries: ReturnType<typeof storageEntries>, key: string): string {
  const hit = entries.find((e) => e.key === key);
  assert.ok(hit, '缺少条目 ' + key);
  return hit.path;
}

describe('storageEntries —— 写入方路径原样透传（不自己拼目录名）', () => {
  test('userData 与 electron 就是调用方给的路径，一个字符都不改', () => {
    // 故意给一个不符合任何默认约定的路径：若本模块偷偷拼 'dsh-pet' / 'electron'，这里必红
    const entries = storageEntries({
      userDataRoot: 'Z:\\weird\\place',
      electronDir: 'Z:\\another\\runtime',
      home: '/home/u',
      packageRoot: '/pkg',
      platform: 'win32',
      env: {},
    });
    assert.equal(pathOf(entries, 'userData'), 'Z:\\weird\\place');
    assert.equal(pathOf(entries, 'electron'), 'Z:\\another\\runtime');
  });
});

describe('storageEntries —— 逐平台路径推导', () => {
  test('win32：系统级目录走 APPDATA/LOCALAPPDATA', () => {
    const entries = storageEntries({
      ...base,
      platform: 'win32',
      env: { APPDATA: 'C:\\AppData\\Roaming', LOCALAPPDATA: 'C:\\AppData\\Local' },
    });
    assert.equal(pathOf(entries, 'userData'), base.userDataRoot);
    assert.equal(pathOf(entries, 'electron'), base.electronDir);
    assert.equal(pathOf(entries, 'desktopCache'), join('C:\\AppData\\Roaming', DESKTOP_APP_NAME));
    // env-paths 在 Windows 下多一层 Cache
    assert.equal(pathOf(entries, 'electronCache'), join('C:\\AppData\\Local', 'electron', 'Cache'));
    assert.equal(pathOf(entries, 'package'), base.packageRoot);
  });

  test('win32：APPDATA/LOCALAPPDATA 缺失 → 回落到 home 下的 AppData', () => {
    const entries = storageEntries({ ...base, platform: 'win32', env: {} });
    assert.equal(pathOf(entries, 'desktopCache'), join('/home/u', 'AppData', 'Roaming', DESKTOP_APP_NAME));
    assert.equal(pathOf(entries, 'electronCache'), join('/home/u', 'AppData', 'Local', 'electron', 'Cache'));
  });

  test('darwin：Application Support + Library/Caches', () => {
    const entries = storageEntries({ ...base, platform: 'darwin', env: {} });
    assert.equal(pathOf(entries, 'desktopCache'), join('/home/u', 'Library', 'Application Support', DESKTOP_APP_NAME));
    assert.equal(pathOf(entries, 'electronCache'), join('/home/u', 'Library', 'Caches', 'electron'));
  });

  test('linux：XDG 变量优先，未设则回落到 ~/.config 与 ~/.cache', () => {
    const xdg = storageEntries({
      ...base,
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/xdg/config', XDG_CACHE_HOME: '/xdg/cache' },
    });
    assert.equal(pathOf(xdg, 'desktopCache'), join('/xdg/config', DESKTOP_APP_NAME));
    assert.equal(pathOf(xdg, 'electronCache'), join('/xdg/cache', 'electron'));

    const fallback = storageEntries({ ...base, platform: 'linux', env: {} });
    assert.equal(pathOf(fallback, 'desktopCache'), join('/home/u', '.config', DESKTOP_APP_NAME));
    assert.equal(pathOf(fallback, 'electronCache'), join('/home/u', '.cache', 'electron'));
  });

  test('条目顺序固定：用户数据 → 运行时 → 缓存 → 插件本体', () => {
    const keys = storageEntries({ ...base, platform: 'win32', env: {} }).map((e) => e.key);
    assert.deepEqual(keys, ['userData', 'electron', 'desktopCache', 'electronCache', 'package']);
  });

  test('exists 由磁盘即时判定（真实存在的目录为 true，未创建的为 false）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-storage-test-'));
    try {
      const mk = () =>
        storageEntries({
          userDataRoot: join(dir, 'dsh-pet'),
          electronDir: join(dir, 'electron'),
          home: dir,
          packageRoot: dir,
          platform: 'win32',
          env: {},
        });
      // packageRoot = dir 本身存在 → true；dsh-pet/ 尚未创建 → false
      assert.equal(mk().find((e) => e.key === 'package')?.exists, true);
      assert.equal(mk().find((e) => e.key === 'userData')?.exists, false);

      mkdirSync(join(dir, 'dsh-pet'), { recursive: true });
      assert.equal(mk().find((e) => e.key === 'userData')?.exists, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('profileNameFrom —— 卸载命令里的 profile 名', () => {
  test('从 <DSH_HOME>/profiles/<name>/node_modules/<pkg> 反推', () => {
    assert.equal(profileNameFrom("C:\\Users\\p'c\\.dsh\\profiles\\web\\node_modules\\dsh-pet"), 'web');
    assert.equal(profileNameFrom('/home/u/.dsh/profiles/custom/node_modules/dsh-pet'), 'custom');
  });

  test('反推不出来 → undefined（宁可退回占位符，也不猜一个错的）', () => {
    assert.equal(profileNameFrom('/dsh-home/profiles/node_modules/dsh-pet'), undefined);
    assert.equal(profileNameFrom('/some/link/dsh-pet'), undefined);
    assert.equal(profileNameFrom(''), undefined);
  });
});

describe('DESKTOP_APP_NAME —— 与桌面端实际应用名防漂移', () => {
  test('与 runtime/electron-helper/main.js 的 app.setName 一致', () => {
    const src = readFileSync(new URL('../../runtime/electron-helper/main.js', import.meta.url), 'utf8');
    const m = /app\.setName\(\s*['"]([^'"]+)['"]\s*\)/.exec(src);
    assert.ok(m, 'main.js 里没有找到 app.setName');
    assert.equal(m[1], DESKTOP_APP_NAME);
  });
});
