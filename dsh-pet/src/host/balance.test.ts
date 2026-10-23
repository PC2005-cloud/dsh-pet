/**
 * Command Code 用量的契约测试（provider id `commandcode`，控制面 `/alpha/*`）。
 *
 * 背景：Command Code 的用量在官方 CLI 使用的**未文档化控制面**路由上。插件把它的 5h / 周 / 月
 * 三个窗口映射成与 opencode 同构的三窗口用量，展示层因此共用同一套「取最紧迫窗口」逻辑。
 *
 * 本文件把三件事钉住：
 *   ① 真实 GOAT 报文的解析（含 `resetAt: 0` 这类占位值不得被当成 1970 年重置时间）；
 *   ② 失败口径：必填字段缺失/非法一律抛错（→ fetch-error），可选信息一律省略，绝不伪造 0；
 *   ③ 网络链路：四个接口的**顺序与 query**、Bearer 注入、凭证 ref、订阅接口失败不致命。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖；fetch 用手写 stub 顶替（只跑假数据，不联网）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  listBalanceProviders,
  matchBalanceProvider,
  parseAccountBalance,
  parseCommandCode,
  parseGoogleAntigravityQuota,
  queryBalance,
  registerBalanceProvider,
  type BalanceResult,
  type WindowsUsage,
} from './balance/index.ts';

/** 真实 GOAT 套餐报文（字段名与取值照抄线上响应；`resetAt: 0` 是空闲窗口的占位值） */
const GOAT_CREDITS = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
    weekly: { used: 0, cap: 35, exceeded: false, resetAt: 0 },
  },
};
const GOAT_SUBSCRIPTION = {
  success: true,
  data: {
    status: 'active',
    currentPeriodStart: '2026-09-13T01:01:27.000Z',
    currentPeriodEnd: '2026-10-13T01:01:27.000Z',
    planId: 'individual-goat',
  },
};
const GOAT_SUMMARY = { totalCost: 0, periodBasis: 'billing-period' };

/** 取成功的 commandcode 数据；形状不对直接失败（省得每个用例都写一遍收窄） */
function dataOf(result: BalanceResult): WindowsUsage {
  if (!result.ok || result.shape !== 'windows') {
    assert.fail('期望 commandcode 的成功结果，实际：' + JSON.stringify(result));
  }
  return result.data;
}

/** 百分比是算出来的浮点数：按 1e-9 容差比 */
function assertClose(actual: number | undefined, expected: number, what: string): void {
  assert.equal(typeof actual, 'number', what + ' 应为数字');
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, what + '：期望 ' + expected + '，实际 ' + actual);
}

