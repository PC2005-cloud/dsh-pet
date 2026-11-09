/**
 * 宠物 UI 字典（src/client/ui/locales）的契约测试。
 *
 * 三条契约：每种语言的键集与 zh 完全一致；`{n}` / `{name}` 这类插值占位符必须与中文一一对应；
 * 拉丁 / 西里尔字母语言里不得残留汉字，也不许有空白的值。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { dicts, zh } from './index.ts';
import { ru } from '../../../shared/ui/locales/ru.ts';
import { setUiTranslate, uiT } from '../../../shared/ui/i18n.ts';
import { dueLabel } from '../../../shared/todo/format.ts';

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** 只查汉字本身：非中文文案里出现「」这类全角引号是排版习惯，出现汉字才是漏翻。 */
const cjk = /[\u4e00-\u9fff]/;

/** 语言 id 与它的字典；`Record<Key, string>` 已由类型保证，这里再按同一形状遍历。 */
const pairs = Object.entries(dicts) as Array<[string, Record<keyof typeof zh, string>]>;

describe('宠物 UI 字典', () => {
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

  test('文案可用：都不是空白，英文 / 俄文里没有汉字', () => {
    for (const [language, dict] of pairs) {
      for (const [key, value] of Object.entries(dict)) {
        assert.ok(value.trim().length > 0, `${language}.${key} 是空白`);
        if (language === 'zh') continue;
        assert.ok(!cjk.test(value), `${language}.${key} 里还有中文没翻：${value}`);
      }
    }
  });

  test('取词入口：未注入时回落中文，注入后走注入函数并保留插值', () => {
    setUiTranslate(null);
    assert.equal(uiT('menu.more'), '更多');
    assert.equal(uiT('todo.count', { n: 3 }), '3 项未完成');
    setUiTranslate((key, params) => `${key}:${params?.n ?? ''}`);
    assert.equal(uiT('todo.count', { n: 3 }), 'todo.count:3');
    setUiTranslate(null);
  });

  test('注入俄语后，共享模块的文案立即切换（含动态键与插值）', () => {
    // 模拟 locale.bind 的行为：先把 {name} 占位符按参数补齐，再交给调用方。
    const ruT = (key: keyof typeof ru, params?: Record<string, string | number>): string =>
      Object.entries(params ?? {}).reduce(
        (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
        ru[key],
      );
    setUiTranslate(ruT);
    try {
      assert.equal(uiT('menu.more'), 'Ещё');
      assert.equal(uiT('todo.count', { n: 3 }), '3 невыполнено');
      assert.equal(
        dueLabel(new Date(2026, 9, 29, 18, 0).getTime(), new Date(2026, 9, 29, 9, 0).getTime()),
        'Сегодня 18:00',
      );
    } finally {
      setUiTranslate(null);
    }
  });
});
