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
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  HELPER_STABLE_MS,
  HelperProcess,
  dshHomeDir,
  defaultElectronExe,
  hasGraphicalDisplay,
  helperRunIsStable,
  helperSpawnEnv,
  restartBackoffDelayMs,
  resolveElectronPath,
  shouldCircuitBreak,
} from './helper-process.ts';

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

describe('helperRunIsStable —— 稳定运行 ≥3 分钟后计数清零', () => {
  test('不足 3 分钟：不稳定，不清零', () => {
    assert.equal(helperRunIsStable(2 * 60 * 1000), false);
  });

  test('达到 3 分钟：稳定，应清零', () => {
    assert.equal(helperRunIsStable(HELPER_STABLE_MS), true);
    assert.equal(helperRunIsStable(10 * 60 * 1000), true);
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
    // 曾经是「先自增再算延迟」：计数 1 取 2^1 = 2×base，首延变成 1500ms，与注释/旧版固定 750ms 都不符
    const logs = await runCrashLoop({ DSH_PET_RESTART_BASE_MS: '1' }, 20);
    const first = logs.find((l) => l.includes('restarting in'));
    assert.ok(first, '应有一条重启告警');
    assert.match(first, /restarting in 1ms/);
  });

  test('DSH_PET_RESTART_MAX_FAILURES 真的接进判定：设 3 → 第 3 次就熔断', async () => {
    // 曾经这个环境变量只出现在日志文案里，判定用的是 shouldCircuitBreak 的默认值 12
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

  test('连 SIGKILL 都不退 → 宽限期后仍 resolve（绝不挂住配置保存）', async () => {
    const { stop } = fakeHelper(20);
    const started = Date.now();
    await stop(); // 全程没有 exit 事件
    const spent = Date.now() - started;
    assert.ok(spent >= 20, `至少等满超时再升级（实际 ${spent}ms）`);
    assert.ok(spent < 3000, `应在宽限期内放弃等待，而不是无限挂住（实际 ${spent}ms）`);
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
