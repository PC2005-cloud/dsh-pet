/**
 * 余额「不可用」路径的契约测试：必须有可见反馈，且两端（浏览器 overlay / 桌面外壳）只走一份判定。
 *
 * 背景：`/dsh-pet-7340/balance` 对未登记的服务商返回 `{ ok:false, reason:'unsupported' }`（HTTP 200）。
 * 若客户端在渲染处硬性要求 `balance.ok`、气泡只由「拉取成功」的 tick 驱动，页面上就完全没有任何反应：
 * 不播动画、不弹气泡、连 console 都不打。现在由 src/shared 的 decideBalanceNotice 统一判定弹不弹
 * （显式请求必弹；自动轮询仅在原因变化时弹一次），两端各自只负责把行数据画出来。
 *
 * 本文件把四件事钉住：
 *   ① 不可用状态的文案（含 provider/凭证名，且不留空行、不出现双重「缺少凭证」前缀）；
 *   ② 弹窗判定（显式 vs 自动、原因变化、ok 状态清零）；
 *   ③ commandcode 的三窗口（cap 参与「最紧迫窗口」判定、无窗口限制时不补 0）与 opencode 同一套口径；
 *   ④ 源码级守卫——客户端渲染不得再要求 balance.ok（有 React/DOM 依赖，只能读源码断言）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  balanceBubbleView,
  balanceDetailView,
  balancePageCount,
  balancePageView,
  balancePercent,
  customClickable,
  customViews,
  decideBalanceNotice,
  toBalanceState,
  urgentWindow,
  CUSTOM_LIMITS,
  type BalanceState,
  type BalanceView,
  type CustomBalance,
} from './balance/index.ts';

/** 包内文件源码（守卫用；相对 src/shared/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 一次「自动轮询」后存档的提示 key（等价于调用方存下的 lastKey） */
const rememberedKey = (state: BalanceState): string | null => decideBalanceNotice(state, null, false).key;

const unsupported: BalanceState = { provider: 'unregistered-provider', ok: false, reason: 'unsupported' };

