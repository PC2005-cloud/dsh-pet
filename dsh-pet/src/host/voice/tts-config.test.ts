/**
 * 语音配置解析的行为测试（src/host/voice/tts-config.ts）。
 *
 * 钉住三条：来源非法回落 edge、密钥环境变量优先于配置文件、回复语言原样变 language_code。
 * 这里只解析配置，不发请求（合成那一路在 ./breeze.test.ts）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BREEZE_DEFAULT_VOICE_ID } from '../../shared/voice-provider.ts';
import { BREEZE_API_KEY_ENV, readVoiceSettings } from './tts-config.ts';

test('没写来源：默认 edge，且不带 breeze 段', () => {
  assert.deepEqual(readVoiceSettings({}, {}), { provider: 'edge' });
  assert.deepEqual(readVoiceSettings(undefined, {}), { provider: 'edge' });
});

test('来源非法：回落 edge（与宿主校验同一口径）', () => {
  for (const value of ['edge2', 'BREEZE', 42, null, {}]) {
    assert.deepEqual(readVoiceSettings({ ttsProvider: value }, {}), { provider: 'edge' }, `${String(value)} 应回落`);
  }
});

test('breeze：读密钥、音色与语种', () => {
  const out = readVoiceSettings(
    { ttsProvider: 'breeze', breezeApiKey: 'brz_cfg', breezeVoiceId: 'voc_aaaabbbb', replyLanguage: 'en' },
    {},
  );
  assert.deepEqual(out, {
    provider: 'breeze',
    breeze: { apiKey: 'brz_cfg', voiceId: 'voc_aaaabbbb', languageCode: 'en' },
  });
});

test('环境变量优先于配置文件（临时验证不必改盘上配置）', () => {
  const out = readVoiceSettings(
    { ttsProvider: 'breeze', breezeApiKey: 'brz_from_config' },
    { [BREEZE_API_KEY_ENV]: 'brz_from_env' },
  );
  assert.equal(out.breeze?.apiKey, 'brz_from_env');
});

test('环境变量空白：不算配置值，仍用配置文件', () => {
  const out = readVoiceSettings(
    { ttsProvider: 'breeze', breezeApiKey: 'brz_from_config' },
    { [BREEZE_API_KEY_ENV]: '   ' },
  );
  assert.equal(out.breeze?.apiKey, 'brz_from_config');
});

test('两侧都没有密钥：apiKey 是空串（调用方据此回落 edge），不抛错', () => {
  const out = readVoiceSettings({ ttsProvider: 'breeze' }, {});
  assert.equal(out.breeze?.apiKey, '');
});

test('音色：缺省或非法都用默认音色', () => {
  const missing = readVoiceSettings({ ttsProvider: 'breeze', breezeApiKey: 'k' }, {});
  assert.equal(missing.breeze?.voiceId, BREEZE_DEFAULT_VOICE_ID);
  for (const bad of ['zh-CN-XiaoxiaoNeural', 'voc_', 42, null]) {
    const out = readVoiceSettings({ ttsProvider: 'breeze', breezeApiKey: 'k', breezeVoiceId: bad }, {});
    assert.equal(out.breeze?.voiceId, BREEZE_DEFAULT_VOICE_ID, `${String(bad)} 应回落默认音色`);
  }
});

test('回复语言：空串 / 非法 / 缺省都不传 language_code（让上游按文本判断）', () => {
  for (const replyLanguage of [undefined, '', 'xx', 42]) {
    const out = readVoiceSettings({ ttsProvider: 'breeze', breezeApiKey: 'k', replyLanguage }, {});
    assert.equal('languageCode' in (out.breeze ?? {}), false, `${String(replyLanguage)} 不该带语种`);
  }
});

test('回复语言大小写与空白：归一化后再传', () => {
  const out = readVoiceSettings({ ttsProvider: 'breeze', breezeApiKey: 'k', replyLanguage: ' JA ' }, {});
  assert.equal(out.breeze?.languageCode, 'ja');
});

test('密钥按 trim 落用：粘贴带进来的首尾空白不该变成鉴权失败', () => {
  const out = readVoiceSettings({ ttsProvider: 'breeze', breezeApiKey: '  brz_trimmed  ' }, {});
  assert.equal(out.breeze?.apiKey, 'brz_trimmed');
});