/** 极简 Response 替身：被测代码只用到 ok / status / json() */
function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** 装上 fetch stub（返回记录与卸载函数）；只按 URL 路由，不做真实网络 */
function stubFetch(handler: (url: string) => Response): {
  calls: string[];
  auths: (string | null)[];
  restore: () => void;
} {
  const calls: string[] = [];
  const auths: (string | null)[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    auths.push(new Headers(init?.headers).get('authorization'));
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
  return {
    calls,
    auths,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** 默认路由：四个控制面接口都给真实 GOAT 报文 */
function goatRoute(url: string): Response {
  if (url.includes('/alpha/whoami')) return res({ success: true, user: { id: 'u-1' }, org: { id: 'org-1' } });
  if (url.includes('/alpha/billing/credits')) return res(GOAT_CREDITS);
  if (url.includes('/alpha/billing/subscriptions')) return res(GOAT_SUBSCRIPTION);
  if (url.includes('/alpha/usage/summary')) return res(GOAT_SUMMARY);
  return res({}, 404);
}

describe('BALANCE_PROVIDERS —— commandcode 已登记（凭证 COMMANDCODE_API_KEY）', () => {
  test('provider id 命中 commandcode，凭证 ref 是 COMMANDCODE_API_KEY，且定义自带取数', () => {
    const def = matchBalanceProvider('commandcode');
    assert.ok(def && 'credential' in def, '内置服务商必须带凭证声明');
    assert.equal(def.id, 'commandcode');
    assert.deepEqual(def.credential, { mode: 'ref', ref: 'COMMANDCODE_API_KEY' });
    assert.equal(typeof def.fetch, 'function', '服务商定义必须自带取数（加服务商只写一个文件）');
  });

  test('未登记的服务商仍然不命中（→ unsupported，不静默伪造 0）', () => {
    assert.equal(matchBalanceProvider('unregistered-provider'), undefined);
    assert.equal(matchBalanceProvider('opencode'), undefined, 'Zen 按量版（opencode）与 Go 是两个 id，前者无用量接口');
  });
});

describe('parseCommandCode —— 真实 GOAT 报文', () => {
  test('空闲窗口（resetAt: 0）：占位重置时间被丢弃，月度重置取订阅周期末', () => {
    const data = dataOf(parseCommandCode(GOAT_CREDITS, GOAT_SUBSCRIPTION, GOAT_SUMMARY, 'commandcode'));
    assert.equal(data.monthly, 0);
    assert.equal(data.monthlyCapUsd, 70, '月度池 = 当期消耗 0 + 剩余 70');
    assert.equal(data.monthlyResetsAt, '2026-10-13T01:01:27.000Z');
    assert.equal(data.rolling, 0);
    assert.equal(data.rollingCapUsd, 14);
    assert.equal(data.weekly, 0);
    assert.equal(data.weeklyCapUsd, 35);
    assert.equal(data.rollingResetsAt, undefined, 'resetAt: 0 是占位值，不能变成 1970 年重置时间');
    assert.equal(data.weeklyResetsAt, undefined);
  });

  test('有消耗：5h/周按 used/cap，月度按 消耗/(消耗+剩余)，字符串重置时间原样保留', () => {
    // windowLimits 嵌在 credits 内的旧变体：同样要认（实际报文在 credits 同级）
    const credits = {
      credits: {
        monthlyCredits: 12.5,
        purchasedCredits: 3,
        freeCredits: 0.5,
        windowLimits: {
          limited: true,
          fiveHour: { used: 4, cap: 14, resetAt: '2026-09-12T18:00:00.000Z' },
          weekly: { used: 12, cap: 40, resetAt: '2026-09-16T00:00:00.000Z' },
        },
      },
    };
    const subscription = { data: { currentPeriodEnd: '2026-10-01T00:00:00.000Z' } };
    const data = dataOf(parseCommandCode(credits, subscription, { totalCost: 7 }, 'commandcode'));

    assertClose(data.rolling, (4 / 14) * 100, '5h 窗口');
    assertClose(data.weekly, (12 / 40) * 100, '周窗口');
    assertClose(data.monthly, (7 / 23) * 100, '月度：消耗 7 /（7 + 16）');
    assert.equal(data.monthlyCapUsd, 23);
    assert.equal(data.rollingResetsAt, '2026-09-12T18:00:00.000Z');
    assert.equal(data.weeklyResetsAt, '2026-09-16T00:00:00.000Z');
    assert.equal(data.monthlyResetsAt, '2026-10-01T00:00:00.000Z');
  });

  test('无窗口限制（limited: false）：只有月度窗，不拿 5h/周充数', () => {
    const credits = {
      credits: { monthlyCredits: 0, purchasedCredits: 18.25, freeCredits: 0 },
      windowLimits: { limited: false },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 0 }, 'commandcode'));
    assert.equal(data.monthly, 0);
    assert.equal(data.monthlyCapUsd, 18.25);
    assert.equal(data.rolling, undefined);
    assert.equal(data.weekly, undefined);
    assert.equal(data.rollingCapUsd, undefined);
    assert.equal(data.weeklyCapUsd, undefined);
    assert.equal(data.monthlyResetsAt, undefined, '订阅缺失 → 没有重置倒计时，但不编一个出来');
  });

  test('cap 为 0 / used 缺失的窗口跳过，不影响其余窗口', () => {
    const credits = {
      credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 1, cap: 0 },
        weekly: { cap: 10 },
      },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 1 }, 'commandcode'));
    assert.equal(data.rolling, undefined, 'cap 为 0 的窗口不算（不是"已用 0%"）');
    assert.equal(data.weekly, undefined, 'used 缺失的窗口不算');
  });

  test('数字重置时间：秒级/毫秒级时间戳都转成 ISO', () => {
    const credits = {
      credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 1, cap: 10, resetAt: 1790000000 },
        weekly: { used: 1, cap: 10, resetAt: 1790000000000 },
      },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 0 }, 'commandcode'));
    assert.equal(data.rollingResetsAt, new Date(1790000000 * 1000).toISOString());
    assert.equal(data.weeklyResetsAt, new Date(1790000000000).toISOString());
  });

  test('负用量（无意义数据）按「未消耗」读：不产生负百分比（档位索引会越界）', () => {
    const credits = {
      credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { limited: true, fiveHour: { used: -3, cap: 14 } },
    };
    const data = dataOf(parseCommandCode(credits, undefined, { totalCost: 0 }, 'commandcode'));
    assert.equal(data.rolling, 0);
  });
});

