/**
 * 固定文案目录的契约：键集一致、占位符一致、俄文里没有汉字。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { labelRu, labelZh } from './actions.ts';
import { chromeRu, chromeZh } from './chrome.ts';
import { textFrameRel, TEXT_FRAME_IDS } from './text-frames.ts';

const cjk = /[\u4e00-\u9fff]/;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('固定文案目录', () => {
  test('俄文键集与中文一致，占位符一致，俄文没有汉字', () => {
    const zhKeys = Object.keys(chromeZh).sort();
    assert.deepEqual(Object.keys(chromeRu).sort(), zhKeys);
    for (const key of zhKeys) {
      const zh = chromeZh[key as keyof typeof chromeZh];
      const ru = chromeRu[key as keyof typeof chromeRu];
      assert.deepEqual(placeholders(ru), placeholders(zh), key);
      assert.equal(cjk.test(ru), false, key + ': ' + ru);
      assert.ok(ru.trim().length > 0, key);
    }
  });

  test('动作与表情包标题的键集一致，俄文没有汉字', () => {
    assert.deepEqual(Object.keys(labelRu).sort(), Object.keys(labelZh).sort());
    for (const [key, value] of Object.entries(labelRu)) {
      assert.equal(labelZh[key], key, '中文标题就是 id');
      assert.equal(cjk.test(value), false, key + ': ' + value);
    }
  });

  test('俄语地址只为有字的名单、且只在 ru', () => {
    assert.equal(textFrameRel('ru', '是啊，吃什么'), 'ru/是啊，吃什么');
    assert.equal(textFrameRel('en', '是啊，吃什么'), '是啊，吃什么');
    assert.equal(textFrameRel(undefined, '是啊，吃什么'), '是啊，吃什么');
    assert.equal(textFrameRel('ru', '吃白饭'), '吃白饭');
    assert.equal(textFrameRel('ru', '吃白饭的大肥鱼'), 'ru/吃白饭的大肥鱼');
    assert.equal(textFrameRel('ru', '写福字'), 'ru/写福字');
    assert.equal(textFrameRel('en', '写福字'), '写福字');
    assert.equal(TEXT_FRAME_IDS.has('可爱'), false);
    assert.equal(TEXT_FRAME_IDS.has('待机呼吸休闲'), false);
    assert.equal(TEXT_FRAME_IDS.has('Zzz'), false);
  });
});
