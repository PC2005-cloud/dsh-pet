/**
 * 包内默认文案只在整段一致、且宿主语言是 ru 时换成俄文。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PACKAGED_MEME_DESC,
  PACKAGED_WORK_STATUS,
  localizeMemeDescription,
  localizedPetName,
  localizedWhisperPrompt,
  localizedWorkStatusTexts,
  PACKAGED_PET_NAME,
  PACKAGED_WHISPER_PROMPT,
} from './packaged.ts';

const cjk = /[\u4e00-\u9fff]/;

describe('包内工作状态与表情包描述', () => {
  test('某一档被改过就留下，没改过的档在 ru 时是俄语', () => {
    const custom = PACKAGED_WORK_STATUS.map((slot) => [...slot]);
    custom[0] = ['我改过'];
    const out = localizedWorkStatusTexts('ru', custom);
    assert.deepEqual(out?.[0], ['我改过']);
    assert.equal(cjk.test((out?.[1] ?? []).join('')), false);
    assert.deepEqual(localizedWorkStatusTexts('en', PACKAGED_WORK_STATUS), PACKAGED_WORK_STATUS);
  });

  test('包内默认名在 ru 时换成俄文，改过的名字留下', () => {
    assert.equal(cjk.test(localizedPetName('ru', PACKAGED_PET_NAME)), false);
    assert.equal(localizedPetName('ru', '自家的名字'), '自家的名字');
    assert.equal(localizedPetName('en', PACKAGED_PET_NAME), PACKAGED_PET_NAME);
  });

  test('包内默认人设在 ru 时换成俄文，改过的人设留下', () => {
    assert.equal(cjk.test(localizedWhisperPrompt('ru', PACKAGED_WHISPER_PROMPT)), false);
    assert.equal(localizedWhisperPrompt('ru', '你是小女仆，这段不要改。'), '你是小女仆，这段不要改。');
    assert.equal(localizedWhisperPrompt('en', PACKAGED_WHISPER_PROMPT), PACKAGED_WHISPER_PROMPT);
  });

  test('表情包描述整段一致才换，用户改过的留下', () => {
    const name = '可爱';
    const packaged = PACKAGED_MEME_DESC[name] ?? '';
    assert.equal(cjk.test(localizeMemeDescription('ru', name, packaged)), false);
    assert.equal(localizeMemeDescription('ru', name, '用户改的'), '用户改的');
    assert.equal(localizeMemeDescription('zh', name, packaged), packaged);
  });
});
