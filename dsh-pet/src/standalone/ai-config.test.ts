import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiConfig, validateSettings, DEFAULT_AI_SETTINGS, migrateLegacySettings } from './ai-config.ts';

/** 一份「自定义服务商」的完整配置，用作各用例的基线。 */
const configured = {
  service: 'custom' as const,
  keys: { CUSTOM_API_KEY: 'test-secret' },
  profiles: {
    custom: { protocol: 'openai-compatible' as const, baseUrl: 'https://example.test/v1', model: 'chosen-model' },
  },
};

test('validates safe endpoints and explicit configuration with fixed redacted errors', () => {
  for (const baseUrl of [
    'ftp://example.test',
    'https://u:p@example.test',
    'https://example.test/?key=secret',
    'https://example.test/#secret',
    'javascript:alert(1)',
    'https://example.test\\v1',
  ]) {
    assert.throws(
      () => validateSettings({ profiles: { custom: { ...configured.profiles.custom, baseUrl } } }, DEFAULT_AI_SETTINGS),
      /^Error: Invalid standalone AI settings\.$/,
    );
  }
  for (const baseUrl of [
    'http://192.168.1.100:8000/v1',
    'http://localhost:1234/v1',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
    'https://example.test/v1',
  ]) {
    assert.equal(
      validateSettings({ profiles: { custom: { ...configured.profiles.custom, baseUrl } } }, DEFAULT_AI_SETTINGS)
        .baseUrl,
      baseUrl,
    );
  }
  // 配置填一半是允许保存的：它只是暂时不可用，不该连保存都拒绝。
  assert.equal(
    validateSettings({ profiles: { custom: { ...configured.profiles.custom, model: '' } } }, DEFAULT_AI_SETTINGS).model,
    '',
  );
  for (const patch of [
    { timeoutMs: 60001 },
    { whisperIntervalSec: 59 },
    { maxTokens: 100000 },
    { hasKey: true },
    { keys: { CUSTOM_API_KEY: 'bad\nkey' } },
    { profiles: { nope: { protocol: 'openai-compatible', baseUrl: '', model: '' } } },
  ]) {
    assert.throws(
      () => validateSettings({ ...configured, ...patch }, DEFAULT_AI_SETTINGS),
      /Invalid standalone AI settings/,
    );
  }
});

test('服务商：默认自定义，内置三家的协议与地址由名录回填，未知值拒绝', () => {
  assert.equal(DEFAULT_AI_SETTINGS.service, 'custom');
  assert.equal(DEFAULT_AI_SETTINGS.baseUrl, '', '自定义默认没有地址');
  for (const [service, baseUrl] of [
    ['deepseek-official', 'https://api.deepseek.com'],
    ['opencode-go', 'https://opencode.ai/inference/go/openai/v1'],
    ['commandcode', 'https://api.commandcode.ai/provider/v1'],
  ] as const) {
    const next = validateSettings({ service }, DEFAULT_AI_SETTINGS);
    assert.equal(next.service, service);
    assert.equal(next.baseUrl, baseUrl, `${service} 的地址应来自名录`);
    assert.equal(next.protocol, 'openai-compatible');
  }
  for (const service of ['deepseek-account', 'openai', 'DEEPSEEK-OFFICIAL', '']) {
    assert.throws(() => validateSettings({ service }, DEFAULT_AI_SETTINGS), /Invalid standalone AI settings/);
  }
});

