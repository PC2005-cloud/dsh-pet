import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePrivateJson, readAiSettings } from './ai-storage.ts';
import { createStandaloneAi } from './ai-provider.ts';

test('private JSON writes atomically; rejects non-file destinations and cleans failed serialization', () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-storage-'));
  try {
    const path = join(home, 'private.json');
    writePrivateJson(path, { value: 1 });
    writePrivateJson(path, { value: 2 });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 2 });
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    mkdirSync(join(home, 'directory.json'));
    assert.throws(() => writePrivateJson(join(home, 'directory.json'), {}), /Unsafe/);
    assert.throws(() => writePrivateJson(join(home, 'missing', 'private.json'), {}));
    assert.throws(() => writePrivateJson(path, { fail: BigInt(1) }));
    assert.equal(readdirSync(home).filter((name) => name.endsWith('.tmp')).length, 0);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 2 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('oversize, non-file and invalid persisted settings fail closed with sanitized service logs', () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-storage-'));
  const messages: string[] = [];
  const logger = {
    info() {},
    warn() {},
    debug() {},
    error(message: string) {
      messages.push(message);
    },
  };
  try {
    assert.equal(readAiSettings(home), undefined);
    const path = join(home, 'dsh-pet', 'standalone-ai.json');
    writeFileSync(path, 'secret'.repeat(6000));
    assert.throws(() => createStandaloneAi(home, logger), /^Error: Cannot securely load standalone AI settings\.$/);
    rmSync(path);
    mkdirSync(path);
    assert.throws(() => readAiSettings(home), /Unsafe/);
    rmSync(path, { recursive: true });
    writePrivateJson(path, { protocol: 'bad-secret' });
    assert.throws(() => createStandaloneAi(home, logger), /Cannot securely load/);
    assert.equal(
      messages.some((message) => message.includes('secret')),
      false,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('persistence failure pauses a previously ready backend and never logs key material', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-storage-'));
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  const ai = createStandaloneAi(home, logger);
  try {
    await ai.saveSettings({ model: 'selected', baseUrl: 'https://example.test', apiKey: 'test-secret', enabled: true });
    const path = join(home, 'dsh-pet', 'standalone-ai.json');
    rmSync(path);
    mkdirSync(path);
    await assert.rejects(
      ai.saveSettings({ model: 'changed' }),
      /^Error: Cannot securely save standalone AI settings\.$/,
    );
    assert.equal(ai.isReady(), false);
    rmSync(path, { recursive: true });
    await ai.saveSettings({});
    assert.equal(ai.isReady(), true);
  } finally {
    ai.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
