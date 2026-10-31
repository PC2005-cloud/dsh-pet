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
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  HELPER_STABLE_MS,
  HELPER_STOP_GRACE_MS,
  HelperProcess,
  crashLoopAdvice,
  describeExit,
  dshHomeDir,
  defaultElectronExe,
  ensureElectronDownload,
  hasGraphicalDisplay,
  helperRunIsStable,
  helperSpawnEnv,
  readElectronVersion,
  restartBackoffDelayMs,
  resolveElectronPath,
  shouldCircuitBreak,
  shouldFallbackToNoSandbox,
} from './helper-process.ts';

test('Electron 安装目录无法创建时返回 undefined，不产生未处理拒绝', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-install-'));
  const savedHome = process.env.DSH_HOME;
  t.after(() => {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.DSH_HOME = dir;
  // 跨平台复现：同名普通文件阻止创建目录，不依赖 chmod 或管理员权限。
  writeFileSync(join(dir, 'electron'), 'occupied');
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  t.mock.method(console, 'log', () => {});
  assert.equal(await ensureElectronDownload(), undefined);
  assert.ok(warnings.some((message) => message.includes('ensure failed:')));
  assert.ok(warnings.some((message) => message.includes('DSH_PET_ELECTRON_PATH')));
});

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
  test('Electron cache validation: skips empty files and directories before a usable candidate', () => {
    withIsolatedHome((dir) => {
      const empty = join(dir, 'empty');
      const directory = join(dir, 'folder');
      const usable = join(dir, 'usable');
      writeFileSync(empty, '');
      mkdirSync(directory);
      writeFileSync(usable, 'executable fixture');
      assert.equal(resolveElectronPath([empty, directory, usable]), usable);
    });
  });

  test('Electron cache validation: does not resolve an empty managed cache', () => {
    withIsolatedHome(() => {
      const path = defaultElectronExe();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
      assert.equal(resolveElectronPath(), undefined);
    });
  });
  test('显式候选命中时直接返回（不读环境变量）', () => {
    withIsolatedHome((dir) => {
      const fake = join(dir, 'fake-electron.exe');
      writeFileSync(fake, 'executable fixture');
      const other = join(dir, 'other-electron.exe');
      writeFileSync(other, 'executable fixture');
      assert.equal(resolveElectronPath([fake, other]), fake);
    });
  });

  test('候选顺序：第一个存在的胜出', () => {
    withIsolatedHome((dir) => {
      const fake = join(dir, 'fake-electron.exe');
      writeFileSync(fake, 'executable fixture');
      assert.equal(resolveElectronPath([join(dir, 'missing.exe'), fake]), fake);
    });
  });

  test('DSH_PET_ELECTRON_PATH 环境变量参与候选（在显式候选之后）', () => {
    withIsolatedHome((dir) => {
      const viaEnv = join(dir, 'env-electron.exe');
      writeFileSync(viaEnv, 'executable fixture');
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
      writeFileSync(fake, 'executable fixture');
      assert.equal(resolveElectronPath([fake, fake, join(dir, 'missing.exe')]), fake);
    });
  });

  test('空字符串 / null 候选被跳过', () => {
    withIsolatedHome((dir) => {
      const fake = join(dir, 'fake-electron.exe');
      writeFileSync(fake, 'executable fixture');
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
      mkdirSync(dirname(landed), { recursive: true });
      writeFileSync(landed, 'executable fixture');
      assert.equal(resolveElectronPath([]), landed);
    });
  });
});

test('Electron cache validation: an existing non-empty file avoids a download', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-cache-'));
  const previous = process.env.DSH_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.DSH_HOME = home;
  const path = defaultElectronExe();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'executable fixture');
  let logs = 0;
  assert.equal(
    await ensureElectronDownload({
      onLog: () => {
        logs++;
      },
    }),
    path,
  );
  assert.equal(logs, 0);
});

test('Electron cache validation: an empty file enters the download path and reports failure', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-cache-'));
  const previous = process.env.DSH_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.DSH_HOME = home;
  const path = defaultElectronExe();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const logs: string[] = [];
  // 非法版本 + 仅回环的镜像：这个用例绝不能真的下载运行时。
  const result = await ensureElectronDownload({
    version: 'invalid-version',
    mirror: 'http://127.0.0.1:1/',
    timeoutMs: 200,
    onLog: (e) => logs.push(e.text),
  });
  assert.equal(result, undefined);
  assert.ok(logs.some((m) => m.includes('缓存无效')));
  assert.ok(logs.some((m) => m.includes('下载失败')));
});