describe('parseCommandCode —— 必填缺失/非法一律抛错（绝不伪造 0）', () => {
  test('缺少 credits → 抛错', () => {
    assert.throws(() => parseCommandCode({}, undefined, { totalCost: 0 }, 'commandcode'), /credits/);
  });

  test('credits 里三个额度字段全缺 → 抛错（否则分母当 0 会算出「已用 100%」）', () => {
    assert.throws(() => parseCommandCode({ credits: {} }, undefined, { totalCost: 0 }, 'commandcode'), /额度字段/);
  });

  test('缺少 / 非法 totalCost → 抛错', () => {
    const credits = { credits: { monthlyCredits: 1, purchasedCredits: 0, freeCredits: 0 } };
    assert.throws(() => parseCommandCode(credits, undefined, {}, 'commandcode'), /totalCost/);
    assert.throws(() => parseCommandCode(credits, undefined, { totalCost: 'abc' }, 'commandcode'), /totalCost/);
  });

  test('订阅接口的响应非法不是致命错（可选信息：只影响月度重置倒计时）', () => {
    const credits = { credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 } };
    for (const subscription of [undefined, {}, { data: null }, { data: { currentPeriodEnd: 0 } }]) {
      const data = dataOf(parseCommandCode(credits, subscription, { totalCost: 0 }, 'commandcode'));
      assert.equal(data.monthlyResetsAt, undefined);
    }
  });
});

