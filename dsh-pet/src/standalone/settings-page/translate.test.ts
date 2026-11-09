/**
 * 独立模式设置页翻译：键查找、占位符替换、缺参数回落空串。
 *
 * 跑法：node --experimental-strip-types --test src/standalone/settings-page/translate.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createTranslator } from './translate.ts';

/** 只含测试用键的最小字典，不依赖面板完整键集。 */
const dict = {
  greeting: '你好，{name}',
  pair: '{pets} 只宠物，{messages} 条消息',
  plain: '纯文本',
};

describe('createTranslator —— 独立页文案翻译', () => {
  test('不带参数 → 原样返回字典文案', () => {
    const t = createTranslator(dict);
    assert.equal(t('plain'), '纯文本');
  });

  test('带参数 → 替换全部 `{name}` 占位符', () => {
    const t = createTranslator(dict);
    assert.equal(t('pair', { pets: 2, messages: 7 }), '2 只宠物，7 条消息');
  });

  test('参数缺失 → 该占位符替换为空串，不残留原文', () => {
    const t = createTranslator(dict);
    assert.equal(t('greeting', {}), '你好，');
  });
});