describe('balanceBubbleView —— 不可用状态必须给出可读的文字说明', () => {
  test('unsupported：报出「不支持」+ 当前服务商 id（便于自查到底是谁）', () => {
    assert.deepEqual(balanceBubbleView(unsupported), [
      { role: 'error', text: '当前服务商暂不支持余额查询' },
      { role: 'sub', text: '当前服务商：unregistered-provider' },
    ]);
  });

  test('credential-missing：host 的 message 已带前缀，不再叠加（无双重「缺少凭证」）', () => {
    const rows = balanceBubbleView({
      provider: 'deepseek-official',
      ok: false,
      reason: 'credential-missing',
      message: '缺少凭证 DEEPSEEK_API_KEY',
    });
    assert.deepEqual(rows, [
      { role: 'error', text: '缺少余额查询凭证' },
      { role: 'sub', text: '缺少凭证 DEEPSEEK_API_KEY' },
    ]);
    assert.equal(
      rows.filter((r) => r.text.includes('缺少凭证')).length,
      1,
      '「缺少凭证」只应出现一次（曾经是「缺少凭证：缺少凭证 X」）',
    );
  });

  test('fetch-error：主行固定文案 + 次要行为底层错误；message 缺失时不留空行', () => {
    assert.deepEqual(
      balanceBubbleView({ provider: 'deepseek-official', ok: false, reason: 'fetch-error', message: 'HTTP 401' }),
      [
        { role: 'error', text: '余额查询失败' },
        { role: 'sub', text: 'HTTP 401' },
      ],
    );
    assert.deepEqual(balanceBubbleView({ provider: 'deepseek-official', ok: false, reason: 'fetch-error' }), [
      { role: 'error', text: '余额查询失败' },
    ]);
  });

  test('成功路径不受影响（opencode 两行 / deepseek 单行含峰谷档位）', () => {
    // 取三窗口里最紧迫（剩余最少）的那个：weekly 75% 剩余 7.5 USD 最少 → 「周额度已用 75%」
    const rows = balanceBubbleView({
      provider: 'opencode-go',
      ok: true,
      shape: 'windows',
      rolling: 10,
      rollingCapUsd: 12,
      weekly: 75,
      weeklyCapUsd: 30,
      monthly: 20,
      monthlyCapUsd: 60,
      rollingLabel: '5h',
    });
    assert.equal(rows[0]?.text, '周额度已用 75%');
    assert.equal(rows[1]?.role, 'sub');

    const ds = balanceBubbleView({
      provider: 'deepseek-official',
      ok: true,
      shape: 'money',
      wallets: [{ currency: 'CNY', total: '8.79', granted: '0.00', toppedUp: '8.79' }],
      tier: 'idle',
    });
    assert.equal(ds[0]?.text, '余额（');
    assert.equal(ds[1]?.role, 'tier'); // 峰/谷由数据带出，这里只钉结构与金额
    assert.equal(ds[2]?.text, '）¥8.79');
  });

  test('money：服务商没给档位装饰时不编峰谷，退化成「余额 ¥x.xx」', () => {
    const rows = balanceBubbleView({
      provider: 'some-wallet',
      ok: true,
      shape: 'money',
      wallets: [{ currency: 'CNY', total: '8.79', granted: '0.00', toppedUp: '8.79' }],
    });
    assert.deepEqual(rows, [{ role: 'label', text: '余额 ¥8.79' }]);
  });

  test('windows：滚动窗展示名由数据带出，缺省回落 5h', () => {
    const base = {
      provider: 'some-windows',
      shape: 'windows' as const,
      ok: true as const,
      rolling: 10,
      monthly: 1,
      monthlyResetsAt: '2999-01-01T00:00:00.000Z',
    };
    assert.equal(urgentWindow(base)?.label, '5h', '缺 rollingLabel → 回落 5h');
    assert.equal(urgentWindow({ ...base, rollingLabel: '24h' })?.label, '24h', '数据自报的窗口名优先');
  });

  test('deepseek-account 与 deepseek-official 气泡完全同构，只有币种符号按 currency 变', () => {
    // 官方路由：CNY → ¥（现有行为，逐字不变）
    const official = balanceBubbleView({
      provider: 'deepseek-official',
      ok: true,
      shape: 'money',
      wallets: [{ currency: 'CNY', total: '8.79', granted: '0.00', toppedUp: '8.79' }],
      tier: 'idle',
    });
    // 账号路由：同一 shape、同一结构
    const account = balanceBubbleView({
      provider: 'deepseek-account',
      ok: true,
      shape: 'money',
      wallets: [{ currency: 'CNY', total: '9.99', granted: '0.00', toppedUp: '9.99' }],
      tier: 'idle',
    });
    assert.deepEqual(
      account.map((r) => r.role),
      official.map((r) => r.role),
      '两端的行结构必须逐位一致',
    );
    assert.equal(account[0]?.text, '余额（');
    assert.equal(account[2]?.text, '）¥9.99');

    // USD 钱包：同一位置换成 $（其余逐字不变）
    const usd = balanceBubbleView({
      provider: 'deepseek-account',
      ok: true,
      shape: 'money',
      wallets: [{ currency: 'USD', total: '12.50', granted: '0.00', toppedUp: '12.50' }],
      tier: 'idle',
    });
    assert.equal(usd[2]?.text, '）$12.50');
  });
});

describe('decideBalanceNotice —— 弹不弹文字说明（两端共用同一份判定）', () => {
  test('ok 状态：不弹，并把 key 清零（下次不可用视为新原因）', () => {
    assert.deepEqual(
      decideBalanceNotice(
        { provider: 'opencode-go', ok: true, shape: 'windows', rolling: 1, weekly: 2, monthly: 3 },
        'unsupported:unregistered-provider',
        false,
      ),
      { show: false, key: null },
    );
  });

  test('自动轮询：首次不可用要弹（lastKey=null），同一原因再来一次不弹', () => {
    const first = decideBalanceNotice(unsupported, null, false);
    assert.deepEqual(first, { show: true, key: 'unsupported:unregistered-provider' });
    assert.equal(decideBalanceNotice(unsupported, first.key, false).show, false, '同一原因不重复打扰');
  });

  test('自动轮询：原因变化再弹一次；换了另一个未登记的服务商也算变化', () => {
    assert.equal(decideBalanceNotice(unsupported, 'credential-missing:deepseek-official', false).show, true);
    assert.equal(
      decideBalanceNotice(
        { provider: 'openrouter', ok: false, reason: 'unsupported' },
        rememberedKey(unsupported),
        false,
      ).show,
      true,
    );
  });

  test('显式请求（/balance、桌面「查看余额」）：一律弹，不受去重影响', () => {
    assert.equal(decideBalanceNotice(unsupported, rememberedKey(unsupported), true).show, true);
  });
});

