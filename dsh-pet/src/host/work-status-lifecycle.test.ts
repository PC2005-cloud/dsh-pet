/**
 * 任务详情文案的生命周期回归（issue #59）—— 在 **handler 层**跑真实事件序列，断言 `/work-status` 快照。
 *
 * 为什么单独有这一层：`currentTaskFromTodo` / `WorkStatusStore` 的单测只能证明"纯逻辑算得对"，
 * 而 issue #59 的两个现场症状都出在**事件序列 + 生命周期**上：
 *   ① 分阶段任务里文案不随进度走（多个 in_progress 时取了第一个）；
 *   ② 任务结束、之后开一段完全无关的对话，气泡仍挂着旧文案（task 曾是全局粘性字段）。
 * 因此这里用最小 ctx 桩把插件真跑起来（与 routes.test.ts 同一套桩思路），发一串真事件，再 GET 端点
 * 读快照——修坏了就会在这条测试上响。每个用例都 apply() 一个**全新实例**，避免用例之间互相影响。
 *
 * 跑法：node --experimental-strip-types --test src/host/work-status-lifecycle.test.ts
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';

import { apply } from './index.ts';

/** 工作状态快照（= S 里 sections.workStatus 的 data；ts 已由叶子 counter 取代，不再出现） */
type Snapshot = { state: string | null; task: string | null };
type Listener = (session: unknown, event: unknown) => void;
/** 一个插件的测试实例：发事件 + 读快照 + 收尾 */
type Harness = {
  emit: (sessionId: string, event: Record<string, unknown>) => void;
  snapshot: () => Promise<Snapshot>;
  dispose: () => void;
};

let dir = '';
let savedHome: string | undefined;
let savedElectron: string | undefined;
/** 本文件建过的全部实例（after 里统一释放：apply() 现在会起常驻的余额周期定时器） */
const harnesses: Harness[] = [];

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

/** 起一个全新的插件实例（每个用例一份，用例之间零串扰） */
function setup(): Harness {
  let handler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
  const listeners: Listener[] = [];
  const disposers: Array<() => void> = [];
  const noop = (): void => {};
  apply({
    effect: (fn: () => unknown) => {
      try {
        const ret = fn();
        if (typeof ret === 'function') disposers.push(ret as () => void);
        return ret;
      } catch {
        /* 源码形态下内置配置不可达，refreshDesktop 会抛给调用方——这里吞掉，不影响监听注册 */
      }
    },
    on: (name: string, cb: Listener) => {
      if (name === 'session/event') listeners.push(cb);
      return noop;
    },
    webServer: { register: (spec: { handler: typeof handler }) => ((handler = spec.handler), noop) },
    commands: { register: () => noop },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    agentDefaultModel: { currentSelection: () => undefined },
    credentials: { resolve: async () => undefined },
  });
  assert.ok(handler, 'apply() 应注册 /dsh-pet-7340 prefix handler');
  assert.ok(listeners.length > 0, 'apply() 应监听 session/event');

  const harness: Harness = {
    emit: (sessionId, event) => {
      // 同时喂给 work-status 与 notify 两个监听者，与宿主行为一致
      for (const l of listeners) l({ header: { id: sessionId } }, event);
    },
    snapshot: () =>
      new Promise<Snapshot>((done) => {
        const res = new FakeRes();
        res.on('finish', () => {
          // 快照现在住在 S 的 sections.workStatus 叶子里（/work-status 端点已删）：
          // 读它同时也是对"事件 → 写 S → /state 可读"这条新链路的端到端验证。
          const body = JSON.parse(Buffer.concat(res.chunks).toString('utf8')) as {
            sections?: { workStatus?: { data?: Snapshot | null } };
          };
          done(body.sections?.workStatus?.data ?? { state: null, task: null });
        });
        void handler?.({ method: 'GET', url: '/dsh-pet-7340/state', on: noop }, res);
      }),
    dispose: () => {
      // 插件收尾：清掉待执行的定时器（终态清理 60s；余额周期刷新是常驻的）——
      // 不释放的话测试进程跑完不退出。splice 先取走再执行：重复 dispose 是安全的空操作。
      for (const d of disposers.splice(0).reverse()) {
        try {
          d();
        } catch {
          /* 收尾失败不影响断言 */
        }
      }
    },
  };
  harnesses.push(harness);
  return harness;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-workstatus-'));
  savedHome = process.env.DSH_HOME;
  savedElectron = process.env.DSH_PET_ELECTRON_PATH;
  process.env.DSH_HOME = join(dir, 'home');
  // 命中一个已存在的文件：桌面 Helper 无论走哪条分支都不会真的下载/拉起
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;
});

