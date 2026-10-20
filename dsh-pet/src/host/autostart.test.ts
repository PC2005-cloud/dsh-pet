/**
 * 开机自启的纯逻辑测试（ticket 09）。
 *
 * 系统登录项（HKCU Run / StartupApproved）依赖真实系统状态，node:test 不碰注册表；
 * 这里钉住三件容易回归的事：
 *   - 首次启动只初始化一次，用户之后关掉不得自动写回；
 *   - 读写登录项的参数恒含 `--autostart`，勾选态以系统状态为准（含任务管理器禁用）；
 *   - `--autostart` 延迟参数：默认 4000ms，环境变量可覆盖，非法值回落默认。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AUTOSTART_ARGS,
  DEFAULT_AUTOSTART_DELAY_MS,
  autostartMarkerPath,
  createFileMarker,
  createLoginItemAdapter,
  initializeAutostartOnce,
  resolveAutostartDelayMs,
  type LoginItemApi,
  type LoginItemSettings,
} from './autostart.ts';

/** 记录调用的假登录项 API（默认：系统里没有该启动项） */
function fakeLoginItemApi(initial: LoginItemSettings = { openAtLogin: false, launchItems: [] }) {
  const calls = {
    get: [] as { args: string[] }[],
    set: [] as { openAtLogin: boolean; args?: string[]; enabled?: boolean }[],
  };
  const api: LoginItemApi = {
    getLoginItemSettings(options) {
      calls.get.push(options ?? { args: [] });
      return initial;
    },
    setLoginItemSettings(settings) {
      calls.set.push(settings);
    },
  };
  return { api, calls };
}

/** 内存标记：「只写一次」的语义在这里模拟（create 后 exists 变 true） */
function fakeMarker(initial = false) {
  let present = initial;
  const calls = { exists: 0, create: 0 };
  return {
    calls,
    marker: {
      exists() {
        calls.exists += 1;
        return present;
      },
      create() {
        calls.create += 1;
        present = true;
      },
    },
  };
}

describe('resolveAutostartDelayMs —— 自启延迟参数', () => {
  test('未设置环境变量：默认 4000ms', () => {
    assert.equal(resolveAutostartDelayMs({}), 4000);
    assert.equal(DEFAULT_AUTOSTART_DELAY_MS, 4000);
  });

  test('环境变量覆盖：0 / 100 原样生效（测试与手动验证用）', () => {
    assert.equal(resolveAutostartDelayMs({ DSH_PET_AUTOSTART_DELAY_MS: '0' }), 0);
    assert.equal(resolveAutostartDelayMs({ DSH_PET_AUTOSTART_DELAY_MS: '100' }), 100);
    assert.equal(resolveAutostartDelayMs({ DSH_PET_AUTOSTART_DELAY_MS: ' 250 ' }), 250);
  });

  test('非法值回落默认：非数字 / 负数 / 空串 / Infinity', () => {
    for (const raw of ['abc', '-1', '', '   ', 'Infinity', 'NaN']) {
      assert.equal(
        resolveAutostartDelayMs({ DSH_PET_AUTOSTART_DELAY_MS: raw }),
        DEFAULT_AUTOSTART_DELAY_MS,
        `DSH_PET_AUTOSTART_DELAY_MS=${JSON.stringify(raw)} 应回落默认值`,
      );
    }
  });
});

describe('createLoginItemAdapter —— 系统登录项读写', () => {
  test('读取状态：传 --autostart 参数（否则 Electron 比对不上同一个启动项）', () => {
    const { api, calls } = fakeLoginItemApi({ openAtLogin: true, launchItems: [{ enabled: true }] });
    const loginItem = createLoginItemAdapter(api);

    assert.equal(loginItem.isEnabled(), true);
    assert.equal(calls.get.length, 1);
    assert.deepEqual(calls.get[0], { args: ['--autostart'] });
    assert.deepEqual(AUTOSTART_ARGS, ['--autostart']);
  });

  test('系统里没有该启动项：勾选为 false', () => {
    const { api } = fakeLoginItemApi({ openAtLogin: false });
    assert.equal(createLoginItemAdapter(api).isEnabled(), false);
  });

  test('任务管理器禁用（StartupApproved）：openAtLogin 仍为 true，但 enabled=false 必须显示为未勾选', () => {
    const { api } = fakeLoginItemApi({
      openAtLogin: true,
      launchItems: [{ name: 'electron.app.DSH Pet', path: 'C:\\DSH Pet.exe', enabled: false }],
    });
    assert.equal(createLoginItemAdapter(api).isEnabled(), false);
  });

  test('多个同 exe 启动项：只要有一个启用就算启用', () => {
    const { api } = fakeLoginItemApi({
      openAtLogin: true,
      launchItems: [{ enabled: false }, { enabled: true }],
    });
    assert.equal(createLoginItemAdapter(api).isEnabled(), true);
  });

  test('开启：openAtLogin=true、args 恒含 --autostart，并写 enabled=true 以解除任务管理器禁用', () => {
    const { api, calls } = fakeLoginItemApi();
    createLoginItemAdapter(api).setEnabled(true);

    assert.equal(calls.set.length, 1);
    assert.deepEqual(calls.set[0], { openAtLogin: true, args: ['--autostart'], enabled: true });
  });

  test('关闭：openAtLogin=false、args 恒含 --autostart（立即从系统启动项移除）', () => {
    const { api, calls } = fakeLoginItemApi();
    createLoginItemAdapter(api).setEnabled(false);

    assert.deepEqual(calls.set, [{ openAtLogin: false, args: ['--autostart'] }]);
  });
});