describe('源码守卫 —— 不可用状态不得再被静默丢掉', () => {
  test('浏览器 overlay：渲染处不许再要求 balance.ok，且由 noticeTick 驱动气泡、判定来自 shared', () => {
    // 渲染入口与指令处理分处两个文件：气泡在 pet.ts，按 tick 弹的判定在 card/cue-effects.ts。
    const clientPet = readSource('../client/pet.ts') + '\n' + readSource('../client/pet/card/cue-effects.ts');
    assert.ok(
      !/balance\.ok\s*&&\s*cfg\.balanceEnabled/.test(clientPet),
      '余额气泡不得再要求 balance.ok：那是「未登记服务商完全没反应」的根因，文字说明走同一个气泡',
    );
    assert.ok(/balanceNoticeTick/.test(clientPet), '容器必须把「该提示不可用原因」传给各宠物');
    assert.ok(/decideBalanceNotice/.test(clientPet), '弹窗判定必须来自 src/shared（两端同一份），不得各写一份');
  });

  test('桌面外壳：同一条判定 + 不可用也走气泡渲染（不再只写 console）', () => {
    const events = readSource('../../runtime/electron-helper/events.js');
    // 宠物本体已按职责拆成 sprite.js 与 sprite-*.js：守卫要读全份，否则文件一搬就误报
    const sprite = [
      readSource('../../runtime/electron-helper/sprite.js'),
      ...readdirSync(fileURLToPath(new URL('../../runtime/electron-helper/sprite/', import.meta.url))).map((name) =>
        readSource('../../runtime/electron-helper/sprite/' + name),
      ),
    ].join('\n');
    assert.ok(
      /S\.decideBalanceNotice/.test(events),
      '桌面轮询必须调用同一份判定（shared-core 的 S.decideBalanceNotice）',
    );
    assert.ok(
      /showBalanceNotice/.test(events) && /showBalanceNotice/.test(sprite),
      '桌面必须有不可用的气泡渲染路径（showBalanceNotice），不能只 console.error',
    );
  });
});

