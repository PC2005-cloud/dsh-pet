import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateChat } from './chat.ts';
import { createLlmFacade } from '../standalone/llm-facade.ts';

test('durable-only DSH hosts explicitly reject transient screenshots without dropping pixels or making a model call', async () => {
  let calls = 0;
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    llm: {
      stream: () => {
        calls++;
        throw new Error('must not call');
      },
    },
  };
  const result = await generateChat({
    ctx,
    system: '',
    history: [],
    userText: '/look',
    transientImage: { dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgD/2Q==', width: 1920, height: 1080 },
  });
  assert.ok(!result.ok && /不支持仅内存/.test(result.message ?? ''));
  assert.equal(calls, 0);
});

test('only the standalone facade advertises memory image support', () => {
  const facade = createLlmFacade({
    currentSelection: () => ({ provider: 'standalone', model: 'test' }),
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => undefined,
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', text: 'unused' };
      },
    }),
    isReady: () => true,
    balanceAuth: () => ({ provider: '', apiKey: '' }),
    dispose() {},
  });
  assert.equal(facade.supportsTransientImages, true);
});
