/**
 * 账号态余额（`deepseek-account`）的 host 侧单测。
 *
 * 背景：`BALANCE_PROVIDERS` 原本只登记 `opencode-go` / `deepseek-official` 两个 provider id，
 * 而官方桌面端的 DSH 默认走 **账号登录态**（`agentDefaultModel.currentSelection().provider`
 * === `deepseek-account`）——两个 id 都对不上，`/dsh-pet-7340/state` 里的余额恒为
 * `{ ok:false, reason:'unsupported' }`，桌宠「查看余额」永远查不出金额。
 *
 * 另一条 `deepseek-official` 路也走不通：它要 `DEEPSEEK_API_KEY`，而账号态用户根本没有这把 key。
 *
 * 修法：`deepseek-account` 登记为 `via:'account'`，取数交给 DSH 自己的 `deepseekAccount` 服务
 * （token 注入、x-client-* 头、401 失效清理都由它负责）——与鲸鱼挂件 dsh-whale-widget 同一数据源。
 * 本文件钉住三件事：
 *   ① 账号态能算出金额，且口径 = 充值(normal_wallets) + 赠金(bonus_wallets)（与 API key 路径同口径）；
 *   ② 服务缺失 / 未登录 / 响应非法 / 抛错 → 显式回落，**绝不伪造 0**；
 *   ③ 既有 provider 行为完全不受影响（含 API key 路径）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { queryBalance, type AccountBalanceResponse } from './balance.ts';

/** 永不调用的凭证解析：账号态不该碰凭证（真调用了就说明路由错了） */
const noCredentials = async (): Promise<string | undefined> => {
  throw new Error('账号态不应解析凭证');
};

/** 账号服务返回值构造 */
const ready = (value: unknown, bonusWallets: unknown = []): AccountBalanceResponse => ({
  status: 'ready',
  value,
  bonusWallets,
});

describe('queryBalance —— 账号态（deepseek-account）', () => {
  test('充值 + 赠金求和，口径与 API key 路径的 total_balance 一致', async () => {
    const result = await queryBalance('deepseek-account', noCredentials, async () =>
      ready([{ currency: 'CNY', balance: '8.7728288' }], [{ currency: 'CNY', balance: '5.1740408' }]),
    );
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'deepseek-account');
    assert.equal(result.kind, 'deepseek');
    if (result.ok && result.kind === 'deepseek') {
      assert.equal(result.data.currency, 'CNY');
      assert.equal(Number(result.data.toppedUp), 8.7728288);
      assert.equal(Number(result.data.granted), 5.1740408);
      // 关键：total = 充值 + 赠金（不是只报充值）
      assert.equal(Number(result.data.total), Number(8.7728288) + Number(5.1740408));
    }
  });

  test('多钱包同币种求和；美元账户也能正确判币种', async () => {
    const cny = await queryBalance('deepseek-account', noCredentials, async () =>
      ready(
        [
          { currency: 'CNY', balance: '1.00' },
          { currency: 'CNY', balance: '2.00' },
        ],
        [{ currency: 'CNY', balance: '3.00' }],
      ),
    );
    assert.equal(cny.ok, true);
    if (cny.ok && cny.kind === 'deepseek') assert.equal(Number(cny.data.total), 6);

    const usd = await queryBalance('deepseek-account', noCredentials, async () =>
      ready([{ currency: 'USD', balance: '4.00' }], [{ currency: 'USD', balance: '1.00' }]),
    );
    assert.equal(usd.ok, true);
    if (usd.ok && usd.kind === 'deepseek') {
      assert.equal(usd.data.currency, 'USD');
      assert.equal(Number(usd.data.total), 5);
    }
  });

  test('未登录 / 未就绪 / 空钱包 → 显式回落，绝不伪造 0', async () => {
    for (const raw of [
      { status: 'signed-out' },
      ready([]),
      ready('not-an-array'),
      { status: 'ready' }, // 没有 value
    ]) {
      const result = await queryBalance('deepseek-account', noCredentials, async () => raw as AccountBalanceResponse);
      assert.equal(result.ok, false, `不应把 ${JSON.stringify(raw)} 当作可用余额`);
      if (!result.ok) assert.equal(result.reason, 'unsupported');
    }
  });

  test('金额全非法 → 回落，不把无法解析的钱包当 0 求和', async () => {
    const result = await queryBalance('deepseek-account', noCredentials, async () =>
      ready([{ currency: 'CNY', balance: 'n/a' }], []),
    );
    assert.equal(result.ok, false);
  });

  test('账号服务抛错 → fetch-error（带 message），不吞不伪造', async () => {
    const result = await queryBalance('deepseek-account', noCredentials, async () => {
      throw new Error('account service down');
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'fetch-error');
      assert.match(result.message ?? '', /account service down/);
    }
  });

  test('老宿主没有 deepseekAccount（取数函数缺失）→ unsupported，不是崩溃', async () => {
    const result = await queryBalance('deepseek-account', noCredentials, undefined);
    assert.deepEqual(result, { ok: false, provider: 'deepseek-account', reason: 'unsupported' });
  });
});

describe('queryBalance —— 既有路径不受影响', () => {
  test('未登记服务商：仍然 unsupported（且不触碰账号服务）', async () => {
    let accountCalled = false;
    const result = await queryBalance('commandcode', noCredentials, async () => {
      accountCalled = true;
      return ready([{ currency: 'CNY', balance: '1' }]);
    });
    assert.deepEqual(result, { ok: false, provider: 'commandcode', reason: 'unsupported' });
    assert.equal(accountCalled, false, '未登记的 provider 不该去问账号服务');
  });

  test('deepseek-official：缺 API key → credential-missing（账号态不介入）', async () => {
    let accountCalled = false;
    const result = await queryBalance(
      'deepseek-official',
      async () => undefined,
      async () => {
        accountCalled = true;
        return ready([{ currency: 'CNY', balance: '1' }]);
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'credential-missing');
      assert.match(result.message ?? '', /DEEPSEEK_API_KEY/);
    }
    assert.equal(accountCalled, false, 'API key 路径不该回落到账号服务（两条路互不干扰）');
  });
});
