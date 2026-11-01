/**
 * cookie 计数的单元测试 —— 钉住「按名字去重」与「不够长就不算」。
 *
 * 计数错的后果不是崩，而是**虚报**：把同一条 cookie 的多个版本当成多条，用户会去删一份本来
 * 还没到上限的库。所以这里只用合成的库字节，不碰真实的 Chromium 文件。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { countCookieNames } from './probe.ts';

/** 造一个名字合法的登录 cookie：43 位 base64url 摘要。 */
const nameOf = (seed: string): string => 'dsh-auth-' + seed.padEnd(43, 'A').slice(0, 43);

describe('countCookieNames —— 从库字节里数不同的 cookie 名', () => {
  test('空库 → 0', () => {
    assert.equal(countCookieNames(Buffer.alloc(0)), 0);
  });

  test('同一个名字出现多次（多个版本）只算一条', () => {
    const name = nameOf('dup');
    const raw = Buffer.from(`x${name}\u0000${name}\u0000${name}\u0000`, 'latin1');
    assert.equal(countCookieNames(raw), 1);
  });

  test('两个不同名字 → 2', () => {
    const raw = Buffer.from(`${nameOf('one')}\u0000${nameOf('two')}\u0000`, 'latin1');
    assert.equal(countCookieNames(raw), 2);
  });

  test('长度不足 43 位（写坏的残片）不算一条', () => {
    const raw = Buffer.from('dsh-auth-' + 'A'.repeat(42), 'latin1');
    assert.equal(countCookieNames(raw), 0);
  });

  test('别的 cookie 名（前缀不对）不算', () => {
    const raw = Buffer.from('session-' + 'B'.repeat(43), 'latin1');
    assert.equal(countCookieNames(raw), 0);
  });

  test('二进制垃圾不抛异常，只回 0', () => {
    const raw = Buffer.from([0xff, 0x00, 0x7f, 0x13, 0x37]);
    assert.equal(countCookieNames(raw), 0);
  });
});
