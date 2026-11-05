import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createServer } from 'node:http';
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
  const setup = createSetup(home, ai, {
    matches: async () => false,
    save: async () => {},
    checkpoint: async () => async () => {},
  });
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
    checkpoint: async () => async () => {},
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
  const setup = createSetup(home, ai, {
    matches: async () => false,
    save: async () => {},
    checkpoint: async () => async () => {},
  });
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

async function settled(setup: SetupService): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const status = setup.status() as Record<string, unknown>;
    if (!status.busy) return status;
    await delay(25);
  }
  throw new Error('setup did not settle');
}

const binding = { matches: async () => true, save: async () => {}, checkpoint: async () => async () => {} };

test('saved chat credentials can enable setup only at their original endpoint', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pet-setup-reuse-'));
  const seen: string[] = [];
  const ai = createStandaloneAi(home, silent, {
    fetch: async (_url, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  await ai.saveSettings({ baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey });
  const setup = createSetup(home, ai, binding);
  t.after(async () => {
    await setup.dispose();
    ai.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  setup.submit({ ...draft, apiKey: '' });
  assert.equal((await settled(setup)).stage, 'ready');
  assert.deepEqual(seen, ['Bearer synthetic-setup-key']);
  assert.throws(
    () => setup.submit({ ...draft, apiKey: '', baseUrl: 'https://another.example/v1' }),
    /chat_key_required/,
  );
  assert.equal(seen.length, 1);
  const status = setup.status() as { chat: { baseUrl: string; hasKey: boolean } };
  assert.equal(status.chat.baseUrl, draft.baseUrl);
  assert.equal(status.chat.hasKey, true);
  assert.ok(!JSON.stringify(status).includes(draft.apiKey));
});

/** A real process with controlled readiness, not a PowerContext implementation or extraction-quality test. */
function fakeInstalledRuntime(directory: string): void {
  const bin = join(directory, 'venv', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'python'),
    `#!${process.execPath}
if (process.argv[3]?.includes('importlib.metadata')) process.exit(0);
const http = require('node:http');
const server = http.createServer((_req, res) => {res.setHeader('content-type','application/json');res.end('{"status":"ready"}');});
server.listen(Number(process.env.POWERCONTEXT_SERVER_HTTP_PORT), '127.0.0.1');
process.stdin.resume(); process.stdin.on('end', () => server.close());
`,
    { mode: 0o700 },
  );
}

test(
  'a failed model change leaves the running memory service and saved settings intact',
  { skip: process.platform === 'win32' },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'pet-setup-preserve-'));
    const saved = new ManagedMemory(home);
    await saved.configure({
      baseUrl: draft.baseUrl,
      model: draft.model,
      apiKey: draft.apiKey,
      embeddingBaseUrl: draft.baseUrl,
      embeddingModel: 'vector',
      embeddingApiKey: draft.apiKey,
      embeddingDimension: 4,
    });
    fakeInstalledRuntime(saved.directory);
    saved.setEnabled(true);
    const url = saved.url!;
    const config = join(saved.directory, 'settings.json');
    const before = readFileSync(config, 'utf8');
    await saved.dispose();
    const ai = createStandaloneAi(home, silent, {
      fetch: async () => new Response('secret provider detail', { status: 401 }),
    });
    await ai.saveSettings({ baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey });
    const setup = createSetup(home, ai, binding);
    t.after(async () => {
      await setup.dispose();
      ai.dispose();
      rmSync(home, { recursive: true, force: true });
    });
    setup.resume();
    assert.equal((await settled(setup)).memoryReady, true);
    setup.submit({
      ...draft,
      memory: true,
      baseUrl: 'https://replacement.example/v1',
      embeddingBaseUrl: draft.baseUrl,
      embeddingModel: 'vector',
      embeddingDimension: 4,
      embeddingApiKey: '',
    });
    const status = await settled(setup);
    assert.equal(status.stage, 'error');
    assert.equal(status.memoryReady, true);
    assert.equal((await fetch(url + '/health/ready')).status, 200);
    assert.equal(readFileSync(config, 'utf8'), before);
    assert.equal(ai.getSettings().baseUrl, draft.baseUrl);
    assert.match(String(status.message), /密钥/);
    assert.ok(!JSON.stringify(status).includes('secret provider detail'));
    setup.submit({ action: 'stop' });
    const paused = await settled(setup);
    assert.equal(paused.memoryEnabled, false);
    assert.equal(paused.memoryRunning, false);
    assert.equal(paused.configured, true);
  },
);

