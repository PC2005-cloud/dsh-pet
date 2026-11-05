import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hydrateHostLocale, readCachedHostLocale, writeCachedHostLocale } from './locale-cache.ts';
import { PollStateStore } from './state.ts';

test('host locale cache round-trip and hydrate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-locale-'));
  try {
    assert.equal(readCachedHostLocale(dir), '');
    writeCachedHostLocale(dir, 'ru');
    assert.equal(readCachedHostLocale(dir), 'ru');
    assert.equal(JSON.parse(readFileSync(join(dir, 'host-locale.json'), 'utf8')).id, 'ru');
    const state = new PollStateStore();
    hydrateHostLocale(state, dir);
    assert.equal((state.read().sections.locale.data as { id: string }).id, 'ru');
    writeCachedHostLocale(dir, 'bad id');
    assert.equal(readCachedHostLocale(dir), 'ru');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