after(() => {
  // 每个用例都 apply() 过一个全新实例：统一在这里释放（否则余额周期定时器等常驻句柄
  // 会把测试进程拖住不退出）。用例里也可以自行 dispose()，重复调用是安全的。
  for (const h of harnesses.splice(0)) h.dispose();
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (savedElectron === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
  else process.env.DSH_PET_ELECTRON_PATH = savedElectron;
  rmSync(dir, { recursive: true, force: true });
});

const TURN_START = (seq: number): Record<string, unknown> => ({ type: 'turn/start', seq, data: { turn: seq } });
const TOOL_CALL = (seq: number): Record<string, unknown> => ({ type: 'tool/call', seq, data: { name: 'read' } });
const TURN_END = (seq: number, kind: string): Record<string, unknown> => ({
  type: 'turn/end',
  seq,
  data: { reason: { kind } },
});
const TODO = (seq: number, ...items: Array<[string, string]>): Record<string, unknown> => ({
  type: 'todo/write',
  seq,
  data: { todos: items.map(([status, content]) => ({ status, content })) },
});

describe('任务文案生命周期 —— 现场场景 1：分阶段任务', () => {
  test('文案随当前进行中的步骤走：多个 in_progress 时取最后一个', async (t) => {
    const h = setup();
    t.after(h.dispose);

    h.emit('s1', TURN_START(1));
    const idle = await h.snapshot();
    assert.equal(idle.state, 'thinking');
    assert.equal(idle.task, null);

    h.emit('s1', TODO(2, ['in_progress', '正在执行 phase1']));
    assert.equal((await h.snapshot()).task, '正在执行 phase1');

    // agent 把 phase2 也标成 in_progress 却没收回 phase1：旧实现取第一个 → 永远停在 phase1
    h.emit('s1', TODO(3, ['in_progress', '正在执行 phase1'], ['in_progress', '正在执行 phase2']));
    assert.equal((await h.snapshot()).task, '正在执行 phase2');

    // phase1/2 收回、phase3 开始
    h.emit(
      's1',
      TODO(4, ['completed', '正在执行 phase1'], ['completed', '正在执行 phase2'], ['in_progress', '正在执行 phase3']),
    );
    assert.equal((await h.snapshot()).task, '正在执行 phase3');
  });

  test('清单里全部完成 → 文案清空（回落档位文案，不再永久屏蔽 workStatusTexts）', async (t) => {
    const h = setup();
    t.after(h.dispose);
    h.emit('s2', TURN_START(1));
    h.emit('s2', TODO(2, ['in_progress', '做点什么']));
    assert.equal((await h.snapshot()).task, '做点什么');
    h.emit('s2', TODO(3, ['completed', '做点什么']));
    assert.equal((await h.snapshot()).task, null);
  });

  test('新一轮 turn/start 清掉上一轮的详情；本轮再写 todo 会立刻填回来', async (t) => {
    const h = setup();
    t.after(h.dispose);
    h.emit('s3', TURN_START(1));
    h.emit('s3', TODO(2, ['in_progress', '上一轮的任务']));
    assert.equal((await h.snapshot()).task, '上一轮的任务');
    h.emit('s3', TURN_END(3, 'completed'));
    h.emit('s3', TURN_START(4));
    assert.equal((await h.snapshot()).task, null, '新一轮不得继续挂着上一轮的详情');
    assert.equal((await h.snapshot()).state, 'thinking');
    h.emit('s3', TODO(5, ['in_progress', '本轮的任务']));
    assert.equal((await h.snapshot()).task, '本轮的任务');
  });
});

describe('任务文案生命周期 —— 现场场景 2：任务结束后永久残留', () => {
  test('任务完成后再开一段无关对话：旧文案不得跟过来', async (t) => {
    const h = setup();
    t.after(h.dispose);
    h.emit('r1', TURN_START(1));
    h.emit('r1', TODO(2, ['in_progress', '早就做完的旧任务']));
    h.emit('r1', TURN_END(3, 'completed'));
    assert.equal((await h.snapshot()).task, '早就做完的旧任务', '终态展示窗口内仍显示最后做的事');

    // 完全无关的新一轮：不写 todo
    h.emit('r1', TURN_START(4));
    h.emit('r1', TOOL_CALL(5));
    h.emit('r1', TURN_END(6, 'completed'));
    const snap = await h.snapshot();
    assert.equal(snap.task, null, '无关对话期间不得残留旧任务文案');
    assert.equal(snap.state, 'success');
  });

  test('回合被打断（aborted）→ 会话条目与文案一并清掉，展示回空闲', async (t) => {
    const h = setup();
    t.after(h.dispose);
    h.emit('r2', TURN_START(1));
    h.emit('r2', TODO(2, ['in_progress', '被打断的任务']));
    h.emit('r2', TURN_END(3, 'aborted'));
    const snap = await h.snapshot();
    assert.equal(snap.state, null);
    assert.equal(snap.task, null);
  });

  test('终态展示窗口（60s）过后条目连同文案一起清掉', async (t) => {
    const h = setup();
    t.after(h.dispose);
    h.emit('r3', TURN_START(1));
    h.emit('r3', TODO(2, ['in_progress', '完成即清的任务']));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => t.mock.timers.reset());
    h.emit('r3', TURN_END(3, 'completed'));
    assert.equal((await h.snapshot()).task, '完成即清的任务');
    t.mock.timers.tick(60 * 1000);
    const snap = await h.snapshot();
    assert.equal(snap.state, null);
    assert.equal(snap.task, null);
  });

  test('会话没有活动条目时写 todo 不生效（不制造不会被展示的幽灵文案）', async (t) => {
    const h = setup();
    t.after(h.dispose);
    h.emit('ghost', TODO(1, ['in_progress', '幽灵任务']));
    assert.equal((await h.snapshot()).task, null);
  });
});

