/**
 * 回复语言白名单与提示词行的行为测试（src/shared/reply-language.ts）。
 *
 * 这份清单同时供三处消费：宿主拼 system 提示词、Breeze 的 language_code、两套设置页的下拉。
 * 任何一处少一项都会让「设置页能选但念不出来」，所以这里连标签覆盖一起钉住。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPLY_LANGUAGES, REPLY_LANGUAGE_LABELS, normalizeReplyLanguage, replyLanguageLine } from './reply-language.ts';

test('normalizeReplyLanguage —— 大小写与首尾空白都归一', () => {
  assert.equal(normalizeReplyLanguage('zh'), 'zh');
  assert.equal(normalizeReplyLanguage('EN'), 'en');
  assert.equal(normalizeReplyLanguage('  Ja  '), 'ja');
});

test('normalizeReplyLanguage —— 空串是合法值（跟随用户）', () => {
  assert.equal(normalizeReplyLanguage(''), '');
  assert.equal(normalizeReplyLanguage('   '), '');
});

test('normalizeReplyLanguage —— 非法值与非字符串返回 undefined', () => {
  for (const value of ['xx', 'zh-CN', 'english', 42, null, undefined, {}, []]) {
    assert.equal(normalizeReplyLanguage(value), undefined, `${JSON.stringify(value)} 应判非法`);
  }
});

test('REPLY_LANGUAGE_LABELS —— 每个可选语言都有自称（设置页与提示词共用）', () => {
  for (const id of REPLY_LANGUAGES) {
    assert.equal(typeof REPLY_LANGUAGE_LABELS[id], 'string');
    assert.ok(REPLY_LANGUAGE_LABELS[id].length > 0, `${id} 缺标签`);
  }
});

test('replyLanguageLine —— 跟随用户时不加任何一段', () => {
  assert.equal(replyLanguageLine(''), '');
  assert.equal(replyLanguageLine(undefined), '');
  assert.equal(replyLanguageLine('xx'), '', '非法值当没写');
});

test('replyLanguageLine —— 指定语言时明确要求不跟随主人换语言', () => {
  const line = replyLanguageLine('en');
  assert.ok(line.startsWith('【语言】'), '段落前缀固定，便于 prompt 里定位');
  assert.match(line, /英语/);
  assert.match(line, /English/, '目标语言的自称要带上，模型两种写法都认');
  assert.match(line, /换用别的语言/, '必须写明不跟随主人切换');
  assert.equal(line.includes('\n'), false, '必须是一行');
});
