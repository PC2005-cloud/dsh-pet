import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createStandaloneContext } from './context.ts';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

function modelService() {
  const calls: string[] = [];
  return {
    calls,
    currentSelection: () => ({ provider: 'standalone', model: 'configured-model' }),
    listProviders: () => [{ id: 'standalone', name: '本机 API' }],
    listModels: async (provider?: string) => {
      void provider;
      return [{ id: 'configured-model', name: 'configured-model' }];
    },
    resolveModelInfo: async () => undefined,
    stream: (options?: unknown): AsyncIterable<{ type: 'text'; text: string }> => {
      void options;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', text: '你好' };
        },
      };
    },
    isReady: () => true,
    canWhisper: () => false,
    getSettings: () => ({ whisperIntervalSec: 300 }),
    dispose: () => calls.push('dispose'),
  };
}

test('configured standalone context delegates model contracts without changing stream shape', async () => {
  const ai = modelService();
  const context = createStandaloneContext({ port: 31380, logger, ai });
  const selection = context.ctx.agentDefaultModel as { currentSelection(): unknown };
  const llm = context.ctx.llm as typeof ai;
  assert.deepEqual(selection.currentSelection(), { provider: 'standalone', model: 'configured-model' });
  assert.deepEqual(llm.listProviders(), ai.listProviders());
  assert.deepEqual(await llm.listModels('standalone'), await ai.listModels());
  assert.equal(await llm.resolveModelInfo(), undefined);
  const chunks = [];
  for await (const chunk of llm.stream({})) chunks.push(chunk);
  assert.deepEqual(chunks, [{ type: 'text', text: '你好' }]);
  await context.dispose();
  await context.dispose();
  assert.deepEqual(ai.calls, ['dispose']);
});

test('trusted settings URL and automatic-whisper policy remain private context capabilities', () => {
  const ai = modelService();
  const context = createStandaloneContext({
    port: 31380,
    logger,
    ai,
    authenticatedUrl: (baseUrl) => `${baseUrl}/standalone-ai/#token=test-only`,
  });
  const connection = context.ctx.connection as { authenticatedUrl(baseUrl: string): string };
  assert.equal(
    connection.authenticatedUrl('http://127.0.0.1:31380'),
    'http://127.0.0.1:31380/standalone-ai/#token=test-only',
  );
  const policy = context.ctx.standaloneAi as {
    isReady(): boolean;
    canWhisper(): boolean;
    whisperIntervalSec(): number;
  };
  assert.equal(policy.isReady(), true);
  assert.equal(policy.canWhisper(), false);
  assert.equal(policy.whisperIntervalSec(), 300);
});
