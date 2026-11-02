/**
 * 独立模式余额查询的契约测试：只钉住不联网的两条短路，真实取数由 host 半侧的 balance.test.ts 覆盖。
 *
 * 这样测试不依赖公网与真实账号，也不会因为服务商接口变动而红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryStandaloneBalance } from './balance.ts';

test('未选服务商：直接 unsupported，不解析密钥也不发请求', async () => {
  assert.deepEqual(await queryStandaloneBalance('', 'some-key'), {
    ok: false,
    provider: '',
    reason: 'unsupported',
  });
});

test('缺密钥：落成 credential-missing，并把 host 半侧的凭证名带回来', async () => {
  assert.deepEqual(await queryStandaloneBalance('deepseek-official', ''), {
    ok: false,
    provider: 'deepseek-official',
    reason: 'credential-missing',
    message: '缺少凭证 DEEPSEEK_API_KEY',
  });
});

test('账号路由：独立模式没有账号服务，只能明确不可用而不是伪造余额', async () => {
  assert.deepEqual(await queryStandaloneBalance('deepseek-account', 'some-key'), {
    ok: false,
    provider: 'deepseek-account',
    reason: 'credential-missing',
    message: '缺少账号服务（deepseek-account）',
  });
});