describe('hasGraphicalDisplay —— 无图形环境时不拉起 Electron', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'DSH_PET_DESKTOP_FORCE']) delete process.env[key];
    Object.assign(process.env, saved);
  });

  test('linux 无 DISPLAY / WAYLAND_DISPLAY：判为无图形环境（避免拉起即崩刷满 core dump）', () => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    // 非 linux（win32/darwin）桌面系统恒放行，故按平台断言
    assert.equal(hasGraphicalDisplay(), process.platform !== 'linux');
  });

  test('有 DISPLAY 时放行', () => {
    process.env.DISPLAY = ':0';
    assert.equal(hasGraphicalDisplay(), true);
  });

  test('有 WAYLAND_DISPLAY 时放行', () => {
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    assert.equal(hasGraphicalDisplay(), true);
  });

  test('DSH_PET_DESKTOP_FORCE=1 为逃生口（Xvfb / 远程桌面场景）', () => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    process.env.DSH_PET_DESKTOP_FORCE = '1';
    assert.equal(hasGraphicalDisplay(), true);
  });
});

describe('restartBackoffDelayMs —— 指数退避（750ms 起，2x 封顶 30s）', () => {
  test('退避序列：750 → 1500 → 3000 → 6000 → 12000 → 24000 → 30000（封顶后不再翻倍）', () => {
    // 注意别写 .map(restartBackoffDelayMs)：map 会把索引当 baseMs 传进去
    const seq = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => restartBackoffDelayMs(n));
    assert.deepEqual(seq, [750, 1500, 3000, 6000, 12000, 24000, 30000, 30000, 30000]);
  });

  test('DSH_PET_RESTART_BASE_MS 可调基值（同样 2x、封顶 30s）', () => {
    assert.equal(restartBackoffDelayMs(0, 1000), 1000);
    assert.equal(restartBackoffDelayMs(5, 1000), 30000);
  });
});

describe('shouldCircuitBreak —— 连续崩溃 12 次（约 3 分钟）后熔断', () => {
  test('前 11 次不熔断，第 12 次起熔断', () => {
    assert.equal(shouldCircuitBreak(0), false);
    assert.equal(shouldCircuitBreak(10), false);
    assert.equal(shouldCircuitBreak(11), false);
    assert.equal(shouldCircuitBreak(12), true);
    assert.equal(shouldCircuitBreak(50), true);
  });
});

describe('shouldFallbackToNoSandbox —— 沙箱起不来时自动改用 --no-sandbox 重试一次', () => {
  const base = { code: 0x80000003, sawOutput: false, ranMs: 300, alreadyApplied: false, customCommand: false };

  test('秒退、无输出、0x80000003 → 应该退一次', () => {
    assert.equal(shouldFallbackToNoSandbox(base), true);
  });

  test('Node 的两种报法都认：2147483651 与 -2147483645 指向同一个 0x80000003', () => {
    assert.equal(shouldFallbackToNoSandbox({ ...base, code: 2147483651 }), true);
    assert.equal(shouldFallbackToNoSandbox({ ...base, code: -2147483645 }), true);
  });

  test('有 stdout/stderr 说明 JS 已经跑过，病因不是沙箱 → 不退', () => {
    assert.equal(shouldFallbackToNoSandbox({ ...base, sawOutput: true }), false);
  });

  test('跑了一阵才崩（≥5s）是别的问题 → 不退', () => {
    assert.equal(shouldFallbackToNoSandbox({ ...base, ranMs: 6000 }), false);
  });

  test('只退一次：已经退过就回到正常退避/熔断', () => {
    assert.equal(shouldFallbackToNoSandbox({ ...base, alreadyApplied: true }), false);
  });

  test('自定义 command（测试/用户脚本）不猜 → 不退', () => {
    assert.equal(shouldFallbackToNoSandbox({ ...base, customCommand: true }), false);
  });

  test('别的退出码（含 0xC0000005 访问违例、普通 exit 1）→ 不退', () => {
    assert.equal(shouldFallbackToNoSandbox({ ...base, code: 3221225477 }), false);
    assert.equal(shouldFallbackToNoSandbox({ ...base, code: 1 }), false);
    assert.equal(shouldFallbackToNoSandbox({ ...base, code: null }), false);
  });
});

