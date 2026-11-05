/**
 * 碎碎念用户指令：只有 ru 换成俄语，缺省保持原来的中文短句。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sleepTalkText, whisperUserText } from './whisper.ts';

test('缺省语言仍是中文短句', () => {
  assert.equal(whisperUserText(undefined).includes('20 字以内'), true);
  assert.equal(sleepTalkText('en').includes('梦话'), true);
});

test('ru：碎碎念和梦话指令没有中文，配图名原样保留', () => {
  const plain = whisperUserText('ru');
  const withMeme = whisperUserText('ru', { name: '大烧货', desc: 'Пустой взгляд' });
  const sleep = sleepTalkText('ru');
  assert.equal(/[\u4e00-\u9fff]/.test(plain), false);
  assert.equal(/[\u4e00-\u9fff]/.test(sleep), false);
  assert.equal(/[\u4e00-\u9fff]/.test(withMeme.replace('大烧货', '')), false);
  assert.ok(withMeme.includes('大烧货'));
});