describe('initializeAutostartOnce —— 默认开启且只写一次', () => {
  test('从未初始化：系统里没有启动项 → 写入开启并留下标记', () => {
    const { api, calls } = fakeLoginItemApi();
    const { marker, calls: markerCalls } = fakeMarker(false);

    const outcome = initializeAutostartOnce({ loginItem: createLoginItemAdapter(api), marker });

    assert.equal(outcome, 'enabled');
    assert.deepEqual(calls.set, [{ openAtLogin: true, args: ['--autostart'], enabled: true }]);
    assert.equal(markerCalls.create, 1);
  });

  test('从未初始化但系统已经开启（如用户手动加了启动项）：不重写，只补标记', () => {
    const { api, calls } = fakeLoginItemApi({ openAtLogin: true, launchItems: [{ enabled: true }] });
    const { marker, calls: markerCalls } = fakeMarker(false);

    const outcome = initializeAutostartOnce({ loginItem: createLoginItemAdapter(api), marker });

    assert.equal(outcome, 'already-enabled');
    assert.equal(calls.set.length, 0, '系统已开启时不应重写登录项');
    assert.equal(markerCalls.create, 1);
  });

  test('标记已存在（用户曾关掉自启）：不读也不写系统，绝不再自动开启', () => {
    const { api, calls } = fakeLoginItemApi({ openAtLogin: false });
    const { marker, calls: markerCalls } = fakeMarker(true);

    const outcome = initializeAutostartOnce({ loginItem: createLoginItemAdapter(api), marker });

    assert.equal(outcome, 'already-initialized');
    assert.equal(calls.get.length, 0, '已有标记时连系统状态都不需要读');
    assert.equal(calls.set.length, 0);
    assert.equal(markerCalls.create, 0);
  });

  test('连续两次调用（两次启动）：只在第一次写登录项', () => {
    const { api, calls } = fakeLoginItemApi();
    const { marker } = fakeMarker(false);
    const loginItem = createLoginItemAdapter(api);

    assert.equal(initializeAutostartOnce({ loginItem, marker }), 'enabled');
    assert.equal(initializeAutostartOnce({ loginItem, marker }), 'already-initialized');
    assert.equal(calls.set.length, 1, '第二次启动不得把用户关掉的自启写回');
  });

  test('写登录项失败：不创建标记（下次启动还能重试），错误向上抛给调用方', () => {
    const api: LoginItemApi = {
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: () => {
        throw new Error('registry denied');
      },
    };
    const { marker, calls } = fakeMarker(false);

    assert.throws(() => initializeAutostartOnce({ loginItem: createLoginItemAdapter(api), marker }), /denied/);
    assert.equal(calls.create, 0, '失败不能留下标记，否则永远失去默认开启');
  });
});

describe('标记文件与路径', () => {
  test('标记位于 <DSH_HOME>/dsh-pet/autostart-initialized（与配置、素材同一目录）', () => {
    assert.equal(
      autostartMarkerPath('C:\\Users\\someone\\.dsh'),
      join('C:\\Users\\someone\\.dsh', 'dsh-pet', 'autostart-initialized'),
    );
  });

  test('createFileMarker：自动创建父目录，只创建一次（write-once）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-autostart-'));
    try {
      const file = join(dir, 'nested', 'autostart-initialized');
      const marker = createFileMarker(file);

      assert.equal(marker.exists(), false);
      assert.equal(existsSync(dir), true);
      marker.create();
      assert.equal(marker.exists(), true);
      assert.throws(() => marker.create(), /EEXIST/, '第二次创建必须失败，避免覆盖标记');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
