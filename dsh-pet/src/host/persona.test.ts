/**
 * 人设拼装单元测试：钉住碎碎念/对话共用 system 的分段结构（人设 + 名字声明 + 时间背景 + 可选的历史说明）。
 *
 * 为什么单测这个：拼装以前内联在 host/index.ts 的 petSystemPrompt 里（需要起宿主才能跑），
 * 于是「实例级人设回落」「名字永远追加」「时间每次现算」这三条只能靠人工试。抽成纯函数后
 * 在 node:test 里直接钉死；以后改拼装（比如再加一段）也会在这里先红。
 *
 * 跑法：node --experimental-strip-types --test src/host/persona.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { composeSystemPrompt, petPersona } from './persona.ts';

/** 固定时刻：2026-10-21（星期三）14:15，无节日窗口——时间行稳定可断言 */
const NOW = new Date(2026, 9, 21, 14, 15);

describe('petPersona —— 实例级 → 条目级 → 空', () => {
  test('实例写了 → 用实例的（完全取代条目，不拼接）', () => {
    const conf = { whisperPrompt: '条目人设' };
    assert.equal(petPersona(conf, { whisperPrompt: '实例人设' }), '实例人设');
  });

  test('实例没写 → 回落所属条目人设', () => {
    assert.equal(petPersona({ whisperPrompt: '条目人设' }, {}), '条目人设');
  });

  test('实例写了空串 / 纯空白 → 视为没写，回落条目', () => {
    const conf = { whisperPrompt: '条目人设' };
    assert.equal(petPersona(conf, { whisperPrompt: '' }), '条目人设');
    assert.equal(petPersona(conf, { whisperPrompt: '  \n\t ' }), '条目人设');
  });

  test('实例写了非字符串（数字/对象/数组）→ 视为没写，回落条目', () => {
    const conf = { whisperPrompt: '条目人设' };
    for (const bad of [42, { a: 1 }, ['x'], true, null]) {
      assert.equal(petPersona(conf, { whisperPrompt: bad }), '条目人设', `${JSON.stringify(bad)} 应被忽略`);
    }
  });

  test('两级都没有 / 条目也非法 → 空串（拼装层按"没有人设"处理）', () => {
    assert.equal(petPersona({}, {}), '');
    assert.equal(petPersona({ whisperPrompt: 42 }, {}), '');
    assert.equal(petPersona({ whisperPrompt: '' }, {}), '');
  });
});

describe('composeSystemPrompt —— 分段拼装', () => {
  test('人设 + 名字 + 时间：顺序固定，行间单个换行', () => {
    const out = composeSystemPrompt({ prompt: '你是小女仆', name: '蓝毛', id: 'main', now: NOW });
    const lines = out.split('\n');
    assert.equal(lines[0], '你是小女仆');
    assert.equal(lines[1], '你的名字是“蓝毛”。');
    assert.ok(lines[2].startsWith('【当下】现在是2026年10月21日星期三 14:15，下午，工作日'), '第三行必须是时间背景');
    assert.equal(lines.length, 3, '不带历史说明时不多不少三段');
  });

  test('historyTimes → 末尾追加【历史】段，仍在时间背景之后', () => {
    const out = composeSystemPrompt({ prompt: '你是小女仆', name: '蓝毛', id: 'main', now: NOW, historyTimes: true });
    const lines = out.split('\n');
    assert.equal(lines.length, 4, '带历史说明时是四段');
    assert.ok(
      lines[3].startsWith('【历史】历史里你的每条回复前都有 [月日 时:分]'),
      `第四行必须是【历史】：${lines[3]}`,
    );
  });

  test('historyTimes 但时间非法 → 【历史】也不加（它整句在引用“现在”）', () => {
    const out = composeSystemPrompt({
      prompt: '',
      name: '蓝毛',
      id: 'main',
      now: new Date('nope'),
      historyTimes: true,
    });
    assert.equal(out, '你的名字是“蓝毛”。');
  });

  test('historyTimes 缺省 / false → 不出现【历史】（碎碎念没有历史）', () => {
    for (const parts of [{}, { historyTimes: false }]) {
      const out = composeSystemPrompt({ prompt: '你是小女仆', name: '蓝毛', id: 'main', now: NOW, ...parts });
      assert.ok(!out.includes('【历史】'));
    }
  });

  test('没有人设 → 不以换行开头（只有名字 + 时间）', () => {
    const out = composeSystemPrompt({ prompt: '', name: '蓝毛', id: 'main', now: NOW });
    assert.ok(out.startsWith('你的名字是“蓝毛”。'), `实际开头：${JSON.stringify(out.slice(0, 12))}`);
    assert.equal(out.split('\n')[0], '你的名字是“蓝毛”。');
  });

  test('name 为空 → 用 id（与 mergePet「缺 name 按 id 处理」同一语义）', () => {
    const out = composeSystemPrompt({ prompt: '', name: '', id: 'pet-7', now: NOW });
    assert.ok(out.startsWith('你的名字是“pet-7”。'));
  });

  test('name 与 id 都空 → 整段名字声明省略（不留空行、不留空引号）', () => {
    const out = composeSystemPrompt({ prompt: '你是小女仆', name: '', id: '', now: NOW });
    assert.ok(out.startsWith('你是小女仆\n【当下】'), `实际：${JSON.stringify(out.slice(0, 20))}`);
    assert.ok(!out.includes('你的名字是'));
    assert.ok(!out.includes('“”'));
  });

  test('时间非法（NaN）→ 整行不加，且不留尾部换行', () => {
    const out = composeSystemPrompt({ prompt: '你是小女仆', name: '蓝毛', id: 'main', now: new Date('nope') });
    assert.equal(out, '你是小女仆\n你的名字是“蓝毛”。');
  });

  test('多行人设原样保留（不压平、不截断）', () => {
    const prompt = '第一行\n第二行\n第三行';
    const out = composeSystemPrompt({ prompt, name: '蓝毛', id: 'main', now: new Date('nope') });
    assert.equal(out, prompt + '\n你的名字是“蓝毛”。');
  });

  test('时间背景每次现算：同一秒之外的两个时刻产出不同的时间行', () => {
    const a = composeSystemPrompt({ prompt: '', name: '蓝毛', id: 'main', now: new Date(2026, 9, 21, 9, 0) });
    const b = composeSystemPrompt({ prompt: '', name: '蓝毛', id: 'main', now: new Date(2026, 9, 21, 21, 0) });
    assert.match(a, /上午/);
    assert.match(b, /晚上/);
    assert.notEqual(a, b);
  });
});
