/**
 * 独立模式命令行与配置路径推导的单测（纯逻辑，零 I/O）。
 *
 * 为什么单独有这一层：独立模式没有 DSH 的启动器兜底 —— 参数解析错了会直接表现为
 * "端口不对/窗口不出现"，而配置路径推导错了会表现为"改了配置没生效"。
 * 两者都是纯函数，钉在这里比端到端调试便宜得多。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { configPathsFor, describePets, parseArgs } from './options.ts';
import { DEFAULT_STANDALONE_PORT } from './server.ts';

describe('parseArgs —— 独立模式的命令行契约', () => {
  test('无参数：默认端口、不体检、不打印用法', () => {
    const parsed = parseArgs([]);
    assert.ok('options' in parsed);
    assert.deepEqual(parsed.options, { port: DEFAULT_STANDALONE_PORT, check: false, help: false });
  });

  test('--port 的两种写法等价', () => {
    const spaced = parseArgs(['--port', '3100']);
    const equals = parseArgs(['--port=3100']);
    assert.ok('options' in spaced && 'options' in equals);
    assert.equal(spaced.options.port, 3100);
    assert.equal(equals.options.port, 3100);
  });

  test('--check 与 -h/--help 各自独立', () => {
    const check = parseArgs(['--check']);
    const short = parseArgs(['-h']);
    const long = parseArgs(['--help']);
    assert.ok('options' in check && 'options' in short && 'options' in long);
    assert.equal(check.options.check, true);
    assert.equal(check.options.help, false);
    assert.equal(short.options.help, true);
    assert.equal(long.options.help, true);
  });

  test('非法端口（越界 / 非整数 / 缺失）→ error，调用方以 2 退出', () => {
    for (const argv of [['--port'], ['--port', '0'], ['--port', '70000'], ['--port', '1.5'], ['--port=abc']]) {
      const parsed = parseArgs(argv);
      assert.ok('error' in parsed, JSON.stringify(argv));
      assert.match(parsed.error, /--port/);
    }
  });

  test('未知参数 → error（不静默忽略，避免"我明明传了参数"）', () => {
    const parsed = parseArgs(['--standalone']);
    assert.ok('error' in parsed);
    assert.match(parsed.error, /未知参数/);
  });
});

describe('configPathsFor —— 配置路径推导（host/index.ts 那份的镜像）', () => {
  // 镜像的漂移由 integration.test.ts 用插件自己的 GET /config/meta 钉住；
  // 这里钉住"拼接口径"本身，改动时能一眼看出动了哪条路径。
  const paths = configPathsFor('/pkg', '/home/.dsh');

  test('内置默认 / 用户主配置 / 旧版回落 / 文件宠物目录', () => {
    assert.deepEqual(paths, {
      defaultFile: join('/pkg', 'assets', 'config.jsonc'),
      userFile: join('/home/.dsh', 'dsh-pet', 'main-config.jsonc'),
      legacyUserFile: join('/home/.dsh', 'dsh-pet', 'main-config.json'),
      petDir: join('/home/.dsh', 'dsh-pet', 'pet'),
    });
  });
});

describe('describePets —— 启动横幅与体检报告共用的展示串', () => {
  test('空列表显式说明原因，不打印空行', () => {
    assert.match(describePets([]), /pets 为空/);
  });

  test('id/size/display 原样打印（独立模式不替用户判断 display）', () => {
    const text = describePets([{ id: 'main', size: 462, display: 'both' }]);
    assert.match(text, /main/);
    assert.match(text, /size=462/);
    assert.match(text, /display=both/);
  });
});