describe('queryBalance —— 网络链路（fetch stub）', () => {
  test('四个接口按序请求，Bearer 注入，orgId / since 正确回填', async () => {
    const stub = stubFetch(goatRoute);
    const refs: string[] = [];
    try {
      const result = await queryBalance('commandcode', async (ref) => {
        refs.push(ref);
        return 'k-123';
      });
      assert.equal(result.ok, true);
      assert.deepEqual(stub.calls, [
        'https://api.commandcode.ai/alpha/whoami?limits=1',
        'https://api.commandcode.ai/alpha/billing/credits?orgId=org-1',
        'https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org-1',
        'https://api.commandcode.ai/alpha/usage/summary?since=2026-09-13T01%3A01%3A27.000Z&orgId=org-1',
      ]);
      assert.deepEqual([...new Set(stub.auths)], ['Bearer k-123']);
      assert.deepEqual(refs, ['COMMANDCODE_API_KEY']);
    } finally {
      stub.restore();
    }
  });

  test('whoami 里没有 org → 后续请求不带 orgId（不硬塞空值）', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/alpha/whoami')) return res({ success: true, user: { id: 'u-1' } });
      return goatRoute(url);
    });
    try {
      const result = await queryBalance('commandcode', async () => 'k');
      assert.equal(result.ok, true);
      assert.equal(stub.calls[1], 'https://api.commandcode.ai/alpha/billing/credits');
      assert.equal(stub.calls[2], 'https://api.commandcode.ai/alpha/billing/subscriptions');
      assert.equal(
        stub.calls[3],
        'https://api.commandcode.ai/alpha/usage/summary?since=2026-09-13T01%3A01%3A27.000Z',
        'orgId 没有就不带，但订阅拿到的当期起始时间照常带（since）',
      );
    } finally {
      stub.restore();
    }
  });

  test('订阅接口失败（按量付费账号可能没有订阅）→ 仍然成功，只是没有重置倒计时', async () => {
    const stub = stubFetch((url) => (url.includes('/alpha/billing/subscriptions') ? res({}, 500) : goatRoute(url)));
    try {
      const result = await queryBalance('commandcode', async () => 'k');
      const data = dataOf(result);
      assert.equal(data.monthlyResetsAt, undefined);
      assert.equal(data.rollingCapUsd, 14, '三个窗口的百分比与额度一个都不少');
      assert.equal(
        stub.calls[3],
        'https://api.commandcode.ai/alpha/usage/summary?orgId=org-1',
        '没拿到当期起始时间就不带 since（默认区间由服务端决定，插件不猜）',
      );
    } finally {
      stub.restore();
    }
  });

  test('401 → fetch-error，错误信息带接口路径与状态码（不退化成「未支持」）', async () => {
    const stub = stubFetch(() => res({ error: { code: 'UNAUTHORIZED' } }, 401));
    try {
      assert.deepEqual(await queryBalance('commandcode', async () => 'bad-key'), {
        ok: false,
        provider: 'commandcode',
        reason: 'fetch-error',
        message: 'commandcode /alpha/whoami HTTP 401',
      });
    } finally {
      stub.restore();
    }
  });

  test('缺凭证 → credential-missing，且一个请求都不发', async () => {
    const stub = stubFetch(goatRoute);
    try {
      assert.deepEqual(await queryBalance('commandcode', async () => undefined), {
        ok: false,
        provider: 'commandcode',
        reason: 'credential-missing',
        message: '缺少凭证 COMMANDCODE_API_KEY',
      });
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });

  test('未登记的服务商 → unsupported，且一个请求都不发', async () => {
    const stub = stubFetch(goatRoute);
    let asked = 0;
    try {
      assert.deepEqual(
        await queryBalance('unregistered-provider', async () => {
          asked += 1;
          return 'k';
        }),
        { ok: false, provider: 'unregistered-provider', reason: 'unsupported' },
      );
      assert.equal(asked, 0, '未登记的服务商连凭证都不该去解析');
      assert.deepEqual(stub.calls, []);
    } finally {
      stub.restore();
    }
  });
});

