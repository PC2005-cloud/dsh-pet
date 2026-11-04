/**
 * restart 纯函数测试：钉住「空白输出不算进程跑起来」的判定（#286）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { helperOutputIsMeaningful } from './restart.ts';

describe('helperOutputIsMeaningful —— 空白输出不算「进程真的跑起来了」', () => {
  test('纯空白（Electron abort 前写的 \\r\\n）→ 不算输出', () => {
    assert.equal(helperOutputIsMeaningful('\r\n'), false);
  });

  test('只有空格与制表符 → 不算输出', () => {
    assert.equal(helperOutputIsMeaningful(' \t '), false);
  });

  test('有实际内容 → 算输出', () => {
    assert.equal(helperOutputIsMeaningful('[dsh-pet] helper booted'), true);
  });
});
