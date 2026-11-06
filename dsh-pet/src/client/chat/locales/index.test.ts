/**
 * 对话面板字典的契约测试：8 种语言键集一致、每条非空、英文回退基准存在。
 *
 * 只钉结构，不钉具体文案——翻译措辞会变，键集与完整性不会。
 * 跑法：node --experimental-strip-types --test src/client/chat/locales/index.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { dicts, NS, zh } from './index.ts';

describe('对话面板字典 —— 键集与完整性', () => {
  test('命名空间固定为 pet.chat', () => {
    assert.equal(NS, 'pet.chat');
  });

  test('8 种语言齐全：zh / en / ja / es / fr / de / ru / pt', () => {
    assert.deepEqual(Object.keys(dicts), ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']);
  });

  test('每种语言的键集与 zh 完全一致 → 漏翻或多余键都会被发现', () => {
    const baseline = Object.keys(zh).sort();
    for (const [id, dict] of Object.entries(dicts)) {
      assert.deepEqual(Object.keys(dict).sort(), baseline, `${id} 的键集应与 zh 一致`);
    }
  });

  test('每条文案都是非空字符串 → 不留空占位', () => {
    for (const [id, dict] of Object.entries(dicts)) {
      for (const [key, value] of Object.entries(dict)) {
        assert.equal(typeof value, 'string', `${id}.${key} 应是字符串`);
        assert.notEqual(value.trim(), '', `${id}.${key} 不应为空`);
      }
    }
  });

  test('占位符不被翻译改写 → 参数键在 8 种语言里保持同名', () => {
    const placeholders = (value: string): string[] => (value.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
    for (const [key, value] of Object.entries(zh)) {
      const expected = placeholders(value);
      for (const [id, dict] of Object.entries(dicts)) {
        assert.deepEqual(placeholders(dict[key as keyof typeof dict]), expected, `${id}.${key} 的占位符应与 zh 一致`);
      }
    }
  });
});
