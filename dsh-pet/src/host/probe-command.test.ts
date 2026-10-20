/**
 * 打包形态下桌面壳的路径契约（ticket 03）。
 *
 * 壳是随包发行的手写 CommonJS，这里钉两类不能靠肉眼保证的东西：
 *   1. DPI 探测子进程的启动命令：开发形态是 Electron 二进制 + helper 脚本，打包形态必须换成
 *      **同一个应用 exe + 角色参数**（把 asar 内路径当脚本传给 exe 是错的）；
 *   2. main.js 必须用 `__dirname` 拼绝对路径加载页面 —— `loadFile('index.html')` 相对的是
 *      `app.getAppPath()`（打包后是 asar 根），页面实际在 `runtime/electron-helper/` 下。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { probeSpawnCommand } = require('../../runtime/electron-helper/probe-command.js');
const mainSource = readFileSync(new URL('../../runtime/electron-helper/main.js', import.meta.url), 'utf8');

type SpawnCommand = { command: string; args: string[] };

describe('probeSpawnCommand —— DPI 探测子进程的启动命令', () => {
  const execPath = 'C:\\Program Files\\Electron\\electron.exe';
  const helperEntry = 'C:\\dsh-pet\\runtime\\electron-helper\\main.js';

  test('开发形态：Electron 二进制 + helper 脚本 + 探测参数', () => {
    const plan: SpawnCommand = probeSpawnCommand({ packaged: false, execPath, helperEntry });
    assert.deepEqual(plan, {
      command: execPath,
      args: [helperEntry, '--dsh-pet-dpi-probe'],
    });
  });

  test('打包形态：同一个应用 exe + 探测参数（不出现 asar 内的脚本路径）', () => {
    const appExe = 'C:\\Users\\me\\AppData\\Local\\Programs\\DSH Pet\\DSH Pet.exe';
    const plan: SpawnCommand = probeSpawnCommand({ packaged: true, execPath: appExe, helperEntry });
    assert.deepEqual(plan, {
      command: appExe,
      args: ['--dsh-pet-dpi-probe'],
    });
    assert.ok(!plan.args.some((arg) => arg === helperEntry), '打包后 exe 不接受脚本路径参数');
  });

  test('缺少可执行文件路径时明确报错（不静默 spawn 错东西）', () => {
    assert.throws(() => probeSpawnCommand({ packaged: false, execPath: '', helperEntry }), /execPath/);
  });

  test('开发形态缺少 helper 入口时明确报错', () => {
    assert.throws(() => probeSpawnCommand({ packaged: false, execPath, helperEntry: '' }), /helperEntry/);
  });
});

describe('runtime/electron-helper/main.js —— 打包形态路径契约', () => {
  test('DPI 探测走 probeSpawnCommand，且按 DSH_PET_PACKAGED 区分开发/打包', () => {
    assert.match(mainSource, /require\(['"]\.\/probe-command\.js['"]\)/);
    assert.match(mainSource, /probeSpawnCommand\(/);
    assert.match(mainSource, /DSH_PET_PACKAGED/);
    assert.ok(
      !/execFileSync\(\s*process\.execPath\s*,\s*\[\s*__filename/.test(mainSource),
      '不能再把 asar 内的 __filename 当脚本参数传给 exe',
    );
  });

  test('页面入口用 __dirname 拼绝对路径（loadFile 相对的是 app.getAppPath）', () => {
    assert.ok(
      !/loadFile\(\s*['"]index\.html['"]/.test(mainSource),
      "loadFile('index.html') 在打包后相对 asar 根解析，页面会加载失败",
    );
    assert.match(mainSource, /loadFile\(\s*path\.join\(__dirname,\s*['"]index\.html['"]\)/);
  });
});
