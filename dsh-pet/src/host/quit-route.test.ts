/**
 * 托盘「退出」契约测试（issue #178）：GET /quit 探能力 → POST /quit 交给宿主停机。
 *
 * 为什么必须由宿主退：BRIDGE 模式下 Helper 由宿主拉起，它自己 `app.quit()` 会被当成崩溃按指数
 * 退避重启（点了只是闪一下）；真正退出要走宿主收尾（停 Helper → 关服务 → exit 0）。这条能力
 * 只有独立模式提供（standalone 伪 ctx 的 `shutdownApp`）——DSH 宿主没有该字段，关掉整个 DSH
 * 不该由一只宠物的托盘决定，所以菜单项在那边不出现。
 *
 * 这里钉住三件事：
 *   ① 能力按请求时判定：ctx 上没有 shutdownApp → canQuit:false，且 POST 不触发任何停机；
 *   ② 有该能力 → canQuit:true，POST 触发且 reason 正确；
 *   ③ 桌面端接线（源码守卫）：BRIDGE 下不得自己退，必须 POST /quit；退出不得调 syncDesktop。
 *
 * 用 `DSH_PET_IN_PROCESS=1` 让 `launchHelper` 短路：本测试只关心路由，绝不真的拉起 Electron。
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';

import { apply } from './index.ts';

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const hostSource = readSource('./index.ts') + '\n' + readSource('./routes/desktop.ts');

type Result = { status: number; body: string };

let dir = '';
let call: (url: string, method?: string, body?: string) => Promise<Result> = () =>
  Promise.reject(new Error('未初始化'));
let savedHome: string | undefined;
let savedElectron: string | undefined;
let savedInProcess: string | undefined;
/** apply() 注册的全部 effect 释放函数（after 里调用：常驻定时器否则会让测试进程不退出） */
const disposers: Array<() => void> = [];
/** 伪 ctx：shutdownApp 在用例之间删掉/挂回，用来验证「请求时判定」而不是「apply 时判定」 */
const hostCtx: Record<string, unknown> = {};
/** 每次 shutdownApp 被调用的原因（"没被误触发"也靠它断言） */
const quitReasons: string[] = [];
const shutdownSpy = (reason: string): void => {
  quitReasons.push(reason);
};

/** 最小响应桩：writeHead 记状态码，Writable 收集 body */
class FakeRes extends Writable {
  declare status: number;
  declare chunks: Buffer[];
  constructor() {
    super();
    this.status = 0;
    this.chunks = [];
  }
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-quit-'));
  savedHome = process.env.DSH_HOME;
  savedElectron = process.env.DSH_PET_ELECTRON_PATH;
  savedInProcess = process.env.DSH_PET_IN_PROCESS;
  process.env.DSH_HOME = join(dir, 'home');
  // 命中一个已存在的文件；再加下面的 IN_PROCESS 双保险 —— 本测试绝不 spawn
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;
  process.env.DSH_PET_IN_PROCESS = '1';

  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const noop = (): void => {};
  hostCtx.shutdownApp = shutdownSpy;
  // 必须与 hostCtx 是同一个引用（不能展开成新对象）：用例之间要 delete 掉 shutdownApp，
  // 验证 /quit 是「请求时判定」而不是 apply 时就把能力固定死。
  Object.assign(hostCtx, {
    effect: (fn: () => unknown) => {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose as () => void);
        return dispose;
      } catch {
        /* 源码形态下内置配置不可达，refreshDesktop 会抛——吞掉，不影响路由注册 */
      }
    },
    provide: () => noop,
    on: () => noop,
    webServer: {
      register: (spec: { handler: typeof handler }) => ((handler = spec.handler), noop),
    },
    commands: { register: () => noop },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'standalone', model: '' }) },
    credentials: { resolve: async () => undefined },
    llm: { listProviders: () => [], listModels: async () => [] },
  });
  apply(hostCtx);
  assert.ok(handler, 'apply() 应注册 /dsh-pet-7340 prefix handler');

  call = (url, method = 'GET', body) =>
    new Promise<Result>((done) => {
      const res = new FakeRes();
      res.on('finish', () => done({ status: res.status, body: Buffer.concat(res.chunks).toString('utf8') }));
      void handler?.(
        {
          method,
          url,
          on: (event: string, cb: (chunk?: Buffer) => void) => {
            if (event === 'data' && body !== undefined) queueMicrotask(() => cb(Buffer.from(body, 'utf8')));
            if (event === 'end') queueMicrotask(() => cb());
            return undefined;
          },
        },
        res,
      );
    });
});

