/**
 * 桌面窗口唤起的契约测试。
 *
 * 这里守的是三条**经验结论**，不是实现细节：win32 只能经 explorer 转交（cmd / PowerShell 拿不到
 * 前台权限）、opener 必须 detached 起（explorer 在继承控制台时不转发）、宿主自己的
 * `ELECTRON_RUN_AS_NODE` 不能透传（协议会以 node 模式空转）。
 * @module dsh-pet/src/host/reveal.test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isDesktopHost,
  openerEnv,
  revealCommand,
  revealDesktopWindow,
  REVEAL_URL,
  spawnOpener,
  type RevealLogger,
} from './reveal.ts';
import { handleRevealRoutes } from './routes/reveal.ts';
import type { PetRouteDeps, RouteInput } from './routes/types.ts';

/** 包内源码（守卫用；相对 src/host/ 解析）。 */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 把 `process.versions.electron` 临时装上去，跑完还原（等价于「这一进程是桌面宿主」）。 */
function withDesktopHost<T>(fn: () => T): T {
  Object.defineProperty(process.versions, 'electron', { value: '44.7.0', configurable: true, writable: true });
  try {
    return fn();
  } finally {
    delete (process.versions as unknown as Record<string, unknown>).electron;
  }
}

/** 记日志的替身：只收集，不输出。 */
function recordingLogger(): { logger: RevealLogger; info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  return { logger: { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) }, info, warn };
}

/** 只带 log 的最小 deps：/reveal 用不到别的东西。 */
function depsWith(log: RevealLogger): PetRouteDeps {
  return { log } as unknown as PetRouteDeps;
}

/** 构造一次路由输入。 */
function input(rest: string, method: string): RouteInput {
  return { url: new URL(`http://127.0.0.1/dsh-pet-7340/${rest}`), rest, method };
}

describe('revealCommand —— 按平台选 opener', () => {
  test('win32 走 explorer.exe（宿主的子进程拿不到前台权限）', () => {
    assert.deepEqual(revealCommand('win32'), { command: 'explorer.exe', args: [REVEAL_URL] });
  });

  test('darwin 走 open、其余平台走 xdg-open', () => {
    assert.deepEqual(revealCommand('darwin'), { command: 'open', args: [REVEAL_URL] });
    assert.deepEqual(revealCommand('linux'), { command: 'xdg-open', args: [REVEAL_URL] });
  });

  test('协议 URL 就是桌面端的 focusPrimaryWindow 入口', () => {
    assert.equal(REVEAL_URL, 'dsh://open');
  });
});

describe('openerEnv —— 不能把宿主的纯 Node 模式透传下去', () => {
  test('删掉 ELECTRON_RUN_AS_NODE，其余原样保留', () => {
    const env = openerEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: 'x', DSH_HOME: 'y' });
    assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
    assert.equal(env.PATH, 'x');
    assert.equal(env.DSH_HOME, 'y');
  });

  test('不修改入参对象', () => {
    const base: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
    openerEnv(base);
    assert.equal(base.ELECTRON_RUN_AS_NODE, '1');
  });
});

describe('isDesktopHost —— 形态判定', () => {
  test('纯 Node（dsh web / 独立模式）不是桌面宿主', () => {
    assert.equal(isDesktopHost(), false);
  });

  test('带 process.versions.electron 就是桌面宿主（ELECTRON_RUN_AS_NODE 下该字段仍在）', () => {
    assert.equal(
      withDesktopHost(() => isDesktopHost()),
      true,
    );
  });
});

describe('spawnOpener —— 只看 spawn 事件', () => {
  test('进程起得来就算成功', async () => {
    const outcome = await spawnOpener({ command: process.execPath, args: ['-e', '0'] });
    assert.equal(outcome.revealed, true);
    if (outcome.revealed) assert.equal(outcome.command, process.execPath);
  });

  test('命令不存在时给出 spawn-failed 而不是抛异常', async () => {
    const rec = recordingLogger();
    const outcome = await spawnOpener({ command: 'dsh-pet-no-such-command-xyz', args: [] }, rec.logger);
    assert.equal(outcome.revealed, false);
    if (!outcome.revealed) assert.equal(outcome.reason, 'spawn-failed');
    assert.equal(rec.warn.length, 1);
  });
});

describe('revealDesktopWindow —— 非桌面宿主不 spawn', () => {
  test('dsh web 直接给 not-desktop', async () => {
    const outcome = await revealDesktopWindow();
    assert.equal(outcome.revealed, false);
    if (!outcome.revealed) assert.equal(outcome.reason, 'not-desktop');
  });
});

describe('POST /reveal —— 路由契约', () => {
  test('未命中别的 rest 时不下结论', async () => {
    assert.equal(await handleRevealRoutes(depsWith(recordingLogger().logger), input('state', 'POST')), undefined);
  });

  test('只有 POST：GET 回 405', async () => {
    const result = await handleRevealRoutes(depsWith(recordingLogger().logger), input('reveal', 'GET'));
    assert.equal(result?.kind, 'json');
    if (result?.kind === 'json') assert.equal(result.status, 405);
  });

  test('非桌面宿主回 200 + revealed:false（结论不是协议错误）', async () => {
    const result = await handleRevealRoutes(depsWith(recordingLogger().logger), input('reveal', 'POST'));
    assert.equal(result?.kind, 'json');
    if (result?.kind === 'json') {
      assert.equal(result.status, 200);
      assert.deepEqual(result.obj, { revealed: false, reason: 'not-desktop' });
    }
  });
});

describe('源码守卫 —— 防止退回绕后台锁的老路', () => {
  /** 去掉注释后的码面：注释里会解释这些名字，不能被当成实现。 */
  const codeOf = (rel: string): string =>
    readSource(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('host 侧不再自己调窗口 API / 起 cmd、PowerShell', () => {
    const code = codeOf('./reveal.ts') + codeOf('./routes/reveal.ts');
    assert.ok(
      !/cmd\.exe|powershell|SetForegroundWindow|SetWindowPos|SwitchToThisWindow|ShowWindow|Add-Type/i.test(code),
    );
  });

  test('opener 必须 detached 起（继承控制台时 explorer 不转发协议）', () => {
    assert.ok(/detached:\s*true/.test(codeOf('./reveal.ts')));
  });

  test('浏览器半侧点击走 /reveal，深链只作兜底', () => {
    const code = codeOf('../client/notify.ts');
    assert.ok(/ROUTE_PATH \+ '\/reveal'/.test(code));
    assert.ok(/\.catch\(\(\) => openProtocolFrame\(\)\)/.test(code));
  });
});
