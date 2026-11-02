import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { createStandaloneContext } from '../standalone/context.ts';
import { listenStandaloneServer, type StandaloneServer } from '../standalone/server.ts';
import { createRequestSecurity } from '../standalone/request-security.ts';
import { readUserConfig } from './config.ts';

// 把真实 host 打包进临时包，让它的 assets 能解析，同时不改动 src/assets。
const source = fileURLToPath(new URL('..', import.meta.url));
const pet = (id: string) => ({
  id,
  name: id,
  size: 240,
  display: 'web',
  balanceEnabled: false,
  whisperEnabled: false,
  workStatusEnabled: false,
  position: { corner: 'top-right', marginX: 20, marginY: 20 },
});
let dir = '';
let file = '';
let packFile = '';
let base = '';
let token = '';
let context: ReturnType<typeof createStandaloneContext>;
let server: StandaloneServer;
const previousHome = process.env.DSH_HOME;
const previousInProcess = process.env.DSH_PET_IN_PROCESS;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-config-concurrency-'));
  const pkg = join(dir, 'package');
  mkdirSync(join(pkg, 'assets'), { recursive: true });
  copyFileSync(new URL('../../assets/config.jsonc', import.meta.url), join(pkg, 'assets/config.jsonc'));
  const aliases = Object.fromEntries(
    ['dsh-home-paths', 'dsh-credentials', 'dsh-llm'].map((name) => [
      '@deepseek-ai/' + name,
      join(source, 'standalone/shims', name + '.ts'),
    ]),
  );
  const bundle = await rolldown({
    input: join(source, 'host/index.ts'),
    platform: 'node',
    external: (id) =>
      id.startsWith('node:') ||
      (id.startsWith('@deepseek-ai/') && !(id in aliases)) ||
      ['zod', '@electron/get', '@electron-internal/extract-zip', '@andresaya/edge-tts'].includes(id),
    plugins: [{ name: 'standalone-test-shims', resolveId: (id) => aliases[id] }],
  });
  const entry = join(pkg, 'lib/host.mjs');
  await bundle.write({ format: 'esm', file: entry });
  await bundle.close();
  const home = join(dir, 'home');
  process.env.DSH_HOME = home;
  process.env.DSH_PET_IN_PROCESS = '1';
  mkdirSync(join(home, 'dsh-pet/pet'), { recursive: true });
  file = join(home, 'dsh-pet/main-config.jsonc');
  packFile = join(home, 'dsh-pet/pet/pack-config.jsonc');
  writeFileSync(file, JSON.stringify({ trayEnabled: false, pets: [pet('alpha'), pet('beta')] }));
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  context = createStandaloneContext({ port: 0, logger });
  const { apply } = await import(pathToFileURL(entry).href);
  apply(context.ctx);
  assert.deepEqual(context.failures, []);
  const security = createRequestSecurity();
  token = security.token;
  server = await listenStandaloneServer({ routes: context.routes, logger, port: 0, security });
  base = `http://127.0.0.1:${server.port}/dsh-pet-7340/`;
});

beforeEach(() => {
  writeFileSync(
    file,
    JSON.stringify({ trayEnabled: false, notificationsEnabled: true, pets: [pet('alpha'), pet('beta')] }),
  );
  rmSync(packFile, { force: true });
});

