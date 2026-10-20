/**
 * 启动计划与角色分流的纯逻辑测试（ticket 01）。
 *
 * 打包形态与开发形态的差别必须收在纯函数里，而不是散落在 spawn 调用点：
 *   - 角色分流：命令行参数 → 宿主 / 桌面壳 / DPI 探测 + 是否自启；
 *   - 启动计划：给定形态与路径 → 命令、参数、工作目录、spawn 前要删掉的环境变量。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildLaunchPlan, parseAppRole } from './launch-plan.ts';

describe('parseAppRole —— 命令行参数分流角色（ticket 01）', () => {
  test('无参数：宿主角色、非自启、无告警', () => {
    assert.deepEqual(parseAppRole([]), { role: 'host', autostart: false, warnings: [] });
  });

  test('--autostart：宿主角色 + 自启标记', () => {
    assert.deepEqual(parseAppRole(['--autostart']), { role: 'host', autostart: true, warnings: [] });
  });

  test('--dsh-pet-helper：桌面壳角色', () => {
    const result = parseAppRole(['--dsh-pet-helper']);
    assert.equal(result.role, 'helper');
    assert.equal(result.autostart, false);
    assert.deepEqual(result.warnings, []);
  });

  test('--dsh-pet-dpi-probe：一次性 DPI 探测角色', () => {
    const result = parseAppRole(['--dsh-pet-dpi-probe']);
    assert.equal(result.role, 'dpi-probe');
    assert.equal(result.autostart, false);
  });

  test('未知参数不崩溃：按宿主处理，告警作为返回值（本函数不直接 console）', () => {
    const result = parseAppRole(['--definitely-not-a-role']);
    assert.equal(result.role, 'host');
    assert.equal(result.autostart, false);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /--definitely-not-a-role/);
  });

  test('多个未知参数：逐个告警，不吞掉任何一个', () => {
    const result = parseAppRole(['--nope', '--also-nope']);
    assert.equal(result.role, 'host');
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0], /--nope/);
    assert.match(result.warnings[1], /--also-nope/);
  });

  test('已知的调用方参数（如独立模式 CLI 的 --port）不参与角色判断、不告警', () => {
    const result = parseAppRole(['--port', '3081', '--check'], { knownArgs: ['--port', '--check'] });
    assert.deepEqual(result, { role: 'host', autostart: false, warnings: [] });
  });

  test('角色参数与自启标记可同时出现（壳角色 + --autostart 不互相吞掉）', () => {
    const result = parseAppRole(['--autostart', '--dsh-pet-helper']);
    assert.equal(result.role, 'helper');
    assert.equal(result.autostart, true);
    assert.deepEqual(result.warnings, []);
  });
});

describe('buildLaunchPlan —— 启动计划（ticket 01）', () => {
  const base = {
    executablePath: '/opt/dsh-pet/electron',
    helperEntry: '/opt/dsh-pet/runtime/electron-helper/main.js',
    cwd: '/home/user/.dsh',
  };

  test('开发形态：Electron 二进制 + helper 脚本', () => {
    assert.deepEqual(buildLaunchPlan({ ...base, packaged: false }), {
      command: '/opt/dsh-pet/electron',
      args: ['/opt/dsh-pet/runtime/electron-helper/main.js'],
      cwd: '/home/user/.dsh',
      envDelete: ['ELECTRON_RUN_AS_NODE'],
    });
  });

  test('打包形态：同一个可执行文件 + helper 参数（不出现脚本路径）', () => {
    assert.deepEqual(buildLaunchPlan({ ...base, packaged: true }), {
      command: '/opt/dsh-pet/electron',
      args: ['--dsh-pet-helper'],
      cwd: '/home/user/.dsh',
      envDelete: ['ELECTRON_RUN_AS_NODE'],
    });
  });

  test('开发形态 + DPI 探测：Electron 二进制 + helper 脚本 + 探测参数', () => {
    assert.deepEqual(buildLaunchPlan({ ...base, packaged: false, kind: 'dpi-probe' }), {
      command: '/opt/dsh-pet/electron',
      args: ['/opt/dsh-pet/runtime/electron-helper/main.js', '--dsh-pet-dpi-probe'],
      cwd: '/home/user/.dsh',
      envDelete: ['ELECTRON_RUN_AS_NODE'],
    });
  });

  test('打包形态 + DPI 探测：同一个可执行文件 + 探测参数', () => {
    assert.deepEqual(buildLaunchPlan({ ...base, packaged: true, kind: 'dpi-probe' }), {
      command: '/opt/dsh-pet/electron',
      args: ['--dsh-pet-dpi-probe'],
      cwd: '/home/user/.dsh',
      envDelete: ['ELECTRON_RUN_AS_NODE'],
    });
  });

  test('环境清理规则由纯函数返回：ELECTRON_RUN_AS_NODE 必须删（开发/打包一致）', () => {
    for (const packaged of [false, true]) {
      const plan = buildLaunchPlan({ ...base, packaged });
      assert.ok(
        plan.envDelete.includes('ELECTRON_RUN_AS_NODE'),
        '宿主可能是 Electron 应用，透传这个变量会让 helper 退化成纯 Node 模式（issue #63）',
      );
    }
  });
});
