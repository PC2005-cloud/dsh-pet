/**
 * 模型候选链单元测试 —— 钉住「条目配置的模型优先、失败回落当前对话的模型」这条链的构造规则：
 *  - whisperModel / chatModel 留空（内置默认）→ 链上**只有**当前对话的模型（旧行为逐字不变）；
 *  - 填了 → 配置的模型在前、当前对话的模型在后（生成侧按序尝试，前者失败才用后者重试一次）；
 *  - 两个来源是同一个选择 → 去重只留一个（否则失败时会拿同一个模型白试一遍、白等一个超时）；
 *  - 当前对话没配模型 → 只留配置的那个；两边都拿不到 → 空链（生成侧回「当前对话未配置模型」）。
 *
 * 本模块不 import @deepseek-ai/dsh-llm（纯逻辑），故能在 node:test 里直接跑——
 * 与 chat.test.ts 只测 memes.ts 同一个理由。
 *
 * 跑法：node --experimental-strip-types --test src/host/model-selection.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { configuredModel, currentModel, modelCandidates, modelLabel, type ModelRef } from './model-selection.ts';

/** 造一个宿主 ctx：currentSelection 返回给定选择（undefined = 未配置，'throw' = 抛错） */
function ctxOf(sel: ModelRef | undefined | 'throw'): { agentDefaultModel: { currentSelection(): ModelRef } } {
  return {
    agentDefaultModel: {
      currentSelection: () => {
        if (sel === 'throw') throw new Error('当前对话未配置模型');
        return sel as unknown as ModelRef;
      },
    },
  };
}

describe('configuredModel —— 条目配置里的 whisperModel / chatModel', () => {
  test('两个字段都非空 → 该选择', () => {
    assert.deepEqual(
      configuredModel({ whisperModel: { provider: 'deepseek', model: 'deepseek-chat' } }, 'whisperModel'),
      {
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    );
  });

  test('都留空（内置默认）→ undefined（= 跟随当前对话）', () => {
    assert.equal(configuredModel({ whisperModel: { provider: '', model: '' } }, 'whisperModel'), undefined);
  });

  test('只填一半 / 结构不对 → undefined（合并器已挡下，这里再防御一次）', () => {
    const bad: unknown[] = [
      { provider: 'deepseek', model: '' },
      { provider: '', model: 'deepseek-chat' },
      { provider: 'deepseek' },
      'deepseek/deepseek-chat',
      ['deepseek', 'deepseek-chat'],
      null,
    ];
    for (const value of bad) {
      assert.equal(
        configuredModel({ chatModel: value }, 'chatModel'),
        undefined,
        `${JSON.stringify(value)} 应视为未指定`,
      );
    }
    assert.equal(configuredModel({}, 'chatModel'), undefined, '整个字段缺失同样视为未指定');
    assert.equal(configuredModel(undefined, 'chatModel'), undefined, '条目缺失时不得抛错');
  });

  test('两侧空白被 trim（写配置时手滑多打空格不算另一个模型）', () => {
    assert.deepEqual(
      configuredModel({ chatModel: { provider: ' deepseek ', model: ' deepseek-chat ' } }, 'chatModel'),
      {
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    );
  });

  test('两个键互不串台：whisperModel 不读 chatModel', () => {
    const conf = { whisperModel: { provider: 'a', model: 'a1' }, chatModel: { provider: 'b', model: 'b1' } };
    assert.equal(configuredModel(conf, 'whisperModel')?.provider, 'a');
    assert.equal(configuredModel(conf, 'chatModel')?.provider, 'b');
  });
});

describe('currentModel —— 当前对话的模型', () => {
  test('有选择 → 原样返回', () => {
    assert.deepEqual(currentModel(ctxOf({ provider: 'deepseek', model: 'deepseek-reasoner' })), {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    });
  });

  test('未配置 / 抛错 / ctx 不完整 → undefined（绝不向上抛）', () => {
    assert.equal(currentModel(ctxOf(undefined)), undefined);
    assert.equal(currentModel(ctxOf('throw')), undefined);
    assert.equal(currentModel({}), undefined);
  });
});

describe('modelCandidates —— 候选链（配置优先 → 当前对话兜底）', () => {
  const configured: ModelRef = { provider: 'deepseek', model: 'deepseek-chat' };
  const current: ModelRef = { provider: 'opencode', model: 'big-model' };

  test('配置留空 → 链上只有当前对话的模型（旧行为逐字不变）', () => {
    assert.deepEqual(modelCandidates(ctxOf(current), undefined), [current]);
  });

  test('配置了 → 配置的在前、当前对话的在后（回落重试一次）', () => {
    assert.deepEqual(modelCandidates(ctxOf(current), configured), [configured, current]);
  });

  test('两个来源相同 → 去重（不拿同一个模型白试一遍）', () => {
    assert.deepEqual(modelCandidates(ctxOf(configured), configured), [configured]);
  });

  test('当前对话没配模型 → 只留配置的那个', () => {
    assert.deepEqual(modelCandidates(ctxOf(undefined), configured), [configured]);
  });

  test('两边都拿不到 → 空链（生成侧据此回「当前对话未配置模型」）', () => {
    assert.deepEqual(modelCandidates(ctxOf(undefined), undefined), []);
  });
});

describe('modelLabel —— 报错/日志标签', () => {
  test('provider/model', () => {
    assert.equal(modelLabel({ provider: 'deepseek', model: 'deepseek-chat' }), 'deepseek/deepseek-chat');
  });
});
