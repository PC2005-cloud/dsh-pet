/**
 * 伪 ctx 的语义契约测试。
 *
 * 为什么值得单独测：独立模式把插件的宿主半边（`apply`）跑在这个 ctx 上，
 * 而 `apply` 里有 9 个 effect、两条自我续期的轮询定时器，以及"最后一行才拉起桌面 Helper"
 * 的顺序依赖。这里逐条钉住 ctx 必须满足的语义（与 Cordis 对齐）与服务替身的降级口径 ——
 * 任何一条不成立，独立模式要么起不来，要么悄悄变成"能跑但没宠物"。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { modelCandidates } from '../host/model-selection.ts';
import { generateWhisper } from '../host/whisper.ts';
import { STANDALONE_PROVIDER, createStandaloneContext } from './context.ts';
import type { RegisteredRoute, StandaloneLogger } from './context.ts';

/** 静默日志器：测试只断言行为，不刷控制台 */
function silentLogger(): StandaloneLogger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    info: () => {},
    warn: () => {},
    error: (message: string) => errors.push(message),
    debug: () => {},
  };
}

type Standalone = ReturnType<typeof createStandaloneContext>;

// 伪 ctx 的成员形状各不相同（`effect`/`on` 本身是函数，其余是对象），逐个取，
// 不写笼统的索引访问 —— 形状错了希望在这里就报出来，而不是在插件里。
const effectOf = (context: Standalone): ((fn: () => unknown, label?: string) => unknown) =>
  context.ctx.effect as (fn: () => unknown, label?: string) => unknown;
const onOf = (context: Standalone): (() => unknown) => context.ctx.on as () => unknown;
const commandsOf = (context: Standalone): { register(): unknown } => context.ctx.commands as { register(): unknown };
const webServerOf = (context: Standalone): { port: number; register(spec: RegisteredRoute): unknown } =>
  context.ctx.webServer as { port: number; register(spec: RegisteredRoute): unknown };
const agentOf = (context: Standalone): { currentSelection(): { provider: string; model: string } } =>
  context.ctx.agentDefaultModel as { currentSelection(): { provider: string; model: string } };
const credentialsOf = (context: Standalone): { resolve(ref: unknown): Promise<unknown> } =>
  context.ctx.credentials as { resolve(ref: unknown): Promise<unknown> };
const llmOf = (
  context: Standalone,
): {
  listProviders(): unknown[];
  listModels(provider: string): Promise<unknown[]>;
  // 形状必须是 AsyncIterable（DSH 的 llm.stream 签名）。这里若写成 Promise，
  // 就与替身实现犯了同一个错 —— 也正是这个断言让 0.3.4 的类型检查与真实契约脱节。
  stream(options: unknown): AsyncIterable<unknown>;
} =>
  context.ctx.llm as {
    listProviders(): unknown[];
    listModels(provider: string): Promise<unknown[]>;
    stream(options: unknown): AsyncIterable<unknown>;
  };

describe('createStandaloneContext —— 与 Cordis 对齐的语义', () => {
  test('effect 同步执行、收集释放函数；dispose 逆序释放且等待异步释放', async () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const order: string[] = [];
    const effect = effectOf(context);
    // 同步执行：apply() 返回后路由必须已经在册（仓库自己的 routes.test.ts 也依赖这一点）
    effect(() => {
      order.push('first');
      return () => {
        order.push('dispose-first');
      };
    });
    effect(() => {
      order.push('second');
      return async () => {
        await Promise.resolve();
        order.push('dispose-second');
      };
    });
    assert.deepEqual(order, ['first', 'second'], 'effect 必须在调用时就跑');
    await context.dispose();
    assert.deepEqual(order, ['first', 'second', 'dispose-second', 'dispose-first'], '释放顺序：后注册先释放');
  });

  test('effect 内抛错只记录不中断（源码形态读不到包内 assets 时正是这里抛）', () => {
    const logger = silentLogger();
    const context = createStandaloneContext({ port: 1, logger });
    const effect = effectOf(context);
    effect(() => {
      throw new Error('内置默认配置缺失');
    });
    effect(() => 'not-a-disposer');
    assert.equal(context.failures.length, 1);
    assert.match(context.failures[0] ?? '', /内置默认配置缺失/);
    assert.match(logger.errors.join('\n'), /内置默认配置缺失/, '失败必须留日志，不能吞掉');
  });

  test('webServer.register 收下路由并返回可调用对象（插件把它当 effect 释放函数）', () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const webServer = webServerOf(context);
    const handler = (): void => {};
    const dispose = webServer.register({ kind: 'prefix', path: '/dsh-pet-7340', handler });
    assert.equal(typeof dispose, 'function');
    assert.equal(context.routes.length, 1);
    assert.equal(context.routes[0]?.path, '/dsh-pet-7340');
    assert.equal(context.routes[0]?.handler, handler);
    (dispose as () => void)();
    assert.equal(context.routes.length, 0, '释放后路由应移除');
  });

  test('webServer.port 惰性读取：先起服务、后 apply 时插件读到的是真端口', () => {
    const portRef = { value: 0 };
    const context = createStandaloneContext({ port: () => portRef.value, logger: silentLogger() });
    const webServer = webServerOf(context);
    assert.equal(webServer.port, 0, '未监听时端口就是 0（插件据此延迟重试，不会误拉窗口）');
    portRef.value = 31234;
    assert.equal(webServer.port, 31234, '监听完成后插件必须读到真实端口');
  });

  test('on() / commands.register() 必须返回可调用对象（插件把它们当释放函数用）', () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    assert.equal(typeof onOf(context)(), 'function');
    assert.equal(typeof commandsOf(context).register(), 'function');
  });
});

describe('服务替身的降级口径 —— 显式失败，不假装成功', () => {
  test('currentSelection 的 model 为空 → 模型候选链为空（生成停在候选阶段）', () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const selection = agentOf(context).currentSelection();
    assert.equal(selection.provider, STANDALONE_PROVIDER);
    // model 必须为空：model-selection.currentModel() 以「provider 与 model 都非空」为有效条件，
    // 空 model 于是让候选链为空 —— 这是"独立模式不产生任何模型调用"的结构性保证，
    // 而不是靠某个端点上的 if。
    assert.equal(selection.model, '');
    assert.deepEqual(modelCandidates(context.ctx as never, undefined), []);
  });

  test('碎碎念用这份 ctx 得到结构化失败 provider-missing（不联网、不编文案）', async () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    const result = await generateWhisper(context.ctx as never, '你是一只桌宠');
    assert.deepEqual(result, { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' });
  });

  test('凭证恒不可得；llm 清单为空、生成入口是"迭代即失败"的 async iterable', async () => {
    const context = createStandaloneContext({ port: 1, logger: silentLogger() });
    assert.equal(await credentialsOf(context).resolve('DEEPSEEK_API_KEY'), undefined);
    const llm = llmOf(context);
    assert.deepEqual(llm.listProviders(), []);
    assert.deepEqual(await llm.listModels('deepseek'), []);
    // 契约：stream() 返回的是 AsyncIterable（DSH 的 llm.stream 签名），不是 Promise。
    // 旧断言写成 "stream() 自己 reject"，把错误的契约固化了下来：它从未走 for await，
    // 所以全绿；而真实集成一跑就崩（TypeError + 无人接管的 rejected promise）。
    const streamed = llm.stream({});
    assert.equal(typeof streamed[Symbol.asyncIterator], 'function');
    await assert.rejects(async () => {
      for await (const chunk of streamed) void chunk;
    }, /独立模式未接入模型/);
  });
});
