/**
 * 本机会话用量解析测试。
 * 跑法：node --experimental-strip-types --test src/host/local-usage.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatTok, parseSessionTokenTotals, readSessionUsage } from './local-usage.ts';

describe('formatTok', () => {
  test('量级收成短标签', () => {
    assert.equal(formatTok(0), '0');
    assert.equal(formatTok(999), '999');
    assert.equal(formatTok(1200), '1.2k');
    assert.equal(formatTok(12_000), '12k');
    assert.equal(formatTok(1_200_000), '1.2M');
  });
});

describe('parseSessionTokenTotals', () => {
  test('读 DSH session_projcache 的 totals', () => {
    assert.deepEqual(
      parseSessionTokenTotals({
        record: {
          rows: {
            tokenUsage: {
              val: { totals: { uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 40 } },
            },
          },
        },
      }),
      { input: 10, output: 3, cache: 40 },
    );
  });

  test('缺字段 / 非法 → null', () => {
    assert.equal(parseSessionTokenTotals(null), null);
    assert.equal(parseSessionTokenTotals({}), null);
    assert.equal(
      parseSessionTokenTotals({
        record: { rows: { tokenUsage: { val: { totals: { uncachedInputTokens: 'x' } } } } },
      }),
      null,
    );
  });
});

describe('readSessionUsage', () => {
  test('按 session-<id>.json 读出气泡文案', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-pet-usage-'));
    const dir = join(home, 'storages', 'session_projcache', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'session-abc.json'),
      JSON.stringify({
        record: {
          rows: {
            tokenUsage: {
              val: { totals: { uncachedInputTokens: 2400, outputTokens: 100, cacheReadTokens: 0 } },
            },
          },
        },
      }),
    );
    const hit = readSessionUsage(home, 'abc');
    assert.equal(hit?.text, '用量 入2.4k 出100');
    assert.equal(hit?.sessionId, 'abc');
  });

  test('unknown / 缺文件 → null', () => {
    assert.equal(readSessionUsage('/no-such-home', 'unknown'), null);
    assert.equal(readSessionUsage('/no-such-home', 'missing'), null);
  });
});