describe('commandcode —— 三窗口用量走与 opencode 同一套展示口径', () => {
  test('toBalanceState：真实叶子 → 视图（cap 与重置时间一并带过来）', () => {
    const s = toBalanceState({
      ok: true,
      provider: 'commandcode',
      shape: 'windows',
      data: {
        monthly: 30,
        monthlyCapUsd: 70,
        monthlyResetsAt: '2026-10-13T01:01:27.000Z',
        rolling: 10,
        rollingCapUsd: 14,
        weekly: 75,
        weeklyCapUsd: 35,
      },
    });
    assert.ok(s && s.ok, 'commandcode 叶子必须解析出可用视图');
    if (!s || !s.ok) throw new Error('unreachable');
    assert.equal(s.shape, 'windows');
    assert.equal(s.monthly, 30);
    assert.equal(s.monthlyCapUsd, 70);
    assert.equal(s.monthlyResetsAt, '2026-10-13T01:01:27.000Z');
    assert.equal(s.rolling, 10);
    assert.equal(s.rollingCapUsd, 14);
    assert.equal(s.weekly, 75);
    assert.equal(s.weeklyCapUsd, 35);
    assert.equal(s.rollingResetsAt, undefined);
  });

  test('无窗口限制时只带月度窗（不补 0）：百分比与气泡都只说月度', () => {
    const view: BalanceView = {
      provider: 'commandcode',
      shape: 'windows',
      ok: true,
      monthly: 40,
      monthlyCapUsd: 70,
      monthlyResetsAt: '2999-01-01T00:00:00.000Z',
    };
    assert.equal(balancePercent(view), 40);
    const rows = balanceBubbleView(view);
    assert.equal(rows[0]?.text, '月额度已用 40%');
    assert.equal(rows[1]?.role, 'sub');
  });

  test('月度窗缺失 / 出现的字段非法 → null（不把 NaN 送进展示层）', () => {
    const leaf = (data: Record<string, unknown>) => ({
      ok: true,
      provider: 'commandcode',
      shape: 'windows',
      data,
    });
    assert.equal(toBalanceState(leaf({ rolling: 10 })), null, '缺月度窗 = 认不出响应');
    assert.equal(toBalanceState(leaf({ monthly: 'x' })), null);
    assert.equal(toBalanceState(leaf({ monthly: 10, rolling: 'x' })), null, '5h 窗出现但非法 → 整拍跳过');
    assert.equal(toBalanceState(leaf({ monthly: 10, monthlyCapUsd: 'x' })), null);
  });

  test('告急窗口：满额度齐全 → 绝对口径（剩余额度最少者），与 opencode 同一规则', () => {
    // 5h 剩 12.6 / 周 剩 8.75 / 月 剩 56（USD）→ 周最告急
    const rows = balanceBubbleView({
      provider: 'commandcode',
      shape: 'windows',
      ok: true,
      rolling: 10,
      rollingCapUsd: 14,
      weekly: 75,
      weeklyCapUsd: 35,
      monthly: 20,
      monthlyCapUsd: 70,
    });
    assert.equal(rows[0]?.text, '周额度已用 75%');
  });

  test('告急窗口：有窗口给不出满额度 → 退化为百分比口径（不硬比绝对剩余）', () => {
    // 月度池为 0（无额度、无消耗）时算不出 cap：此时 5h 10% 只剩 12.6 USD，比周 50% 的 17.5 USD 更"少"，
    // 但硬按绝对口径会报「5h 已用 10%」——规则是缺额度就走百分比：周 50% 更告急
    const rows = balanceBubbleView({
      provider: 'commandcode',
      shape: 'windows',
      ok: true,
      rolling: 10,
      rollingCapUsd: 14,
      weekly: 50,
      weeklyCapUsd: 35,
      monthly: 0,
    });
    assert.equal(rows[0]?.text, '周额度已用 50%');
  });

  test('balancePercent：三窗口取最大（档位动画与 opencode 同一条数学）', () => {
    assert.equal(
      balancePercent({ provider: 'commandcode', shape: 'windows', ok: true, rolling: 10, weekly: 75, monthly: 20 }),
      75,
    );
  });

  test('区间用量：五个数齐全 → usage 进入视图（页数随之变三页）', () => {
    const usage = {
      totalTokens: 95967948,
      inputTokens: 95489675,
      outputTokens: 478273,
      requests: 745,
      spentUsd: 1.5968,
    };
    const s = toBalanceState({
      ok: true,
      provider: 'commandcode',
      shape: 'windows',
      data: { monthly: 2, usage },
    });
    assert.ok(s && s.ok, '带用量的叶子仍然必须是可用视图');
    if (!s || !s.ok) throw new Error('unreachable');
    assert.deepEqual(s.usage, usage);
    assert.equal(balancePageCount(s), 3, '有用量就多一页');
  });

  test('区间用量：缺字段或非法 → 整拍跳过（不拼半份用量页）', () => {
    const leaf = (usage: unknown) => ({
      ok: true,
      provider: 'commandcode',
      shape: 'windows',
      data: { monthly: 50, usage },
    });
    assert.equal(
      toBalanceState(leaf({ totalTokens: 1, inputTokens: 1, outputTokens: 0, requests: 1 })),
      null,
      '缺 spentUsd = 字段不全',
    );
    assert.equal(
      toBalanceState(leaf({ totalTokens: 'x', inputTokens: 1, outputTokens: 0, requests: 1, spentUsd: 0 })),
      null,
      '出现但非法',
    );
    assert.equal(toBalanceState(leaf('nope')), null, '不是对象');
    const noUsage = toBalanceState({ ok: true, provider: 'opencode-go', shape: 'windows', data: { monthly: 5 } });
    assert.ok(noUsage && noUsage.ok);
    if (!noUsage || !noUsage.ok) throw new Error('unreachable');
    assert.equal(noUsage.usage, undefined, '没这项数据的服务商不带 usage');
    assert.equal(balancePageCount(noUsage), 2);
  });

  test('第三页：一行 usage 承载整张卡（三行两列 + 进出比例），紧凑数字固定一位小数', () => {
    const rows = balancePageView(
      {
        provider: 'commandcode',
        shape: 'windows',
        ok: true,
        monthly: 2,
        usage: {
          totalTokens: 95967948,
          inputTokens: 95489675,
          outputTokens: 478273,
          requests: 745,
          spentUsd: 1.5968,
        },
      },
      2,
    );
    const [row] = rows;
    assert.equal(row?.role, 'usage', '第三页只出这一行');
    if (!row || row.role !== 'usage') throw new Error('unreachable');
    assert.equal(row.total, '96.0M');
    assert.equal(row.input, '95.5M 入');
    assert.equal(row.output, '478.3K 出');
    assert.equal(row.period, '本期 745 次');
    assert.equal(row.spend, '$1.60');
    assert.equal(row.inputPercent, (95489675 / (95489675 + 478273)) * 100, '比例条用真实占比，不做最小宽度放大');
    // 比例条之外仍有纯文本兜底，不认识 usage 的消费方也能读。
    assert.equal(row.text, 'Token 96.0M · 95.5M 入 / 478.3K 出 · 本期 745 次 · $1.60');
  });

  test('第一页仍是收起态、第二页仍是窗口明细（新增页不挤掉原有两页）', () => {
    const view: BalanceView = {
      provider: 'commandcode',
      shape: 'windows',
      ok: true,
      rolling: 10,
      rollingCapUsd: 14,
      monthly: 20,
      monthlyCapUsd: 70,
      usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0, requests: 1, spentUsd: 0.1 },
    };
    assert.equal(balancePageView(view, 0)[0]?.text, '5h额度已用 10%');
    assert.equal(balancePageView(view, 1)[0]?.role, 'quota');
  });
});

