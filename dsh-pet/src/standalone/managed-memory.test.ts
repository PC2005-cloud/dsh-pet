import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ManagedMemory, managedMemoryEnvironment, memoryModelsSchema } from './managed-memory.ts';
import { memoryToken, registerMemoryToken } from '../host/powercontext-auth.ts';

const models = {
  baseUrl: 'https://models.example/v1',
  model: 'chat',
  apiKey: 'chat-test-key',
  embeddingBaseUrl: 'https://vectors.example/v1',
  embeddingModel: 'vector',
  embeddingApiKey: 'embedding-test-key',
  embeddingDimension: 1024,
};

test('managed storage preserves endpoint identity and data, and does not expose credentials', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pet-memory-'));
  const first = new ManagedMemory(home);
  await first.configure(models);
  first.setEnabled(true);
  const url = first.url;
  const file = join(first.directory, 'settings.json');
  const original = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(join(first.directory, 'preserve-data'), 'saved memory');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(first.settings()).includes('test-key'));
  await first.dispose();
  const second = new ManagedMemory(home);
  t.after(async () => {
    await second.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(second.url, url);
  assert.equal(second.enabled, true);
  await second.configure({ ...models, apiKey: 'replacement-key' });
  assert.equal(second.url, url);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, original.token);
  assert.equal(readFileSync(join(second.directory, 'preserve-data'), 'utf8'), 'saved memory');
  assert.equal(second.enabled, false);
});

test('a second owner and embedding changes cannot overwrite the existing memory configuration', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pet-memory-owner-'));
  const first = new ManagedMemory(home);
  t.after(async () => {
    await first.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  await first.configure(models);
  const file = join(first.directory, 'settings.json');
  const before = readFileSync(file, 'utf8');
  const second = new ManagedMemory(home);
  await assert.rejects(second.configure(models), /memory_already_owned/);
  await second.dispose();
  await assert.rejects(first.configure({ ...models, embeddingModel: 'other' }), /embedding_change/);
  assert.equal(readFileSync(file, 'utf8'), before);
  first.setEnabled(true);
});

test('malformed persisted settings fail closed and remain intact', () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-memory-corrupt-'));
  try {
    const first = new ManagedMemory(home);
    const file = join(first.directory, 'settings.json');
    writeFileSync(file, '{', { mode: 0o600 });
    assert.throws(() => new ManagedMemory(home));
    assert.equal(readFileSync(file, 'utf8'), '{');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('model configuration rejects credential-bearing URLs, remote HTTP, controls and unknown fields', () => {
  for (const patch of [
    { baseUrl: 'http://remote.example/v1' },
    { baseUrl: 'https://user:pass@example.com/v1' },
    { apiKey: 'bad\nkey' },
    { embeddingDimension: 0 },
    { token: 'not-supported' },
  ])
    assert.equal(memoryModelsSchema.safeParse({ ...models, ...patch }).success, false);
});

test('managed authentication is endpoint scoped and preserves external token behavior', () => {
  const previous = process.env.DSH_PET_POWERCONTEXT_TOKEN;
  process.env.DSH_PET_POWERCONTEXT_TOKEN = 'external';
  const release = registerMemoryToken('http://127.0.0.1:18500', 'private');
  try {
    assert.equal(memoryToken('http://127.0.0.1:18500/'), 'private');
    assert.equal(memoryToken('https://example.com'), 'external');
    release();
    assert.equal(memoryToken('http://127.0.0.1:18500'), 'external');
  } finally {
    release();
    if (previous === undefined) delete process.env.DSH_PET_POWERCONTEXT_TOKEN;
    else process.env.DSH_PET_POWERCONTEXT_TOKEN = previous;
  }
});

test('runtime configuration enables only conversational extraction and scopes both model credentials', () => {
  const env = managedMemoryEnvironment('/private/runtime', {
    ...models,
    version: 1,
    enabled: true,
    token: 'local-token',
    port: 18500,
  });
  assert.equal(env.POWERCONTEXT_SERVER_AUTH_ENABLED, 'true');
  assert.equal(env.POWERCONTEXT_SERVER_INFERENCE_GENERATION_MODEL, 'openai-chat:chat');
  assert.equal(env.POWERCONTEXT_SERVER_HTTP_HOST, '127.0.0.1');
  assert.equal(env.POWERCONTEXT_SERVER_RUNTIME_MEMORY_EXTRACTION_PROFILE, 'conversation');
  assert.equal(env.POWERCONTEXT_SERVER_RUNTIME_ARTIFACT_PROCESSING_FAMILIES, '["memory"]');
  assert.equal(env.POWERCONTEXT_SERVER_RUNTIME_DREAM_ENABLED, 'false');
  assert.equal(
    JSON.parse(env.POWERCONTEXT_SERVER_INFERENCE_EMBEDDING_HEADERS!).Authorization,
    'Bearer embedding-test-key',
  );
});