test('密钥按服务分栏：换服务不覆盖别家，切回来还是原来那把', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-keys-'));
  try {
    const store = createAiConfig(home);
    const saved = await store.save({ keys: { CUSTOM_API_KEY: 'custom-key' }, profiles: configured.profiles });
    assert.equal(saved.hasKey, true);
    assert.deepEqual(saved.savedKeys, ['CUSTOM_API_KEY']);
    assert.equal(store.current().apiKey, 'custom-key');

    await store.save({ service: 'deepseek-official', keys: { DEEPSEEK_API_KEY: 'ds-key' } });
    assert.equal(store.current().apiKey, 'ds-key', '当前服务商换成 DeepSeek');
    assert.deepEqual(store.publicSettings().savedKeys.sort(), ['CUSTOM_API_KEY', 'DEEPSEEK_API_KEY']);

    // 切回自定义：那把还在，没被 DeepSeek 的写入冲掉
    await store.save({ service: 'custom' });
    assert.equal(store.current().apiKey, 'custom-key');
    assert.equal(store.current().baseUrl, 'https://example.test/v1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('profile 按服务分栏：地址与模型各自保留，换服务不互相污染', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-profiles-'));
  try {
    const store = createAiConfig(home);
    await store.save({
      service: 'custom',
      profiles: { custom: { protocol: 'anthropic', baseUrl: 'https://mine.test/v1', model: 'mine' } },
    });
    await store.save({
      service: 'opencode-go',
      profiles: { 'opencode-go': { protocol: 'openai-compatible', baseUrl: 'https://opencode.test/v1', model: 'go' } },
    });
    assert.equal(store.current().baseUrl, 'https://opencode.test/v1');
    assert.equal(store.current().protocol, 'openai-compatible');
    // DeepSeek 没被碰过，仍是名录里的默认值
    assert.equal(store.publicSettings().profiles['deepseek-official'].baseUrl, 'https://api.deepseek.com');
    await store.save({ service: 'custom' });
    assert.equal(store.current().baseUrl, 'https://mine.test/v1');
    assert.equal(store.current().protocol, 'anthropic');
    assert.equal(store.current().model, 'mine');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('旧配置迁移：地址命中某家就认那家，否则保留自定义且对话不变', () => {
  const legacy = {
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'legacy-secret',
    balanceProvider: 'deepseek-official',
    enabled: true,
  };
  const migrated = migrateLegacySettings(legacy) as Record<string, unknown>;
  assert.equal(migrated.service, 'deepseek-official');
  assert.equal('balanceProvider' in migrated, false, '旧字段必须丢掉');
  assert.equal('apiKey' in migrated, false, '统一密钥搬进分栏');
  assert.deepEqual(migrated.keys, {
    DEEPSEEK_API_KEY: 'legacy-secret',
    OPENCODE_GO_API_KEY: '',
    COMMANDCODE_API_KEY: '',
    CUSTOM_API_KEY: '',
  });
  assert.equal((migrated.profiles as Record<string, { model: string }>)['deepseek-official'].model, 'deepseek-chat');

  const custom = migrateLegacySettings({ ...legacy, baseUrl: 'https://relay.test/v1' }) as Record<string, unknown>;
  assert.equal(custom.service, 'custom', '地址不是任何一家，保持自定义');
  assert.equal((custom.profiles as Record<string, { baseUrl: string }>).custom.baseUrl, 'https://relay.test/v1');

  // 已经迁移过的文件原样返回，不会二次搬家
  assert.deepEqual(migrateLegacySettings({ keys: {}, profiles: {}, service: 'custom' }), {
    keys: {},
    profiles: {},
    service: 'custom',
  });
});

test('语音密钥独立于对话密钥：单独保存、单独清空、互不影响', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-speech-'));
  try {
    const store = createAiConfig(home);
    assert.equal(store.publicSettings().hasDeepseekKey, false, '默认没有语音密钥');
    const saved = await store.save({ ...configured, deepseekApiKey: 'speech-secret' });
    assert.equal(saved.hasDeepseekKey, true);
    assert.equal('deepseekApiKey' in saved, false, '密钥不回显');
    // 清对话密钥不能连语音那把一起清掉：两者是给不同服务用的
    assert.equal((await store.save({ clearKey: true })).hasDeepseekKey, true);
    assert.equal(store.current().deepseekApiKey, 'speech-secret');
    assert.equal(store.current().apiKey, '', '当前是自定义服务商，清的就是它那栏');
    // 清语音密钥同样不动对话密钥
    await store.save({ keys: { CUSTOM_API_KEY: 'talk-secret' } });
    assert.equal((await store.save({ clearDeepseekKey: true })).hasDeepseekKey, false);
    assert.equal(store.current().deepseekApiKey, '');
    assert.equal(store.current().apiKey, 'talk-secret');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('清空与写入同时出现时拒绝，意图不明', () => {
  assert.throws(
    () => validateSettings({ clearKey: true, keys: { CUSTOM_API_KEY: 'x' } }, DEFAULT_AI_SETTINGS),
    /Invalid standalone AI settings/,
  );
  assert.throws(
    () => validateSettings({ clearDeepseekKey: true, deepseekApiKey: 'x' }, DEFAULT_AI_SETTINGS),
    /Invalid standalone AI settings/,
  );
});

test('persists only in isolated home, redacts keys, supports keep and clear, reloads offline', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-'));
  try {
    const store = createAiConfig(home);
    assert.equal(store.publicSettings().hasKey, false);
    const saved = await store.save(configured);
    assert.equal(saved.hasKey, true);
    assert.equal('apiKey' in saved, false);
    assert.equal('profiles' in saved, true, 'profile 不是密钥，可以回传');
    assert.equal(saved.maxTokens, 1024);
    assert.equal(saved.whisperIntervalSec, 300);
    // 空串表示「这次没填」，保留已存的那把
    assert.equal((await store.save({ keys: { CUSTOM_API_KEY: '' }, automaticWhispers: true })).hasKey, true);
    assert.equal(createAiConfig(home).publicSettings().model, 'chosen-model');
    const raw = readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8');
    assert.match(raw, /test-secret/);
    assert.equal(raw.includes('"apiKey"'), false, '落盘只存分栏，不存派生字段');
    // 启用位只为旧文件保留：无论传什么，落盘一律为 true，对外视图也不再暴露。
    const forced = await store.save({ enabled: false });
    assert.equal('enabled' in forced, false);
    assert.match(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'), /"enabled":true/);
    assert.equal((await store.save({ clearKey: true })).hasKey, false);
    assert.equal(createAiConfig(home).publicSettings().hasKey, false);
    writeFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), '{broken');
    assert.throws(() => createAiConfig(home), /^Error: Cannot securely load standalone AI settings\.$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('旧配置文件缺后加字段：铺默认值后仍可读，不因 strict 校验整体失败', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-ai-legacy-'));
  try {
    mkdirSync(join(home, 'dsh-pet'), { recursive: true });
    // 升级前的落盘形状：没有 service / keys / profiles，也没有 balanceProvider。
    writeFileSync(
      join(home, 'dsh-pet', 'standalone-ai.json'),
      JSON.stringify({
        protocol: 'openai-compatible',
        baseUrl: 'https://example.test/v1',
        model: 'legacy-model',
        apiKey: 'legacy-secret',
        enabled: true,
        automaticWhispers: false,
        whisperIntervalSec: 300,
        maxTokens: 1024,
        timeoutMs: 30000,
      }),
    );
    const store = createAiConfig(home);
    assert.equal(store.publicSettings().model, 'legacy-model');
    assert.equal(store.publicSettings().hasKey, true);
    assert.equal(store.publicSettings().service, 'custom', '地址不是内置三家，保持自定义');
    assert.equal(store.current().baseUrl, 'https://example.test/v1');
    assert.deepEqual(store.publicSettings().profiles['deepseek-official'], {
      protocol: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      model: '',
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