describe('money —— 档位基准由数据带出（展示层不再写死任何服务商的额度）', () => {
  const view = (fullBalance?: string, total = '10.00'): BalanceView => ({
    provider: 'some-wallet',
    shape: 'money',
    ok: true,
    wallets: [
      {
        currency: 'CNY',
        total,
        granted: '0.00',
        toppedUp: total,
        ...(fullBalance === undefined ? {} : { fullBalance }),
      },
    ],
  });

  test('基准 20：余额 20 → 0%，10 → 50%，0 → 100%，负数按已用完', () => {
    assert.equal(balancePercent(view('20', '20.00')), 0);
    assert.equal(balancePercent(view('20', '10.00')), 50);
    assert.equal(balancePercent(view('20', '0.00')), 100);
    assert.equal(balancePercent(view('20', '-0.02')), 100, '透支与 0 等价');
  });

  test('基准换一个值：同一余额算出不同百分比（证明基准真的来自数据）', () => {
    assert.equal(balancePercent(view('10', '5.00')), 50);
    assert.equal(balancePercent(view('100', '5.00')), 95);
  });

  test('没有基准 / 基准非法 / 金额非法 → undefined（不播档位动画，不替服务商猜）', () => {
    assert.equal(balancePercent(view(undefined)), undefined);
    assert.equal(balancePercent(view('0')), undefined);
    assert.equal(balancePercent(view('-5')), undefined);
    assert.equal(balancePercent(view('abc')), undefined);
    assert.equal(balancePercent(view('20', 'abc')), undefined);
  });

  test('多币种：各币种按自己的基准算剩余比例再叠加（不需要汇率）', () => {
    const multi = (cny: string, usd: string): BalanceView => ({
      provider: 'deepseek-account',
      shape: 'money',
      ok: true,
      wallets: [
        { currency: 'CNY', total: cny, granted: '0.00', toppedUp: cny, fullBalance: '20' },
        { currency: 'USD', total: usd, granted: '0.00', toppedUp: usd, fullBalance: '5' },
      ],
    });
    // 100 − 100×(8.16/20 + 0/5) = 59.2（二进制浮点会有尾差，比到 1e-9）
    const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-9;
    assert.ok(near(balancePercent(multi('8.16', '0.00')), 59.2), String(balancePercent(multi('8.16', '0.00'))));
    // 100 − 100×(8.16/20 + 5/5) = −40.8 → 夹到 0（美元满额把消耗抵掉了）
    assert.equal(balancePercent(multi('8.16', '5.00')), 0);
    // 两个都空 → 100
    assert.equal(balancePercent(multi('0.00', '0.00')), 100);
    // 一个币种没有基准 → 它不参与，只按有的那个算
    const partial: BalanceView = {
      provider: 'x',
      shape: 'money',
      ok: true,
      wallets: [{ currency: 'JPY', total: '100', granted: '0.00', toppedUp: '100' }],
    };
    assert.equal(balancePercent(partial), undefined, '全都没有基准 → 不播档位');
  });

  test('toBalanceState：money 叶子带出钱包数组与档位装饰；非法档位值视为没给', () => {
    const s = toBalanceState({
      ok: true,
      provider: 'some-wallet',
      shape: 'money',
      data: {
        wallets: [{ currency: 'CNY', total: '8.79', granted: '1.00', toppedUp: '7.79', fullBalance: '20' }],
        tier: 'peak',
      },
    });
    assert.ok(s && s.ok && s.shape === 'money');
    assert.deepEqual(s.wallets, [
      { currency: 'CNY', total: '8.79', granted: '1.00', toppedUp: '7.79', fullBalance: '20' },
    ]);
    assert.equal(s.tier, 'peak');

    const bad = toBalanceState({
      ok: true,
      provider: 'some-wallet',
      shape: 'money',
      data: { wallets: [{ currency: 'CNY', total: '8.79', fullBalance: 20 }], tier: '???' },
    });
    assert.ok(bad && bad.ok && bad.shape === 'money');
    assert.equal(bad.tier, undefined, '不认识的档位值 → 不渲染峰谷');
    assert.equal(bad.wallets?.[0]?.fullBalance, undefined, '非字符串基准 → 视为没给');
    assert.equal(bad.wallets?.[0]?.granted, '0.00', '缺分项 → 记 0.00');
  });

  test('toBalanceState：wallets 为空/结构非法 → null（认不出响应，不渲染这一拍）', () => {
    assert.equal(toBalanceState({ ok: true, provider: 'x', shape: 'money', data: { wallets: [] } }), null);
    assert.equal(toBalanceState({ ok: true, provider: 'x', shape: 'money', data: {} }), null);
    assert.equal(
      toBalanceState({ ok: true, provider: 'x', shape: 'money', data: { wallets: [{ total: '8.79' }] } }),
      null,
      '缺 currency 的项被丢弃，丢光就是认不出',
    );
  });
});