describe('helperRunIsStable —— 稳定运行 ≥3 分钟后计数清零', () => {
  test('不足 3 分钟：不稳定，不清零', () => {
    assert.equal(helperRunIsStable(2 * 60 * 1000), false);
  });

  test('达到 3 分钟：稳定，应清零', () => {
    assert.equal(helperRunIsStable(HELPER_STABLE_MS), true);
    assert.equal(helperRunIsStable(10 * 60 * 1000), true);
  });
});

describe('describeExit —— 崩溃退出码翻成可读片段', () => {
  test('访问违例：无符号与有符号两种报法指向同一个 0xC0000005', () => {
    assert.equal(describeExit(3221225477, null), 'code=3221225477 (0xC0000005 访问违例), signal=null');
    assert.equal(describeExit(-1073741819, null), 'code=-1073741819 (0xC0000005 访问违例), signal=null');
  });

  test('断点：0x80000003 标注为沙箱初始化失败', () => {
    assert.equal(describeExit(2147483651, null), 'code=2147483651 (0x80000003 断点（沙箱初始化失败）), signal=null');
  });

  test('普通退出码不补十六进制：避免把 exit 1 写成 0x1', () => {
    assert.equal(describeExit(1, null), 'code=1, signal=null');
    assert.equal(describeExit(0, null), 'code=0, signal=null');
  });

  test('未收录的 NTSTATUS：只给十六进制，不编造含义', () => {
    assert.equal(describeExit(3221225725, null), 'code=3221225725 (0xC00000FD), signal=null');
  });

  test('被信号终止：code=null，信号原样带上', () => {
    assert.equal(describeExit(null, 'SIGKILL'), 'code=null, signal=SIGKILL');
  });
});

describe('crashLoopAdvice —— 熔断建议按平台分支', () => {
  test('Windows：给换版本与指向现成可执行文件，不提 DISPLAY', () => {
    const advice = crashLoopAdvice('win32');
    assert.match(advice, /DSH_PET_ELECTRON_VERSION/);
    assert.match(advice, /DSH_PET_ELECTRON_PATH/);
    assert.match(advice, /DSH_PET_RESTART_MAX_FAILURES/);
    assert.ok(!advice.includes('DISPLAY'), 'Windows 上建议配 DISPLAY 是误导');
  });

  test('Linux：给显示环境与 Xvfb 逃生口', () => {
    const advice = crashLoopAdvice('linux');
    assert.match(advice, /DISPLAY/);
    assert.match(advice, /DSH_PET_DESKTOP_FORCE=1/);
  });

  test('macOS：指向现成可执行文件，不提显示环境', () => {
    const advice = crashLoopAdvice('darwin');
    assert.match(advice, /DSH_PET_ELECTRON_PATH/);
    assert.ok(!advice.includes('DISPLAY'));
  });
});

