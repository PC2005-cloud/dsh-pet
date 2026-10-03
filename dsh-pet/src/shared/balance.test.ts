/**
 * 余额「不可用」路径的契约测试：**必须有可见反馈**，且两端（浏览器 overlay / 桌面外壳）只走一份判定。
 *
 * 背景：`/dsh-pet-7340/balance` 对未登记的服务商返回 `{ ok:false, reason:'unsupported' }`（HTTP 200），
 * 客户端原本在渲染处硬性要求 `balance.ok`，且气泡只由「拉取成功」的 tick 驱动——于是未登记的服务商
 * （如 commandcode）**页面上完全没有任何反应**：不播动画、不弹气泡、连 console 都特意不打。
 * 现在改为：不可用时弹「文字说明」气泡；弹不弹由 src/shared 的 decideBalanceNotice 统一判定
 * （显式请求必弹；自动轮询仅在原因变化时弹一次），两端各自只负责把行数据画出来。
 *
 * 本文件把三件事钉住：
 *   ① 不可用状态的文案（含 provider/凭证名，且不留空行、不出现双重「缺少凭证」前缀）；
 *   ② 弹窗判定（显式 vs 自动、原因变化、ok 状态清零）；
 *   ③ 源码级守卫——客户端渲染不得再要求 balance.ok（有 React/DOM 依赖，只能读源码断言）。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { balanceBubbleView, decideBalanceNotice, formatBalanceText, type BalanceState } from './balance.ts';

/** 包内文件源码（守卫用；相对 src/shared/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 一次「自动轮询」后存档的提示 key（等价于调用方存下的 lastKey） */
const rememberedKey = (state: BalanceState): string | null => decideBalanceNotice(state, null, false).key;

const unsupported: BalanceState = { provider: 'commandcode', ok: false, reason: 'unsupported' };

describe('balanceBubbleView —— 不可用状态必须给出可读的文字说明', () => {
  test('unsupported：报出「不支持」+ 当前服务商 id（便于自查到底是谁）', () => {
    assert.deepEqual(balanceBubbleView(unsupported), [
      { role: 'error', text: '当前服务商暂不支持余额查询' },
      { role: 'sub', text: '当前服务商：commandcode' },
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
      kind: 'opencode',
      rolling: 10,
      weekly: 75,
      monthly: 20,
    });
    assert.equal(rows[0]?.text, '周额度已用 75%');
    assert.equal(rows[1]?.role, 'sub');

    const ds = balanceBubbleView({ provider: 'deepseek-official', ok: true, kind: 'deepseek', total: '8.79' });
    assert.equal(ds[0]?.text, '余额（');
    assert.equal(ds[1]?.role, 'tier'); // 峰/谷随时间变化，这里只钉结构与金额
    assert.equal(ds[2]?.text, '）¥8.79');
  });
});

describe('formatBalanceText —— 金额展示（两位小数 + 千位分隔，长金额塞得进气泡）', () => {
  test('账号态浮点长尾：两位小数（鲸鱼挂件同口径）', () => {
    // 账号态 total 是「充值 + 赠金」两个浮点数相加的结果，原样打印会带长尾
    assert.equal(formatBalanceText('13.9468696'), '13.95');
    assert.equal(formatBalanceText(13.9468696), '13.95');
    // 现场实测值（0.3.2 账号态）：两端都不该出现 8 位小数
    assert.equal(formatBalanceText('13.48241956'), '13.48');
  });

  test('千位分隔：大额也不会把气泡顶出宠物宽度', () => {
    assert.equal(formatBalanceText('1234567.891'), '1,234,567.89');
    assert.equal(formatBalanceText('1000'), '1,000.00');
  });

  test('边界：零、负值（透支）、极小额', () => {
    assert.equal(formatBalanceText('0'), '0.00');
    assert.equal(formatBalanceText('0.004'), '0.00'); // 四舍五入到分
    assert.equal(formatBalanceText('-0.02'), '-0.02'); // 透支保留符号，不吞成 0
  });

  test('无法解析时原样回落，绝不把已有内容吞成 "-"', () => {
    assert.equal(formatBalanceText(undefined), '-');
    assert.equal(formatBalanceText(null), '-');
    assert.equal(formatBalanceText(''), '-');
    // 非数字：原样回显（比伪装成 0 或 '-' 更诚实，也与旧行为一致）
    assert.equal(formatBalanceText('n/a'), 'n/a');
  });

  test('余额行整体渲染：金额已格式化', () => {
    const rows = balanceBubbleView({
      provider: 'deepseek-account',
      ok: true,
      kind: 'deepseek',
      total: '13.9468696',
    });
    assert.equal(rows[2]?.text, '）¥13.95');
    // 旧行为回归守卫：不得再出现未格式化的长尾
    assert.equal(
      rows.some((r) => r.text.includes('13.9468696')),
      false,
    );
  });
});

describe('decideBalanceNotice —— 弹不弹文字说明（两端共用同一份判定）', () => {
  test('ok 状态：不弹，并把 key 清零（下次不可用视为新原因）', () => {
    assert.deepEqual(
      decideBalanceNotice(
        { provider: 'opencode-go', ok: true, kind: 'opencode', rolling: 1, weekly: 2, monthly: 3 },
        'unsupported:commandcode',
        false,
      ),
      { show: false, key: null },
    );
  });

  test('自动轮询：首次不可用要弹（lastKey=null），同一原因再来一次不弹', () => {
    const first = decideBalanceNotice(unsupported, null, false);
    assert.deepEqual(first, { show: true, key: 'unsupported:commandcode' });
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
    const clientPet = readSource('../client/pet.ts');
    assert.ok(
      !/balance\.ok\s*&&\s*cfg\.balanceEnabled/.test(clientPet),
      '余额气泡不得再要求 balance.ok：那是「未登记服务商完全没反应」的根因，文字说明走同一个气泡',
    );
    assert.ok(/balanceNoticeTick/.test(clientPet), '容器必须把「该提示不可用原因」传给各宠物');
    assert.ok(/decideBalanceNotice/.test(clientPet), '弹窗判定必须来自 src/shared（两端同一份），不得各写一份');
  });

  test('桌面外壳：同一条判定 + 不可用也走气泡渲染（不再只写 console）', () => {
    const events = readSource('../../runtime/electron-helper/events.js');
    const sprite = readSource('../../runtime/electron-helper/sprite.js');
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
