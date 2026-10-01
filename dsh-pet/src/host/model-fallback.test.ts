/**
 * 生成侧的「模型回落」测试 —— 钉住 A 方案的实际行为（issue #75）：
 * 条目配置的 whisperModel / chatModel 优先；它调用失败（凭据被删 / 模型下架 / 该服务商没配 key）
 * 时**回落到当前对话的模型重试一次**；仍失败才把**最后一次**（当前对话模型）的失败原因抛出去。
 *
 * 用假 ctx.llm.stream 驱动（不碰真服务商、不联网）：按 provider 决定这次是抛错、返回空流还是正常文本，
 * 并记录每次调用的 provider/model——回落的顺序与次数就是本文件要钉的不变式。
 *
 * 跑法：node --experimental-strip-types --test src/host/model-fallback.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generateWhisper } from './whisper.ts';
import { generateChat } from './chat.ts';
import type { ModelRef } from './model-selection.ts';

/** 一次调用的行为：ok = 正常出文本；throw = 流里抛错；empty = 空流（"模型未返回文本"） */
type Behavior = 'ok' | 'throw' | 'empty';

const CONFIGURED: ModelRef = { provider: 'configured', model: 'cheap-model' };
const CURRENT: ModelRef = { provider: 'current', model: 'main-model' };

/** 造一个假 ctx：currentSelection 返回 current（'throw' = 抛错），llm.stream 按 provider 决定行为 */
function fakeCtx(current: ModelRef | 'throw', behavior: Record<string, Behavior>) {
  const calls: ModelRef[] = [];
  const ctx = {
    agentDefaultModel: {
      currentSelection: (): ModelRef => {
        if (current === 'throw') throw new Error('当前对话未配置模型');
        return current;
      },
    },
    llm: {
      // 声明"无 reasoning 元数据"：supportsReasoningOff 返回 false，不附加 reasoningEffort
      resolveModelInfo: async () => ({}),
      stream: (o: ModelRef) => {
        calls.push({ provider: o.provider, model: o.model });
        const b = behavior[o.provider] ?? 'throw';
        return (async function* () {
          if (b === 'throw') throw new Error(o.provider + ' 不可用');
          if (b === 'empty') return;
          yield { type: 'text-delta', index: 0, text: '你好呀' };
        })();
      },
    },
  };
  return { ctx, calls };
}

describe('generateWhisper —— 配置模型优先、失败回落当前对话', () => {
  test('配置的模型可用 → 只调它一次，不碰当前对话的模型', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'ok', current: 'ok' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CONFIGURED], '配置可用时不得再调当前对话的模型');
  });

  test('配置的模型抛错 → 回落到当前对话的模型重试一次', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'throw', current: 'ok' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.deepEqual(r, { ok: true, text: '你好呀' }, '回落成功应返回正常文本');
    assert.deepEqual(calls, [CONFIGURED, CURRENT], '顺序必须是「配置的 → 当前对话的」');
  });

  test('配置的模型返回空流（模型未返回文本）→ 同样回落', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'empty', current: 'ok' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CONFIGURED, CURRENT]);
  });

  test('两个都失败 → 返回最后一次（当前对话模型）的失败原因', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'throw', current: 'throw' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'generate-error');
    assert.equal(r.ok === false && r.message, 'current 不可用', '报错应来自当前对话的模型（用户真正在用的那个）');
    assert.deepEqual(calls, [CONFIGURED, CURRENT]);
  });

  test('没配模型（留空）→ 只调当前对话的模型一次（旧行为逐字不变）', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { current: 'ok' });
    const r = await generateWhisper(ctx, '人设', undefined, undefined);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CURRENT]);
  });

  test('两边都拿不到模型 → provider-missing，且一次都不调用 LLM', async () => {
    const { ctx, calls } = fakeCtx('throw', {});
    const r = await generateWhisper(ctx, '人设', undefined, undefined);
    assert.deepEqual(r, { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' });
    assert.deepEqual(calls, []);
  });

  test('配置的模型与当前对话相同 → 去重，失败时只试一次', async () => {
    const { ctx, calls } = fakeCtx(CONFIGURED, { configured: 'throw' });
    const r = await generateWhisper(ctx, '人设', undefined, CONFIGURED);
    assert.equal(r.ok, false);
    assert.deepEqual(calls, [CONFIGURED], '同一个模型不得试两遍（白等一个超时）');
  });
});

describe('generateChat —— 同一套回落规则（chatModel）', () => {
  test('配置的模型抛错 → 回落到当前对话的模型', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { configured: 'throw', current: 'ok' });
    const r = await generateChat(ctx, '人设', [], '在吗', [], CONFIGURED);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CONFIGURED, CURRENT]);
  });

  test('留空 → 只用当前对话的模型（旧行为）', async () => {
    const { ctx, calls } = fakeCtx(CURRENT, { current: 'ok' });
    const r = await generateChat(ctx, '人设', [], '在吗', [], undefined);
    assert.deepEqual(r, { ok: true, text: '你好呀' });
    assert.deepEqual(calls, [CURRENT]);
  });

  test('两边都拿不到模型 → provider-missing，且一次都不调用 LLM', async () => {
    const { ctx, calls } = fakeCtx('throw', {});
    const r = await generateChat(ctx, '人设', [], '在吗', [], undefined);
    assert.deepEqual(r, { ok: false, reason: 'provider-missing', message: '当前对话未配置模型' });
    assert.deepEqual(calls, []);
  });
});
