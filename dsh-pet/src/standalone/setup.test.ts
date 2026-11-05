import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { startRouter } from '../app/router.ts';
import { createStandaloneAi } from './ai-provider.ts';
import { createRequestSecurity } from './request-security.ts';
import { listenStandaloneServer } from './server.ts';
import { createSetup, type SetupService } from './setup.ts';
import { ManagedMemory } from './managed-memory.ts';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const draft = {
  action: 'start',
  memory: false,
  baseUrl: 'https://models.example/v1',
  model: 'fixture',
  apiKey: 'synthetic-setup-key',
};

test('incompatible embedding changes are rejected before replacing a working chat configuration', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pet-setup-embedding-'));
  const memory = new ManagedMemory(home);
  await memory.configure({
    baseUrl: draft.baseUrl,
    model: draft.model,
    apiKey: draft.apiKey,
    embeddingBaseUrl: draft.baseUrl,
    embeddingModel: 'original',
    embeddingApiKey: draft.apiKey,
    embeddingDimension: 4,
  });
  await memory.dispose();
  let calls = 0;
  const ai = createStandaloneAi(home, silent, {
    fetch: async () => {
      calls++;
      throw new Error('must not contact provider');
    },
  });
  await ai.saveSettings({ baseUrl: draft.baseUrl, model: 'working', apiKey: 'working-key' });
  const setup = createSetup(home, ai, { matches: async () => false, save: async () => {} });
  t.after(async () => {
    await setup.dispose();
    ai.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  assert.throws(
    () =>
      setup.submit({
        ...draft,
        memory: true,
        embeddingBaseUrl: draft.baseUrl,
        embeddingModel: 'different',
        embeddingApiKey: draft.apiKey,
        embeddingDimension: 4,
      }),
    /embedding_change_requires_new_store/,
  );
  assert.equal(ai.getSettings().model, 'working');
  assert.equal(calls, 0);
  assert.equal((setup.status() as { busy: boolean }).busy, false);
});

test('chat-only onboarding checks and saves the model without installing or enabling memory', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pet-setup-'));
  let requests = 0;
  const ai = createStandaloneAi(home, silent, {
    fetch: async () => {
      requests += 1;
      return new Response(
        'data: {"id":"test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const setup = createSetup(home, ai, {
    matches: async () => false,
    save: async () => {
      throw new Error('memory must stay disabled');
    },
  });
  t.after(async () => {
    await setup.dispose();
    ai.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(requests, 0);
  assert.equal((setup.status() as { chatReady: boolean }).chatReady, false);
  setup.submit(draft);
  assert.throws(() => setup.submit(draft), /setup_busy/);
  for (let i = 0; i < 100 && (setup.status() as { busy: boolean }).busy; i++) await delay(20);
  const status = setup.status() as { stage: string; memoryReady: boolean; configured: boolean };
  assert.equal(status.stage, 'ready');
  assert.equal(status.memoryReady, false);
  assert.equal(status.configured, false);
  assert.equal(requests, 1);
  assert.equal(ai.getSettings().model, 'fixture');
  assert.equal(ai.getSettings().hasKey, true);
  assert.ok(!JSON.stringify(status).includes(draft.apiKey));
});

test('a failed connection preserves previous chat settings and redacts provider failures', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pet-setup-failure-'));
  const ai = createStandaloneAi(home, silent, {
    fetch: async () => new Response('synthetic-setup-key provider secret', { status: 401 }),
  });
  await ai.saveSettings({ baseUrl: 'https://old.example/v1', model: 'old', apiKey: 'old-key' });
  const before = readFileSync(join(home, 'dsh-pet/standalone-ai.json'), 'utf8');
  const setup = createSetup(home, ai, { matches: async () => false, save: async () => {} });
  t.after(async () => {
    await setup.dispose();
    ai.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  assert.throws(() => setup.submit({ ...draft, unexpected: 'field' }), /invalid_setup/);
  setup.submit(draft);
  for (let i = 0; i < 100 && (setup.status() as { busy: boolean }).busy; i++) await delay(20);
  assert.equal((setup.status() as { stage: string }).stage, 'error');
  assert.equal(readFileSync(join(home, 'dsh-pet/standalone-ai.json'), 'utf8'), before);
  assert.ok(!JSON.stringify(setup.status()).includes(draft.apiKey));
});

for (const host of ['standalone', 'app'] as const)
  test(`${host} setup requires a local capability, validates media type and reports asynchronous work`, async () => {
    const security = createRequestSecurity();
    let submitted = 0;
    const setup: SetupService = {
      status: () => ({ stage: 'idle', busy: false }),
      submit: () => {
        submitted++;
      },
      resume() {},
      async dispose() {},
    };
    const server =
      host === 'standalone'
        ? await listenStandaloneServer({ routes: [], port: 0, logger: silent, security, setup })
        : await startRouter([], { security, setup, log() {}, status: () => ({}), landingPage: () => '' });
    const url = `http://127.0.0.1:${server.port}/standalone-ai/setup`;
    const auth = { 'X-DSH-Pet-Token': security.token, 'Content-Type': 'application/json' };
    try {
      assert.equal((await fetch(url)).status, 403);
      assert.equal(
        (
          await fetch(url, {
            method: 'POST',
            headers: { ...auth, Origin: 'https://evil.example' },
            body: JSON.stringify(draft),
          })
        ).status,
        403,
      );
      assert.equal(submitted, 0);
      assert.equal(
        (await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' })).status,
        415,
      );
      assert.equal((await fetch(url, { method: 'PUT', headers: auth, body: '{}' })).status, 405);
      assert.equal((await fetch(url, { headers: auth })).status, 200);
      const response = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify(draft) });
      assert.equal(response.status, 202);
      assert.ok(!(await response.text()).includes(draft.apiKey));
      assert.equal(submitted, 1);
    } finally {
      await server.close();
    }
  });