describe('deepseek-account —— DSH 账号路由（走账号服务，不是 HTTP + API Key）', () => {
  /** 真实 `AccountDetails['balance']` 形状：ready 带 value（充值）/ bonusWallets（赠送）两个钱包数组 */
  const READY = {
    status: 'ready' as const,
    value: [{ currency: 'CNY', balance: '8.79' }],
    bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
  };

  test('provider id 命中 deepseek-account，shape 与 deepseek-official 相同，凭证模式为 none（无 API Key）', () => {
    const def = matchBalanceProvider('deepseek-account');
    assert.ok(def && 'credential' in def, '内置服务商必须带凭证声明');
    assert.equal(def.id, 'deepseek-account');
    assert.deepEqual(def.credential, { mode: 'none' }, '账号路由没有 API Key，凭证由账号服务持有');
    assert.equal(typeof def.fetch, 'function');
  });

  test('ready：每个币种一条钱包，total = 充值 + 赠送（与官方 total_balance 同构）', () => {
    const r = parseAccountBalance(READY, 'deepseek-account');
    assert.ok(r.ok && r.shape === 'money');
    assert.equal(r.provider, 'deepseek-account');
    assert.deepEqual(r.data.wallets, [
      { currency: 'CNY', total: '13.79', granted: '5.00', toppedUp: '8.79', fullBalance: '20' },
    ]);
    assert.ok(r.data.tier === 'peak' || r.data.tier === 'idle', '档位由服务商算好后随数据带出');
  });

  test('没有赠送钱包 → granted 为 0.00，total 等于充值（不因缺赠送而漏算或虚增）', () => {
    const r = parseAccountBalance(
      { status: 'ready', value: [{ currency: 'CNY', balance: '8.79' }] },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.deepEqual(r.data.wallets, [
      { currency: 'CNY', total: '8.79', granted: '0.00', toppedUp: '8.79', fullBalance: '20' },
    ]);
  });

  test('USD 钱包：币种原样带出（展示层据此选符号），金额不做换算，基准按币种查表', () => {
    const r = parseAccountBalance(
      { status: 'ready', value: [{ currency: 'USD', balance: '12.5' }], bonusWallets: [] },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.deepEqual(r.data.wallets, [
      { currency: 'USD', total: '12.50', granted: '0.00', toppedUp: '12.50', fullBalance: '5' },
    ]);
  });

  test('多币种钱包：全部搬出去（不再只挑一个），每个币种各一条', () => {
    const r = parseAccountBalance(
      {
        status: 'ready',
        value: [
          { currency: 'USD', balance: '0.00' },
          { currency: 'CNY', balance: '20.00' },
        ],
        bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
      },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.deepEqual(r.data.wallets, [
      { currency: 'USD', total: '0.00', granted: '0.00', toppedUp: '0.00', fullBalance: '5' },
      { currency: 'CNY', total: '25.00', granted: '5.00', toppedUp: '20.00', fullBalance: '20' },
    ]);
  });

  test('同币种多条钱包 → 累加，不丢钱', () => {
    const r = parseAccountBalance(
      {
        status: 'ready',
        value: [
          { currency: 'CNY', balance: '1.00' },
          { currency: 'CNY', balance: '2.50' },
        ],
        bonusWallets: [{ currency: 'CNY', balance: '0.50' }],
      },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.deepEqual(r.data.wallets, [
      { currency: 'CNY', total: '4.00', granted: '0.50', toppedUp: '3.50', fullBalance: '20' },
    ]);
  });

  test('真实平台精度串（16 位小数）→ 收敛到两位，与官方路由的 ¥8.79 风格一致', () => {
    const r = parseAccountBalance(
      {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '9.9902690000000000' }],
        bonusWallets: [{ currency: 'CNY', balance: '0' }],
      },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.equal(r.data.wallets[0]?.total, '9.99');
    assert.equal(r.data.wallets[0]?.granted, '0.00');
  });

  test('赠送钱包币种不同 → 各归各的：CNY 没有赠金，USD 那条把赠金带上', () => {
    const r = parseAccountBalance(
      {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '8.79' }],
        bonusWallets: [{ currency: 'USD', balance: '1' }],
      },
      'deepseek-account',
    );
    assert.ok(r.ok && r.shape === 'money');
    assert.deepEqual(r.data.wallets, [
      { currency: 'CNY', total: '8.79', granted: '0.00', toppedUp: '8.79', fullBalance: '20' },
      { currency: 'USD', total: '1.00', granted: '1.00', toppedUp: '0.00', fullBalance: '5' },
    ]);
  });

  test('null（未登录）/ failed（查询失败）/ 空钱包 → 一律抛错，绝不伪造 0 余额', () => {
    assert.throws(() => parseAccountBalance(null, 'deepseek-account'), /未登录/);
    assert.throws(() => parseAccountBalance(undefined, 'deepseek-account'), /未登录/);
    assert.throws(() => parseAccountBalance({ status: 'failed' }, 'deepseek-account'), /查询失败/);
    assert.throws(
      () => parseAccountBalance({ status: 'ready', value: [], bonusWallets: [] }, 'deepseek-account'),
      /没有充值钱包/,
    );
    assert.throws(
      () => parseAccountBalance({ status: 'ready', value: [{ currency: 'CNY', balance: '' }] }, 'deepseek-account'),
      /非法|balance/,
    );
    assert.throws(
      () => parseAccountBalance({ status: 'ready', value: [{ currency: 'CNY', balance: 'abc' }] }, 'deepseek-account'),
      /非法/,
    );
  });

  test('queryBalance：账号路由不去解析凭证、不发任何 HTTP，只调 resolveAccount', async () => {
    const stub = stubFetch(goatRoute);
    let asked = 0;
    try {
      const r = await queryBalance(
        'deepseek-account',
        async () => {
          asked += 1;
          return 'should-not-be-used';
        },
        async () => READY,
      );
      assert.ok(r.ok && r.shape === 'money');
      assert.equal(
        r.data.wallets.find((w) => w.currency === 'CNY')?.total,
        '13.79',
        '与 parseAccountBalance 同一口径：赠送 5.00 + 充值 8.79',
      );
      assert.equal(asked, 0, '账号路由没有 API Key 可解析');
      assert.deepEqual(stub.calls, [], '账号路由不走 fetch');
    } finally {
      stub.restore();
    }
  });

  test('queryBalance：账号服务不在场（未注入）→ credential-missing，不退化成 unsupported', async () => {
    assert.deepEqual(await queryBalance('deepseek-account', async () => 'k'), {
      ok: false,
      provider: 'deepseek-account',
      reason: 'credential-missing',
      message: '缺少账号服务（deepseek-account）',
    });
  });

  test('queryBalance：账号查询抛错 → fetch-error，错误信息透传', async () => {
    const r = await queryBalance(
      'deepseek-account',
      async () => 'k',
      async () => {
        throw new Error('dsh-pet: 账号余额查询失败');
      },
    );
    assert.deepEqual(r, {
      ok: false,
      provider: 'deepseek-account',
      reason: 'fetch-error',
      message: 'dsh-pet: 账号余额查询失败',
    });
  });
});

describe('注册表 —— 第三方 provider（register / list / match）', () => {
  /** 一个最小可用的第三方 provider（points 形态） */
  const plugin = (id: string) => ({
    id,
    async fetch({ provider }: { provider: string }) {
      return {
        ok: true as const,
        provider,
        shape: 'points' as const,
        data: { unit: '积分', total: '800', full: '1000' },
      };
    },
  });

  test('注册后命中，list 里可见；注销后回落 unsupported', () => {
    const dispose = registerBalanceProvider(plugin('plugin-a'));
    try {
      assert.equal(matchBalanceProvider('plugin-a')?.id, 'plugin-a');
      assert.ok(listBalanceProviders().external.includes('plugin-a'));
      assert.ok(listBalanceProviders().builtin.includes('commandcode'), '内置仍在列表里');
    } finally {
      dispose();
    }
    assert.equal(matchBalanceProvider('plugin-a'), undefined, '注销后不再命中');
  });

  test('不能覆盖内置 id', () => {
    assert.throws(() => registerBalanceProvider(plugin('deepseek-official')), /不能覆盖内置服务商/);
  });

  test('重复注册同一个 id → 抛错（不静默覆盖）', () => {
    const dispose = registerBalanceProvider(plugin('plugin-b'));
    try {
      assert.throws(() => registerBalanceProvider(plugin('plugin-b')), /已被注册/);
    } finally {
      dispose();
    }
  });

  test('旧注销函数不会误删后来注册的同一个 id', () => {
    const first = registerBalanceProvider(plugin('plugin-c'));
    first();
    const second = registerBalanceProvider(plugin('plugin-c'));
    first(); // 迟到的注销（旧插件实例的 cleanup）
    try {
      assert.equal(matchBalanceProvider('plugin-c')?.id, 'plugin-c');
    } finally {
      second();
    }
  });

  test('queryBalance：第三方分支不解析 key、不传 resolveAccount', async () => {
    let keyAsked = 0;
    let seen: unknown;
    const dispose = registerBalanceProvider({
      id: 'plugin-d',
      async fetch(ctx) {
        seen = ctx;
        return { ok: true, provider: ctx.provider, shape: 'points', data: { unit: '积分', total: '1' } };
      },
    });
    try {
      const r = await queryBalance(
        'plugin-d',
        async () => {
          keyAsked++;
          return 'k';
        },
        async () => ({ status: 'ready' }),
      );
      assert.ok(r.ok && r.shape === 'points');
      assert.equal(keyAsked, 0, '第三方分支不得去解析凭证');
      assert.deepEqual(seen, { provider: 'plugin-d' }, 'fetch 只能拿到 provider（没有 key / resolveAccount）');
    } finally {
      dispose();
    }
  });

  test('queryBalance：第三方 fetch 抛错 → fetch-error（与内置同一口径）', async () => {
    const dispose = registerBalanceProvider({
      id: 'plugin-e',
      async fetch() {
        throw new Error('boom');
      },
    });
    try {
      assert.deepEqual(await queryBalance('plugin-e', async () => 'k'), {
        ok: false,
        provider: 'plugin-e',
        reason: 'fetch-error',
        message: 'boom',
      });
    } finally {
      dispose();
    }
  });

  test('未注册的 id 仍是 unsupported', async () => {
    assert.deepEqual(await queryBalance('plugin-unknown', async () => 'k'), {
      ok: false,
      provider: 'plugin-unknown',
      reason: 'unsupported',
    });
  });
});

describe('Google Antigravity 配额查询（provider id google-antigravity）', () => {
  const MOCK_ANTIGRAVITY_QUOTA = {
    state: 'available',
    checkedAt: '2026-10-23T06:00:00.000Z',
    groups: [
      {
        group: 'gemini',
        modelCount: 10,
        windows: [
          { window: '5h', remainingFraction: 0.8, resetTime: '2026-10-23T10:00:00.000Z' },
          { window: 'weekly', remainingFraction: 0.65, resetTime: '2026-10-26T00:00:00.000Z' },
        ],
      },
      {
        group: 'non-gemini',
        modelCount: 3,
        windows: [
          { window: '5h', remainingFraction: 0.5, resetTime: '2026-10-23T11:00:00.000Z' },
          { window: 'weekly', remainingFraction: 0.4, resetTime: '2026-10-27T00:00:00.000Z' },
        ],
      },
    ],
  };

  test('常规 Gemini 模型：匹配 gemini 分组，剩余转已用百分比', () => {
    const res = parseGoogleAntigravityQuota(MOCK_ANTIGRAVITY_QUOTA, 'google-antigravity', 'gemini-2.5-pro');
    assert.equal(res.ok, true);
    assert.equal(res.shape, 'windows');
    assert.equal(res.data.rolling, 20); // (1 - 0.8) * 100
    assert.equal(res.data.rollingLabel, '5h');
    assert.equal(res.data.rollingResetsAt, '2026-10-23T10:00:00.000Z');
    assert.equal(res.data.weekly, 35); // (1 - 0.65) * 100
    assert.equal(res.data.weeklyResetsAt, '2026-10-26T00:00:00.000Z');
    assert.equal(res.data.monthly, undefined);
  });

  test('Claude / 3P 模型：自动切换到 non-gemini 分组', () => {
    const res = parseGoogleAntigravityQuota(MOCK_ANTIGRAVITY_QUOTA, 'google-antigravity', 'claude-3-7-sonnet');
    assert.equal(res.ok, true);
    assert.equal(res.shape, 'windows');
    assert.equal(res.data.rolling, 50); // (1 - 0.5) * 100
    assert.equal(res.data.weekly, 60); // (1 - 0.4) * 100
  });

  test('未登录状态抛出可读错误', () => {
    assert.throws(
      () => parseGoogleAntigravityQuota({ state: 'unauthenticated' }, 'google-antigravity'),
      /Antigravity 未登录/,
    );
  });

  test('限流状态抛出可读错误', () => {
    assert.throws(
      () => parseGoogleAntigravityQuota({ state: 'rate-limited' }, 'google-antigravity'),
      /配额查询被限流/,
    );
  });

  test('queryBalance 缺少 resolveAntigravity 时报 credential-missing', async () => {
    const res = await queryBalance('google-antigravity', async () => 'k');
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, 'credential-missing');
      assert.match(res.message ?? '', /缺少 Antigravity 服务/);
    }
  });

  test('queryBalance 成功链路', async () => {
    const res = await queryBalance(
      'google-antigravity',
      async () => 'k',
      undefined,
      async () => MOCK_ANTIGRAVITY_QUOTA,
      'gemini-2.5-flash',
    );
    assert.equal(res.ok, true);
    if (res.ok && res.shape === 'windows') {
      assert.equal(res.data.rolling, 20);
      assert.equal(res.data.weekly, 35);
    }
  });
});