describe('points 形态 —— 积分/点数余额（非货币）', () => {
  const leaf = (data: Record<string, unknown>) => ({
    ok: true,
    provider: 'local-gateway',
    shape: 'points',
    data,
  });

  test('toBalanceState：unit + total 必有，full 可选', () => {
    const s = toBalanceState(leaf({ unit: '积分', total: '800', full: '1000' }));
    assert.ok(s && s.ok && s.shape === 'points');
    assert.deepEqual(s.points, { unit: '积分', total: '800', full: '1000' });

    const noFull = toBalanceState(leaf({ unit: '点数', total: '0' }));
    assert.ok(noFull && noFull.ok && noFull.shape === 'points');
    assert.equal(noFull.points?.full, undefined, '没给基准 → 不参与档位折算');
    assert.equal(noFull.points?.total, '0', '0 是合法余额，不像 0 元那样被过滤');

    const emptyFull = toBalanceState(leaf({ unit: '积分', total: '800', full: '' }));
    assert.ok(emptyFull && emptyFull.ok && emptyFull.shape === 'points');
    assert.equal(emptyFull.points?.full, undefined, '空串基准 → 视为没给');
  });

  test('toBalanceState：缺 unit / total → null（认不出，不渲染这一拍）', () => {
    assert.equal(toBalanceState(leaf({ total: '800' })), null, '缺 unit = 拼不出「800 积分」');
    assert.equal(toBalanceState(leaf({ unit: '积分' })), null, '缺 total = 没有数字可展示');
    assert.equal(toBalanceState(leaf({ unit: '', total: '800' })), null);
    assert.equal(toBalanceState(leaf({ unit: '积分', total: '' })), null);
    assert.equal(toBalanceState({ ok: true, provider: 'x', shape: 'points' }), null, '缺 data 段');
  });

  test('balancePercent：按 points.full 折算；没有基准 → undefined（不播档位）', () => {
    const view = (total: string, full?: string): BalanceView => ({
      provider: 'local-gateway',
      shape: 'points',
      ok: true,
      points: { unit: '积分', total, full },
    });
    assert.equal(balancePercent(view('1000', '1000')), 0);
    assert.equal(balancePercent(view('800', '1000')), 20);
    assert.equal(balancePercent(view('0', '1000')), 100);
    assert.equal(balancePercent(view('1200', '1000')), 0, '超出基准 → 夹到 0');
    assert.equal(balancePercent(view('-50', '1000')), 100, '负数与 0 等价');
    assert.equal(balancePercent(view('800')), undefined, '没有基准 → 不播档位');
    assert.equal(balancePercent(view('800', '0')), undefined, '基准为 0 → 不折算');
    assert.equal(balancePercent(view('abc', '1000')), undefined, '非法数字 → 不播');
  });

  test('balanceBubbleView：一行「余额 800 积分」，不套货币符号', () => {
    assert.deepEqual(
      balanceBubbleView({
        provider: 'local-gateway',
        shape: 'points',
        ok: true,
        points: { unit: '积分', total: '800', full: '1000' },
      }),
      [{ role: 'label', text: '余额 800 积分' }],
    );
    // 单位换了也不会退化成 ¥
    assert.deepEqual(
      balanceBubbleView({
        provider: 'local-gateway',
        shape: 'points',
        ok: true,
        points: { unit: '点数', total: '12' },
      }),
      [{ role: 'label', text: '余额 12 点数' }],
    );
  });

  test('balanceDetailView / urgentWindow：points 没有窗口可展开、没有告急窗口', () => {
    const view: BalanceView = {
      provider: 'local-gateway',
      shape: 'points',
      ok: true,
      points: { unit: '积分', total: '800', full: '1000' },
    };
    assert.deepEqual(balanceDetailView(view), balanceBubbleView(view), '展开态与收起态一致');
    assert.equal(urgentWindow(view), undefined, '积分没有「最紧迫窗口」');
  });
});

/**
 * custom 形态（第三方自定义节点树）的契约测试。
 *
 * 为什么这些断言重要：节点树是外部输入，解析层是唯一一道防线（渲染器不做二次校验）。
 * 这里钉住四件事：白名单裁剪、容量上限、失败即整拍跳过（不画缺块的树）、以及"行数据通道为空"
 * —— 后者保证两端渲染入口必须走 tree 分支，不会误渲染成空气泡而不自知。
 */
