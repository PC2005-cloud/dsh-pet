import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSpeech, ttsCommand } from './voice.ts';

describe('cleanSpeech —— 只念口语', () => {
  it('去掉代码块、行内代码、链接与配图标记', () => {
    const input = '看这个 `code` 和 ![图](x.png) https://example.com [图:吃白饭] 好';
    assert.equal(cleanSpeech(input), '看这个 和 好');
  });

  it('压缩空白并去掉首尾空白', () => {
    assert.equal(cleanSpeech('  你好   呀\n\n'), '你好 呀');
  });

  it('超过上限截断到 200 字', () => {
    const out = cleanSpeech('哼'.repeat(500));
    assert.equal(out.length, 200);
    assert.ok(out.startsWith('哼哼'));
  });

  it('空值与纯空白 → 空串（调用方据此跳过播报）', () => {
    assert.equal(cleanSpeech(undefined), '');
    assert.equal(cleanSpeech('   '), '');
  });
});

describe('ttsCommand —— 平台分支', () => {
  it('macOS 用系统 say', () => {
    assert.deepEqual(ttsCommand('darwin'), ['say']);
  });

  it('其他平台暂不播报', () => {
    assert.equal(ttsCommand('linux'), undefined);
    assert.equal(ttsCommand('win32'), undefined);
  });
});
