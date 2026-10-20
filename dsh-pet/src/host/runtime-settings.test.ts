/**
 * 运行时状态文件（`~/.dsh/dsh-pet/standalone-runtime.json`）的读取与过期判定（ticket 07）。
 *
 * 这个文件是安装版里 AI 设置页的唯一入口：内容含一次性 token，因此
 *   - 只接受本机 http 的 `/standalone-ai/` + 43 字符 `#token=`；
 *   - pid 已退出 / 端口不可连 / URL 与 port 字段不一致 → 视为过期，返回**可读原因**；
 *   - 任何提示文案都不得包含 URL 或 token（调用方会把 message 直接弹给用户）。
 *
 * 托盘（desktop/tray.mjs）与宠物右键菜单（runtime/electron-helper/main.js）都只经这里读取，
 * 不允许各自再写一份解析/校验。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import {
  evaluateRuntimeSettings,
  parseRuntimeSettings,
  parseRuntimeSettingsUrl,
  petDataDir,
  probePort,
  readRuntimeSettings,
  resolveDshHome,
  runtimeSettingsPath,
} from './runtime-settings.ts';

const TOKEN = 'A'.repeat(43);
const SETTINGS_URL = `http://127.0.0.1:3080/standalone-ai/#token=${TOKEN}`;

/** 一份形状正确的运行时文件内容 */
function runtimeFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'dsh-pet-standalone',
    pid: 4321,
    startedAt: '2026-10-20T00:00:00.000Z',
    port: 3080,
    token: TOKEN,
    settingsUrl: SETTINGS_URL,
    pluginRoot: 'C:/dsh-pet',
    ...overrides,
  });
}

/** 临时 DSH_HOME（每个用例独立，避免碰用户真实数据目录） */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-pet-runtime-'));
}