test('cancelling a model check settles promptly and preserves the existing chat configuration', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pet-setup-cancel-'));
  let started!: () => void;
  const checking = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ai = createStandaloneAi(home, silent, {
    fetch: async (_url, init) => {
      started();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    },
  });
  await ai.saveSettings({ baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey });
  const setup = createSetup(home, ai, binding);
  t.after(async () => {
    await setup.dispose();
    ai.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  setup.submit({ ...draft, model: 'new-model' });
  await checking;
  setup.submit({ action: 'cancel' });
  const status = await settled(setup);
  assert.equal(status.stage, 'cancelled');
  assert.equal(status.chatReady, true);
  assert.equal(status.canRetry, true);
  assert.equal(ai.getSettings().model, draft.model);
});

for (const failure of ['activation', 'cancel'] as const)
  test(
    `a ${failure} failure restores the original managed process and configuration`,
    { skip: process.platform === 'win32' },
    async (t) => {
      const home = mkdtempSync(join(tmpdir(), 'pet-setup-rollback-'));
      const memory = new ManagedMemory(home);
      const models = {
        baseUrl: draft.baseUrl,
        model: draft.model,
        apiKey: draft.apiKey,
        embeddingBaseUrl: draft.baseUrl,
        embeddingModel: 'vector',
        embeddingApiKey: 'embedding-key',
        embeddingDimension: 4,
      };
      await memory.configure(models);
      fakeInstalledRuntime(memory.directory);
      memory.setEnabled(true);
      const signal = new AbortController();
      await memory.start(signal.signal, () => {});
      const url = memory.url!;
      const file = join(memory.directory, 'settings.json');
      const before = readFileSync(file, 'utf8');
      t.after(async () => {
        await memory.dispose();
        rmSync(home, { recursive: true, force: true });
      });
      let restoring = false;
      await assert.rejects(
        memory.replace(
          { ...models, model: 'replacement' },
          signal.signal,
          (stage) => {
            if (stage === 'restoring') restoring = true;
            if (failure === 'cancel' && stage === 'starting') signal.abort();
          },
          async () => {
            throw new Error('pet_settings_failed');
          },
          new AbortController().signal,
        ),
      );
      assert.equal(restoring, true);
      assert.equal(memory.running, true);
      assert.equal(memory.enabled, true);
      assert.equal(memory.url, url);
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.equal((await fetch(url + '/health/ready')).status, 200);
    },
  );

test(
  'a failed resume restores the paused binding and stops the new process',
  { skip: process.platform === 'win32' },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'pet-setup-resume-'));
    const memory = new ManagedMemory(home);
    await memory.configure({
      baseUrl: draft.baseUrl,
      model: draft.model,
      apiKey: draft.apiKey,
      embeddingBaseUrl: draft.baseUrl,
      embeddingModel: 'vector',
      embeddingApiKey: draft.apiKey,
      embeddingDimension: 4,
    });
    fakeInstalledRuntime(memory.directory);
    await memory.dispose();
    const ai = createStandaloneAi(home, silent);
    await ai.saveSettings({ baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey });
    let backend = 'native';
    const setup = createSetup(home, ai, {
      matches: async () => false,
      checkpoint: async () => async () => {
        backend = 'native';
      },
      save: async () => {
        backend = 'powercontext';
        throw new Error('pet_settings_failed');
      },
    });
    t.after(async () => {
      await setup.dispose();
      ai.dispose();
      rmSync(home, { recursive: true, force: true });
    });
    setup.submit({ action: 'retry' });
    const status = await settled(setup);
    assert.equal(status.stage, 'error');
    assert.equal(status.memoryEnabled, false);
    assert.equal(status.memoryRunning, false);
    assert.equal(status.canRetry, true);
    assert.equal(backend, 'native');
  },
);

for (const saveFails of [false, true])
  test(
    `enable memory reuses both saved keys and rolls back a failed binding: saveFails=${saveFails}`,
    { skip: process.platform === 'win32' },
    async (t) => {
      const home = mkdtempSync(join(tmpdir(), 'pet-setup-enable-'));
      const seen: string[] = [];
      const embedding = createServer((req, res) => {
        seen.push(req.headers.authorization ?? '');
        req.resume();
        res.setHeader('content-type', 'application/json');
        res.end('{"data":[{"embedding":[1,2,3,4]}]}');
      });
      await new Promise<void>((resolve) => embedding.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${(embedding.address() as { port: number }).port}/v1`;
      const saved = new ManagedMemory(home);
      await saved.configure({
        baseUrl: draft.baseUrl,
        model: draft.model,
        apiKey: draft.apiKey,
        embeddingBaseUrl: endpoint,
        embeddingModel: 'vector',
        embeddingApiKey: 'separate-embedding-key',
        embeddingDimension: 4,
      });
      fakeInstalledRuntime(saved.directory);
      await saved.dispose();
      const ai = createStandaloneAi(home, silent, {
        fetch: async (_url, init) => {
          seen.push(new Headers(init?.headers).get('authorization') ?? '');
          return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      });
      await ai.saveSettings({ baseUrl: draft.baseUrl, model: draft.model, apiKey: draft.apiKey });
      let backend = 'native';
      const setup = createSetup(home, ai, {
        matches: async () => false,
        checkpoint: async () => async () => {
          backend = 'native';
        },
        save: async () => {
          backend = 'powercontext';
          if (saveFails) throw new Error('pet_settings_failed');
        },
      });
      t.after(async () => {
        await setup.dispose();
        ai.dispose();
        await new Promise<void>((resolve) => embedding.close(() => resolve()));
        rmSync(home, { recursive: true, force: true });
      });
      setup.submit({
        ...draft,
        memory: true,
        apiKey: '',
        model: 'new-chat-model',
        embeddingBaseUrl: endpoint,
        embeddingModel: 'vector',
        embeddingDimension: 4,
        embeddingApiKey: '',
      });
      const status = await settled(setup);
      assert.deepEqual(seen, ['Bearer synthetic-setup-key', 'Bearer separate-embedding-key']);
      assert.equal(status.stage, saveFails ? 'error' : 'ready');
      assert.equal(status.memoryReady, !saveFails);
      assert.equal(status.memoryEnabled, !saveFails);
      assert.equal(status.memoryRunning, !saveFails);
      assert.equal(backend, saveFails ? 'native' : 'powercontext');
      assert.equal(ai.getSettings().model, saveFails ? draft.model : 'new-chat-model');
      assert.ok(!JSON.stringify(status).includes('separate-embedding-key'));
    },
  );