describe('任务文案生命周期 —— 多会话不串文案', () => {
  test('展示取优先级最高的会话，文案跟它走（不拿别的会话的文案冒充）', async (t) => {
    const h = setup();
    t.after(h.dispose);
    h.emit('m1', TURN_START(1));
    h.emit('m1', TOOL_CALL(2)); // working
    h.emit('m1', TODO(3, ['in_progress', 'M1 的任务']));
    assert.equal((await h.snapshot()).state, 'working');
    assert.equal((await h.snapshot()).task, 'M1 的任务');

    // m2 也进 working（seq 更大 → 同档取最近）→ 展示切到 m2；m2 没有详情 → task 必须为 null
    h.emit('m2', TURN_START(4));
    h.emit('m2', TOOL_CALL(5));
    assert.equal((await h.snapshot()).state, 'working');
    assert.equal((await h.snapshot()).task, null, '不得用 m1 的文案冒充 m2');

    h.emit('m2', TODO(6, ['in_progress', 'M2 的任务']));
    assert.equal((await h.snapshot()).task, 'M2 的任务');

    // m2 回合被打断 → 条目清掉，展示回 m1，文案也跟着回到 m1 的
    h.emit('m2', TURN_END(7, 'aborted'));
    const snap = await h.snapshot();
    assert.equal(snap.state, 'working');
    assert.equal(snap.task, 'M1 的任务');
  });
});