function writeRuntime(home: string, content: string): string {
  const file = runtimeSettingsPath(home);
  mkdirSync(petDataDir(home), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('parseRuntimeSettings —— 只信本机设置页的能力 URL', () => {
  test('合法文件：返回 settingsUrl / pid / port / token', () => {
    assert.deepEqual(parseRuntimeSettings(runtimeFile()), {
      settingsUrl: SETTINGS_URL,
      pid: 4321,
      port: 3080,
      token: TOKEN,
    });
    const localhost = SETTINGS_URL.replace('127.0.0.1', 'localhost');
    assert.equal(parseRuntimeSettings(runtimeFile({ settingsUrl: localhost }))?.settingsUrl, localhost);
  });

  test('读不懂 / 缺字段 / 非本机 / 缺 token 时返回 undefined', () => {
    for (const raw of [
      '',
      'not json',
      '{}',
      JSON.stringify(null),
      JSON.stringify({ settingsUrl: 42 }),
      runtimeFile({ settingsUrl: 'https://127.0.0.1:3080/standalone-ai/#token=' + TOKEN }),
      runtimeFile({ settingsUrl: 'http://example.com/standalone-ai/#token=' + TOKEN }),
      runtimeFile({ settingsUrl: 'http://127.0.0.1:3080/standalone-ai/' }),
      runtimeFile({ settingsUrl: 'http://127.0.0.1:3080/standalone-ai/#token=short' }),
      runtimeFile({ settingsUrl: 'http://127.0.0.1:3080/other/#token=' + TOKEN }),
      // pid / port 缺失或非法 = 文件损坏，不能当过期的「可打开」状态
      runtimeFile({ pid: undefined }),
      runtimeFile({ pid: 0 }),
      runtimeFile({ pid: '4321' }),
      runtimeFile({ port: undefined }),
      runtimeFile({ port: '3080' }),
    ]) {
      assert.equal(parseRuntimeSettings(raw), undefined, raw);
    }
  });

  test('parseRuntimeSettingsUrl 仍只返回 URL（兼容 ticket 06 的调用方）', () => {
    assert.equal(parseRuntimeSettingsUrl(runtimeFile()), SETTINGS_URL);
    assert.equal(parseRuntimeSettingsUrl('not json'), undefined);
    assert.equal(
      parseRuntimeSettingsUrl(runtimeFile({ settingsUrl: 'http://127.0.0.1:3080/other/#token=' + TOKEN })),
      undefined,
    );
  });
});

describe('evaluateRuntimeSettings —— 过期判定返回可读原因', () => {
  test('文件缺失：提示先启动安装版，并可稍后重试', async () => {
    const result = await evaluateRuntimeSettings(undefined, {});
    assert.equal(result.available, false);
    if (result.available) return;
    assert.equal(result.reason, 'missing');
    assert.match(result.message, /启动/);
    assert.match(result.message, /重试/);
  });

  test('JSON / 字段损坏：invalid，且不把原文带进提示', async () => {
    const result = await evaluateRuntimeSettings('{broken', {});
    assert.equal(result.available, false);
    if (result.available) return;
    assert.equal(result.reason, 'invalid');
    assert.match(result.message, /重试/);
  });

  test('settingsUrl 的端口与文件 port 字段不一致：port-mismatch（过期，不打开空白页）', async () => {
    const result = await evaluateRuntimeSettings(runtimeFile({ port: 3099 }), {
      pidAlive: () => true,
      portReachable: () => true,
    });
    assert.equal(result.available, false);
    if (result.available) return;
    assert.equal(result.reason, 'port-mismatch');
    assert.match(result.message, /过期|重试/);
  });

  test('pid 已不存在：pid-gone（kill(pid,0) ESRCH）', async () => {
    let checkedPid = 0;
    const result = await evaluateRuntimeSettings(runtimeFile(), {
      pidAlive: (pid) => {
        checkedPid = pid;
        return false;
      },
      portReachable: () => true,
    });
    assert.equal(checkedPid, 4321);
    assert.equal(result.available, false);
    if (result.available) return;
    assert.equal(result.reason, 'pid-gone');
    assert.match(result.message, /退出|重试/);
  });

  test('端口不可连：port-unreachable', async () => {
    const result = await evaluateRuntimeSettings(runtimeFile(), {
      pidAlive: () => true,
      portReachable: () => false,
    });
    assert.equal(result.available, false);
    if (result.available) return;
    assert.equal(result.reason, 'port-unreachable');
    assert.match(result.message, /连接|重试/);
  });

  test('pid 与端口都正常：available，URL 原样返回', async () => {
    const result = await evaluateRuntimeSettings(runtimeFile(), {
      pidAlive: () => true,
      portReachable: () => true,
    });
    assert.equal(result.available, true);
    if (!result.available) return;
    assert.equal(result.settingsUrl, SETTINGS_URL);
    assert.equal(result.pid, 4321);
    assert.equal(result.port, 3080);
  });

  test('提示文案绝不包含 settingsUrl 或 token（会直接弹给用户 / 可能进日志）', async () => {
    const cases = [
      await evaluateRuntimeSettings(undefined, {}),
      await evaluateRuntimeSettings(runtimeFile({ port: 3099 }), { pidAlive: () => true }),
      await evaluateRuntimeSettings(runtimeFile(), { pidAlive: () => false }),
      await evaluateRuntimeSettings(runtimeFile(), { pidAlive: () => true, portReachable: () => false }),
    ];
    for (const result of cases) {
      if (result.available) continue;
      assert.ok(!result.message.includes(SETTINGS_URL), result.message);
      assert.ok(!result.message.includes(TOKEN), result.message);
    }
  });
});

describe('readRuntimeSettings —— 从数据目录读取同一份文件', () => {
  test('文件不存在：missing', async () => {
    const home = tempHome();
    const result = await readRuntimeSettings(home, { pidAlive: () => true, portReachable: () => true });
    assert.equal(result.available, false);
    if (result.available) return;
    assert.equal(result.reason, 'missing');
  });

  test('文件存在且 pid/端口正常：available（默认探针可注入）', async () => {
    const home = tempHome();
    const file = writeRuntime(home, runtimeFile({ pid: 999 }));
    assert.equal(file, runtimeSettingsPath(home));
    const result = await readRuntimeSettings(home, {
      pidAlive: (pid) => pid === 999,
      portReachable: (port) => port === 3080,
    });
    assert.equal(result.available, true);
  });

  test('文件损坏：invalid', async () => {
    const home = tempHome();
    writeRuntime(home, 'not json');
    const result = await readRuntimeSettings(home, {});
    assert.equal(result.available, false);
    if (result.available) return;
    assert.equal(result.reason, 'invalid');
  });
});

describe('probePort —— 真实 TCP 连通性', () => {
  test('监听中的端口可达，关闭后不可达', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    assert.equal(await probePort(port, 500), true);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    assert.equal(await probePort(port, 500), false);
  });
});

describe('路径 —— 数据目录与运行时文件（不用 %APPDATA%）', () => {
  test('DSH_HOME 优先，其次 USERPROFILE / HOME，最后拼 .dsh', () => {
    assert.equal(resolveDshHome({ DSH_HOME: '/custom/home', USERPROFILE: '/users/x' }), '/custom/home');
    assert.equal(resolveDshHome({ USERPROFILE: '/users/x', HOME: '/home/x' }), join('/users/x', '.dsh'));
    assert.equal(resolveDshHome({ HOME: '/home/x' }), join('/home/x', '.dsh'));
  });

  test('数据目录固定为 <DSH_HOME>/dsh-pet，运行时文件可预测', () => {
    const home = '/users/x/.dsh';
    assert.equal(petDataDir(home), join(home, 'dsh-pet'));
    assert.equal(runtimeSettingsPath(home), join(home, 'dsh-pet', 'standalone-runtime.json'));
  });
});