describe('readElectronVersion —— 读落地目录里的 version 文件', () => {
  test('正常读取：内容去掉换行后返回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-version-'));
    try {
      writeFileSync(join(dir, 'version'), '43.3.0\n');
      assert.equal(readElectronVersion(join(dir, 'electron.exe')), '43.3.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('文件缺失或内容不是版本号：返回 undefined，不编造', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-version-'));
    try {
      assert.equal(readElectronVersion(join(dir, 'electron.exe')), undefined);
      writeFileSync(join(dir, 'version'), 'not-a-version');
      assert.equal(readElectronVersion(join(dir, 'electron.exe')), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HelperProcess —— 退避/熔断的**接线**（纯函数之外，调用点本身）', () => {
  const sleep = (ms: number) => new Promise((resolve2) => setTimeout(resolve2, ms));

  /** 建一个「拉起即崩」的实例：测试进程里不能真 spawn（stdio 走 pipe），
   *  于是把 start() 换成「置时间戳 → 立刻回到 scheduleRestart」，
   *  等价于子进程 exit 后走的那条真实路径（计数、退避、熔断、日志全是真实代码）。 */
  function makeCrashing(logs: string[]): HelperProcess {
    const hp = new HelperProcess(
      {},
      {
        warn: (m: unknown) => logs.push(String(m)),
        error: (m: unknown) => logs.push(String(m)),
      },
    );
    const internals = hp as unknown as { lastStartAt: number; scheduleRestart(): void; start(): void };
    internals.start = () => {
      internals.lastStartAt = Date.now(); // 每次都是新拉起且立刻崩 → 永远不算「稳定运行」
      internals.scheduleRestart();
    };
    return hp;
  }

  /** 跑一轮崩溃循环，返回期间产生的日志；env 取值在 finally 里还原 */
  async function runCrashLoop(env: Record<string, string>, windowMs: number): Promise<string[]> {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const logs: string[] = [];
    const hp = makeCrashing(logs);
    try {
      hp.start();
      await sleep(windowMs);
    } finally {
      hp.stop('test-done');
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    return logs;
  }

  test('首次崩溃等待 base（默认 750ms），不是 2×base', async () => {
    // 首延必须是 base：计数在算延迟前不能自增（否则计数 1 取 2^1 = 2×base，首延变成 1500ms）
    const logs = await runCrashLoop({ DSH_PET_RESTART_BASE_MS: '1' }, 20);
    const first = logs.find((l) => l.includes('restarting in'));
    assert.ok(first, '应有一条重启告警');
    assert.match(first, /restarting in 1ms/);
  });

  test('DSH_PET_RESTART_MAX_FAILURES 真的接进判定：设 3 → 第 3 次就熔断', async () => {
    // DSH_PET_RESTART_MAX_FAILURES 必须接进判定：不能只出现在日志文案里、判定仍用默认值 12
    const logs = await runCrashLoop({ DSH_PET_RESTART_BASE_MS: '1', DSH_PET_RESTART_MAX_FAILURES: '3' }, 60);
    const tripped = logs.find((l) => l.includes('circuit breaker tripped'));
    assert.ok(tripped, '按用户设定的阈值应熔断');
    assert.match(tripped, /crashed 3 consecutive times/);
  });
});

describe('helperSpawnEnv —— spawn 环境构造（issue #63：ELECTRON_RUN_AS_NODE 必须删键）', () => {
  test('宿主环境带着污染 → 构造出的 env 里没有这个键', () => {
    // 宿主（DSH Desktop）自己就是 Electron 应用，process.env 里可能带着它；透传下去会让 helper
    // 以纯 Node 模式启动、require('electron') 直接 MODULE_NOT_FOUND（崩→重启→12 次熔断）
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      const env = helperSpawnEnv(1234);
      assert.equal('ELECTRON_RUN_AS_NODE' in env, false, '必须删键：设空串会让 Electron 直接 abort');
      assert.equal(env.DSH_PET_HOST_PID, '1234');
    } finally {
      if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = saved;
    }
  });

  test('调用方在 extra 里显式给这个键 → 同样删掉（我们要的永远是真正的 Electron 主进程）', () => {
    const env = helperSpawnEnv(7, { ELECTRON_RUN_AS_NODE: '1', DSH_PET_BRIDGE: '1' });
    assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
    assert.equal(env.DSH_PET_BRIDGE, '1');
    assert.equal(env.DSH_PET_HOST_PID, '7');
  });

  test('其余宿主环境变量照常继承、extra 覆盖同名键', () => {
    const saved = process.env.DSH_PET_TEST_MARKER;
    process.env.DSH_PET_TEST_MARKER = 'from-host';
    try {
      const env = helperSpawnEnv(1, { DSH_PET_TEST_MARKER: 'from-extra' });
      assert.equal(env.DSH_PET_TEST_MARKER, 'from-extra');
      assert.equal(helperSpawnEnv(1).DSH_PET_TEST_MARKER, 'from-host');
    } finally {
      if (saved === undefined) delete process.env.DSH_PET_TEST_MARKER;
      else process.env.DSH_PET_TEST_MARKER = saved;
    }
  });
});

describe('HelperProcess.stopAndWait —— 停止要等进程真正退出（issue #64）', () => {
  /** 假子进程：只需要 kill/exitCode/exit 事件这三样，避免测试里真 spawn（stdio 走 pipe） */
  class FakeChild extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: string[] = [];
    kill(signal?: string): boolean {
      this.signals.push(signal ?? 'SIGTERM');
      return true;
    }
    exit(): void {
      this.exitCode = 0;
      this.emit('exit', 0, null);
    }
  }

  function fakeHelper(timeoutMs: number) {
    const logs: string[] = [];
    const hp = new HelperProcess({}, { warn: (m: unknown) => logs.push(String(m)) });
    const fake = new FakeChild();
    (hp as unknown as { child?: FakeChild }).child = fake;
    return { fake, logs, stop: () => hp.stopAndWait('test', timeoutMs) };
  }

  test('正常退出：只发 SIGTERM、不升级，Promise 在 exit 时 resolve', async () => {
    const { fake, stop } = fakeHelper(1000);
    const p = stop();
    setTimeout(() => fake.exit(), 10);
    await p;
    assert.deepEqual(fake.signals, ['SIGTERM']);
  });

  test('超时未退 → 升级 SIGKILL（不是无限等）', async () => {
    const { fake, logs, stop } = fakeHelper(20);
    const p = stop();
    setTimeout(() => fake.exit(), 40); // 模拟"只在 SIGKILL 之后才退"
    await p;
    assert.deepEqual(fake.signals, ['SIGTERM', 'SIGKILL']);
    assert.ok(
      logs.some((l) => l.includes('SIGKILL')),
      '升级动作要有日志',
    );
  });

  test('连 SIGKILL 都不退 → 宽限期后仍 resolve（绝不挂住配置保存）', async (t) => {
    // FakeChild 没有真实进程句柄来撑住事件循环（生产的看门狗是 unref 的），
    // 所以这里显式推进两个截止时间。
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { fake, stop } = fakeHelper(20);
    let settled = false;
    const pending = stop().then(() => {
      settled = true;
    });
    t.mock.timers.tick(20);
    assert.deepEqual(fake.signals, ['SIGTERM', 'SIGKILL']);
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(HELPER_STOP_GRACE_MS);
    await pending;
    assert.equal(settled, true);
  });

  test('已经退出的子进程 → 立即 resolve，不挂监听', async () => {
    const { fake, stop } = fakeHelper(1000);
    fake.exitCode = 0;
    const started = Date.now();
    await stop();
    assert.ok(Date.now() - started < 50);
    assert.deepEqual(fake.signals, ['SIGTERM']);
  });
});