describe('custom 形态 —— 第三方自定义气泡（节点树）', () => {
  const leaf = (data: Record<string, unknown>): unknown => ({
    ok: true,
    provider: 'weird-provider',
    shape: 'custom',
    data,
  });
  const customOf = (raw: unknown): CustomBalance | undefined => {
    const s = toBalanceState(raw);
    return s && s.ok && s.shape === 'custom' ? s.custom : undefined;
  };
  const twoSpans = (): Record<string, unknown> => ({
    tag: 'div',
    style: { display: 'flex', gap: '4px' },
    children: [
      { tag: 'span', text: '额度', style: { color: '#666' } },
      { tag: 'b', text: '8.16' },
    ],
  });

  test('合法树原样解析：tag / 文本 / 样式 / 子节点全部保留', () => {
    assert.deepEqual(customOf(leaf({ rows: twoSpans() }))?.views[0], {
      tag: 'div',
      style: { display: 'flex', gap: '4px' },
      children: [
        { tag: 'span', text: '额度', style: { color: '#666' } },
        { tag: 'b', text: '8.16' },
      ],
    });
  });

  test('views 多页：按顺序保留；多于 1 页才可点（一页不可点）', () => {
    const three = customOf(
      leaf({ views: [twoSpans(), { tag: 'div', text: '第二页' }, { tag: 'div', text: '第三页' }] }),
    );
    assert.equal(three?.views.length, 3);
    assert.equal(three?.views[1]?.text, '第二页');
    assert.equal(three?.views[2]?.text, '第三页');

    const multi = toBalanceState(leaf({ views: [twoSpans(), twoSpans()] }))!;
    assert.equal(customClickable(multi), true, '两页可点');
    assert.equal(customClickable(toBalanceState(leaf({ rows: twoSpans() }))!), false, '一页不可点');
  });

  test('views 与 rows/detailRows 同时给：views 优先（老字段只作兼容）', () => {
    const v = customOf(
      leaf({
        views: [{ tag: 'div', text: '新' }],
        rows: { tag: 'div', text: '旧' },
        detailRows: { tag: 'div', text: '旧2' },
      }),
    );
    assert.equal(v?.views.length, 1);
    assert.equal(v?.views[0]?.text, '新');
  });

  test('页数超过上限 → null；正好上限 → 通过', () => {
    const pages = Array.from({ length: CUSTOM_LIMITS.maxViews + 1 }, () => ({ tag: 'div', text: 'x' }));
    assert.equal(toBalanceState(leaf({ views: pages })), null);
    assert.ok(customOf(leaf({ views: pages.slice(0, CUSTOM_LIMITS.maxViews) })));
  });

  test('老两页写法（rows + detailRows）等价于 views: [rows, detailRows]', () => {
    const legacy = customOf(leaf({ rows: twoSpans(), detailRows: { tag: 'div', text: '第二页' } }));
    assert.equal(legacy?.views.length, 2);
    assert.equal(legacy?.views[1]?.text, '第二页');
    assert.equal(toBalanceState(leaf({ rows: twoSpans(), detailRows: { tag: 'script' } })), null);
  });

  test('img 节点只认 http/https（file: 等本地协议整树作废）', () => {
    assert.equal(
      customOf(leaf({ views: [{ tag: 'div', children: [{ tag: 'img', src: 'https://cdn.example/a.png' }] }] }))
        ?.views[0]?.children?.[0]?.src,
      'https://cdn.example/a.png',
    );
    assert.equal(toBalanceState(leaf({ views: [{ tag: 'img', src: 'file:///C:/secret.png' }] })), null);
  });

  test('样式只留下白名单键；外部资源 / 表达式 / 超长值被丢，且不影响其余样式', () => {
    const style = customOf(
      leaf({
        views: [
          {
            tag: 'div',
            style: {
              color: '#123456',
              gap: '4px',
              position: 'absolute', // 白名单外：能让内容跑出气泡
              background: 'url(https://tracker.example/x.png)', // 外部资源引用
              width: 'expression(alert(1))', // 表达式
              fontSize: 'x'.repeat(CUSTOM_LIMITS.maxStyleValue + 1), // 超长
            },
          },
        ],
      }),
    )?.views[0]?.style;
    assert.deepEqual(style, { color: '#123456', gap: '4px' });
  });

  test('文本超长按上限截断（内容仍可读，不整树作废）', () => {
    const text = customOf(leaf({ views: [{ tag: 'span', text: 'x'.repeat(500) }] }))?.views[0]?.text;
    assert.equal(text?.length, CUSTOM_LIMITS.maxText);
  });

  test('非白名单 tag → null（整拍跳过，绝不画一棵缺块的树）', () => {
    assert.equal(toBalanceState(leaf({ views: [{ tag: 'script', text: 'alert(1)' }] })), null);
    assert.equal(toBalanceState(leaf({ views: [{ tag: 'div', children: [{ tag: 'iframe' }] }] })), null);
    assert.equal(toBalanceState(leaf({ rows: { tag: 'script', text: 'alert(1)' } })), null, '老写法同样受白名单约束');
  });

  test('任一页非法 → null（不做「前几页正常、翻到后面崩」的半坏状态）', () => {
    assert.equal(toBalanceState(leaf({ views: [twoSpans(), { tag: 'script' }] })), null);
    assert.ok(customOf(leaf({ views: [twoSpans(), twoSpans()] })));
  });

  test('子节点数 / 树深 / 全树节点数超限 → null', () => {
    const many = Array.from({ length: CUSTOM_LIMITS.maxChildren + 1 }, () => ({ tag: 'span', text: 'x' }));
    assert.equal(toBalanceState(leaf({ views: [{ tag: 'div', children: many }] })), null);

    // 嵌套到深度上限以外（根为 0，第 maxDepth 层即非法）
    let deep: Record<string, unknown> = { tag: 'span', text: 'x' };
    for (let i = 0; i < CUSTOM_LIMITS.maxDepth; i++) deep = { tag: 'div', children: [deep] };
    assert.equal(toBalanceState(leaf({ views: [deep] })), null);

    // 1 + 24 + 576 > maxNodes（每层都没超 maxChildren，但总量超了）
    const grandchildren = Array.from({ length: CUSTOM_LIMITS.maxChildren }, () => ({ tag: 'span', text: 'x' }));
    const huge = Array.from({ length: CUSTOM_LIMITS.maxChildren }, () => ({
      tag: 'div',
      children: grandchildren,
    }));
    assert.equal(toBalanceState(leaf({ views: [{ tag: 'div', children: huge }] })), null);
  });

  test('percent：夹到 0-100；非数字 → 不播档位动画（undefined）', () => {
    assert.equal(customOf(leaf({ rows: twoSpans(), percent: 140 }))?.percent, 100);
    assert.equal(customOf(leaf({ rows: twoSpans(), percent: -5 }))?.percent, 0);
    assert.equal(customOf(leaf({ rows: twoSpans(), percent: 'abc' }))?.percent, undefined);
    assert.equal(
      balancePercent({ provider: 'p', shape: 'custom', ok: true, custom: { views: [{ tag: 'div' }] } }),
      undefined,
    );
    assert.equal(
      balancePercent({ provider: 'p', shape: 'custom', ok: true, custom: { views: [{ tag: 'div' }], percent: 40 } }),
      40,
    );
  });

  test('行数据通道为空：balanceBubbleView 对 custom 返回 []（渲染入口必须走树）', () => {
    const state = toBalanceState(leaf({ views: [twoSpans()] }))!;
    assert.deepEqual(balanceBubbleView(state), []);
    assert.deepEqual(balanceDetailView(state), []);
    // 唯有树访问器拿得到内容，两端渲染入口据此判断
    assert.equal(customViews(state)?.length, 1);
    assert.equal(customClickable(state), false, '只有一页 = 不可点');
  });

  test('customViews / customClickable：只对 custom 且 ok 的状态有值', () => {
    const state = toBalanceState(leaf({ views: [twoSpans(), twoSpans()] }))!;
    assert.equal(customViews(state)?.length, 2);
    assert.equal(customClickable(state), true);
    assert.equal(customViews(unsupported), undefined, '不可用状态没有树');
    assert.equal(
      customViews({
        provider: 'p',
        shape: 'money',
        ok: true,
        wallets: [{ currency: 'CNY', total: '1', granted: '0', toppedUp: '0' }],
      }),
      undefined,
      '内置形态没有树',
    );
  });
});

describe('balanceBubbleView —— ru 走固定文案目录', () => {
  test('windows 收起态与不可用说明为俄文', async () => {
    const { setHostLocale, resetHostLocale } = await import('../locale/current.ts');
    setHostLocale('ru');
    try {
      assert.deepEqual(balanceBubbleView(unsupported), [
        { role: 'error', text: 'Этот провайдер не поддерживает запрос баланса' },
        { role: 'sub', text: 'Провайдер: unregistered-provider' },
      ]);
      const rows = balanceBubbleView({
        provider: 'opencode-go',
        shape: 'windows',
        ok: true,
        weekly: 75,
        weeklyCapUsd: 30,
        monthly: 10,
        monthlyCapUsd: 70,
      });
      assert.match(rows[0]?.text ?? '', /^нед\.: использовано 75%$/);
    } finally {
      resetHostLocale();
    }
  });
});