after(() => {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose();
    } catch {
      /* 释放失败不影响其余清理 */
    }
  }
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (savedElectron === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
  else process.env.DSH_PET_ELECTRON_PATH = savedElectron;
  if (savedInProcess === undefined) delete process.env.DSH_PET_IN_PROCESS;
  else process.env.DSH_PET_IN_PROCESS = savedInProcess;
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /quit —— 探「宿主是否允许退出」', () => {
  test('宿主提供 shutdownApp → canQuit:true', async () => {
    const r = await call('/dsh-pet-7340/quit');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { canQuit: true });
  });

  test('DSH 宿主没有该能力 → canQuit:false（桌面端因此不显示退出项）', async () => {
    delete hostCtx.shutdownApp;
    try {
      const r = await call('/dsh-pet-7340/quit');
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), { canQuit: false });
    } finally {
      hostCtx.shutdownApp = shutdownSpy;
    }
  });
});

describe('POST /quit —— 把退出交给宿主停机', () => {
  test('有能力的宿主 → ok:true，原因记为「托盘退出」', async () => {
    quitReasons.length = 0;
    const r = await call('/dsh-pet-7340/quit', 'POST');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true });
    // setImmediate 里才真正调停机（先让 200 写出去）
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(quitReasons, ['托盘退出']);
  });

  test('没有能力 → 结构化失败，绝不误关宿主', async () => {
    delete hostCtx.shutdownApp;
    quitReasons.length = 0;
    try {
      const r = await call('/dsh-pet-7340/quit', 'POST');
      const body = JSON.parse(r.body) as { ok: boolean; reason: string };
      assert.equal(r.status, 200, '不支持退出是业务结论，不是协议层错误');
      assert.equal(body.ok, false);
      assert.equal(body.reason, 'unsupported');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(quitReasons, [], '没有能力时连一次停机都不许触发');
    } finally {
      hostCtx.shutdownApp = shutdownSpy;
    }
  });

  test('PUT → 405（退出是动作端点，不是可保存的资源）', async () => {
    const r = await call('/dsh-pet-7340/quit', 'PUT');
    assert.equal(r.status, 405);
  });
});

describe('桌面端与独立模式的接线（源码守卫：两半各自构建，无法互相 import）', () => {
  // 托盘的退出项与点击行为改成行为测试了（见 desktop-tray.test.ts）：源码守卫一改缩进就红，
  // 守不住真正的契约。这里只留独立模式那条无法用行为覆盖的接线。
  const cli = readSource('../standalone/cli.ts');
  const context = readSource('../standalone/context.ts');

  test('独立模式：停机能力挂到伪 ctx，并复用 /shutdown 的 forwardShutdown', () => {
    assert.match(context, /options\.shutdown \? \{ shutdownApp: options\.shutdown \} : \{\}/);
    assert.match(cli, /shutdown: \(reason\) => forwardShutdown\(reason\)/);
  });

  test('退出不是重启：/quit 路由块内不得调用 syncDesktop()', () => {
    const block = /if \(rest === 'quit'\) \{([\s\S]*?)\n {2}\}/.exec(hostSource);
    assert.ok(block, '宿主必须有 /quit 路由');
    assert.ok(!/syncDesktop/.test(block[1]), '退出不是重启：reload 守卫要求 syncDesktop 恰好 4 次');
  });
});