describe('HelperProcess failed spawn recovery', () => {
  test('keeps a running child after a non-spawn error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-live-child-'));
    const hp = new HelperProcess(
      { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: dir },
      {},
    );
    try {
      const child = hp.start()!;
      await once(child, 'spawn');
      child.emit('error', Object.assign(new Error('kill denied'), { code: 'EPERM' }));
      assert.equal(hp.start(), child, 'a live child must not be replaced after a failed operation');
    } finally {
      await hp.stopAndWait('test-cleanup', 100);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const code of ['ENOENT', 'EACCES']) {
    test(
      `retries ${code} after the executable is repaired`,
      { skip: code === 'EACCES' && process.platform === 'win32', timeout: 10000 },
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-spawn-'));
        const command = join(dir, 'electron');
        if (code === 'EACCES') writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
        const options = { command, args: ['-e', 'console.log("helper-recovered")'], cwd: dir };
        const logs: string[] = [];
        let recovered!: () => void;
        const ready = new Promise<void>((resolve) => {
          recovered = resolve;
        });
        const hp = new HelperProcess(options, {
          warn: (message) => {
            logs.push(String(message));
          },
          error: (message) => {
            logs.push(String(message));
          },
          debug: (message) => {
            if (String(message).includes('helper-recovered')) recovered();
          },
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const child = hp.start()!;
          const [error] = await once(child, 'error');
          assert.equal(error.code, code);
          // 在既有退避到期前修好配置的可执行文件。
          options.command = process.execPath;
          await Promise.race([
            ready,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('helper did not recover after failed spawn')), 5000);
            }),
          ]);
          assert.equal(logs.filter((line) => line.includes('failed to start')).length, 1);
          assert.equal(logs.filter((line) => line.includes('restarting in')).length, 1);
        } finally {
          clearTimeout(timeout);
          await hp.stopAndWait('test-cleanup', 100);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  }
});