after(async () => {
  await server?.close();
  await context?.dispose();
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  if (previousInProcess === undefined) delete process.env.DSH_PET_IN_PROCESS;
  else process.env.DSH_PET_IN_PROCESS = previousInProcess;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { 'X-DSH-Pet-Token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as { main?: { pets: Array<{ id: string }> }; pack?: unknown },
  };
}

const read = (path = file) => {
  const value = readUserConfig({ userFile: path, defaultFile: '', petDir: '' });
  assert.ok(value, 'the saved config must remain readable');
  return value as { pets: ReturnType<typeof pet>[]; [key: string]: unknown };
};
const displays = (value: { pets: Array<{ id: string; display: string }> }) =>
  Object.fromEntries(value.pets.map((p) => [p.id, p.display]));

test('concurrent display changes preserve both main pets', async () => {
  const results = await Promise.all([
    request('pet-display', 'POST', { id: 'alpha', display: 'none' }),
    request('pet-display', 'POST', { id: 'beta', display: 'both' }),
  ]);
  assert.ok(results.every((r) => r.status === 200 && r.body.main));
  assert.deepEqual(displays(read()), { alpha: 'none', beta: 'both' });
});

test('concurrent display changes preserve both pack pets and custom fields', async () => {
  writeFileSync(packFile, JSON.stringify({ pets: [pet('pack-a'), pet('pack-b')], whisperPrompt: 'keep this persona' }));
  const results = await Promise.all([
    request('pet-display', 'POST', { id: 'pack-a', display: 'none' }),
    request('pet-display', 'POST', { id: 'pack-b', display: 'both' }),
  ]);
  assert.ok(results.every((r) => r.status === 200 && r.body.pack));
  assert.deepEqual(displays(read(packFile)), { 'pack-a': 'none', 'pack-b': 'both' });
  assert.equal(read(packFile).whisperPrompt, 'keep this persona');
  assert.deepEqual(displays(read()), { alpha: 'web', beta: 'web' });
});

test('concurrent pack write and settings save do not overwrite each other', async () => {
  writeFileSync(packFile, JSON.stringify({ pets: [pet('pack-a')], whisperPrompt: 'keep this persona' }));
  const results = await Promise.all([
    request('config', 'PUT', { pets: [pet('alpha'), pet('beta')], notificationsEnabled: false }),
    request('pet-config', 'POST', { entry: 'pack', pets: [pet('pack-a'), pet('pack-b')] }),
  ]);
  assert.ok(
    results.every((r) => r.status === 200 && r.body.main),
    '两条写端点都要成功，且响应都是成品聚合',
  );
  assert.deepEqual(
    read().pets.map((p: { id: string }) => p.id),
    ['alpha', 'beta'],
    '设置页保存的 main 实例不得被种类写回覆盖',
  );
  assert.equal(read().notificationsEnabled, false, '全局字段不得被种类写回覆盖');
  assert.deepEqual(
    read(packFile).pets.map((p: { id: string }) => p.id),
    ['pack-a', 'pack-b'],
    '种类写回的结果不得被设置页保存覆盖',
  );
  assert.equal(read(packFile).whisperPrompt, 'keep this persona', '条目人设要保留');
});

test('display changes cannot undo a concurrent settings save', async () => {
  const results = await Promise.all([
    request('config', 'PUT', { pets: [pet('alpha'), pet('beta')], notificationsEnabled: false }),
    request('pet-display', 'POST', { id: 'alpha', display: 'none' }),
  ]);
  assert.ok(results.every((r) => r.status === 200 && r.body.main));
  assert.equal(read().notificationsEnabled, false);
});

test('restoring defaults cannot be undone by a concurrent display change', async () => {
  writeFileSync(
    file,
    JSON.stringify({ trayEnabled: false, pets: [pet('main'), pet('extra')], note: 'remove on reset' }),
  );
  const results = await Promise.all([
    request('pet-display', 'POST', { id: 'main', display: 'none' }),
    request('config', 'POST'),
  ]);
  assert.ok(results.every((r) => r.status === 200 && r.body.main));
  assert.equal(read().note, undefined);
  assert.deepEqual(
    read().pets.map((p: { id: string }) => p.id),
    ['main'],
  );
});

test('config reads do not observe an incomplete concurrent save', async () => {
  const results = await Promise.all([
    request('config', 'PUT', { pets: [pet('alpha'), pet('beta')] }),
    ...Array.from({ length: 8 }, () => request('config')),
  ]);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.ok(result.body.main);
    assert.deepEqual(
      result.body.main.pets.map((p: { id: string }) => p.id),
      ['alpha', 'beta'],
    );
  }
});

test('a rejected config operation does not prevent later updates', async () => {
  const invalid = await request('pet-display', 'POST', null);
  assert.equal(invalid.status, 500);
  const valid = await request('pet-display', 'POST', { id: 'alpha', display: 'none' });
  assert.equal(valid.status, 200);
  assert.equal(read().pets[0].display, 'none');
});
