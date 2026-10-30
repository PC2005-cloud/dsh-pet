/**
 * 设置页字典（src/client/settings/locales/）的契约测试。
 *
 * 三条契约：每种语言的键集与 zh 完全一致（多键少键在类型期就该报错，这里再用运行时兜一次）；
 * `{n}` / `{id}` / `{profile}` 这类插值占位符必须与中文一一对应，否则翻译后 UI 会直接印出原文占位符；
 * 拉丁 / 西里尔字母语言里不得残留汉字（漏翻的痕迹），也不许有空白的值（空标签在设置页里就是一处看不见的洞）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { dicts, zh } from './index.ts';

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// 只查汉字本身：非中文文案里出现「」这类全角引号是排版习惯，出现汉字才是漏翻。
// 汉字本身不判定漏翻：日语用汉字书写，只有拉丁字母 / 西里尔字母的语言才拿它当漏翻信号。
const cjk = /[\u4e00-\u9fff]/;

/** 允许出现汉字的语言：中文，以及日语。 */
const HAN_LANGUAGES = new Set(['zh', 'ja']);

/** 语言 id 与它的字典；`Record<Key, string>` 已由类型保证，这里再按同一形状遍历。 */
const pairs = Object.entries(dicts) as Array<[string, Record<keyof typeof zh, string>]>;

describe('设置页字典', () => {
  test('每种语言的键集都与 zh 一致', () => {
    const zhKeys = Object.keys(zh).sort();
    for (const [language, dict] of pairs) {
      assert.deepEqual(Object.keys(dict).sort(), zhKeys, `${language} 的键集与 zh 不一致`);
    }
  });

  test('插值占位符一致：每个键的占位符集合与中文相同', () => {
    for (const [language, dict] of pairs) {
      for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
        assert.deepEqual(
          placeholders(dict[key]),
          placeholders(zh[key]),
          `${language}.${key} 的占位符与中文不一致：插值会失败，UI 里会印出原文占位符`,
        );
      }
    }
  });

  test('文案可用：都不是空白，拉丁 / 西里尔字母语言里没有汉字', () => {
    for (const [language, dict] of pairs) {
      for (const [key, value] of Object.entries(dict)) {
        assert.ok(value.trim().length > 0, `${language}.${key} 是空白`);
        if (HAN_LANGUAGES.has(language)) continue;
        assert.ok(!cjk.test(value), `${language}.${key} 里还有中文没翻：${value}`);
      }
    }
  });
});
