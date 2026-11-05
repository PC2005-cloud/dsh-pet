/**
 * 对话动作联动的纯逻辑测试：名单范围、注入提示词的文案、回复标记的解析。
 *
 * 三条契约：
 *   1. 名单只取 `animations.categories`，待机 / 转向 / 拖拽 / 点击 / 移动 / 事件动画一律不进；
 *   2. 指令与配图同句式（可选、按语境挑、没有合适的就不写），并且把每个名字都列出来；
 *   3. 解析剥掉所有动作标记（无效名称也剥），只采纳白名单内第一个。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { actionInstruction, chatActionNames, extractChatAction } from './chat-action.ts';

/** 与 assets/config.jsonc 同形状的最小动画配置：categories 之外还有各种不该进名单的池 */
const ANIMATIONS = {
  idle: ['待机呼吸休闲'],
  turn: ['东张西望'],
  drag: ['被鼠标拖拽悬空反馈'],
  clicks: ['点击回应-开心跃动', '点击回应-害羞惊讶'],
  moves: {
    default: { minDist: 60, maxDist: 240 },
    actions: [{ name: '原地漂浮踏步' }, { name: '螃蟹走路' }],
  },
  categories: [
    { id: '玩魔方', actions: ['原地专心玩魔方'] },
    { id: '文字类', noMirror: true, actions: ['举牌文字'] },
  ],
  events: {
    balance: ['看钱包'],
    whisper: ['深度思考碎碎念'],
    workStatus: [['档位0-A', '档位0-B'], '档位1'],
  },
};

describe('chatActionNames —— 对话联动的动作范围（只有 categories）', () => {
  test('取 categories 下全部动作，去重且保持配置顺序', () => {
    const names = chatActionNames({
      idle: ['待机'],
      categories: [
        { id: 'A', actions: ['甲', '乙'] },
        { id: 'B', actions: ['乙', '丙'] },
      ],
      events: { whisper: ['碎碎念'] },
    });
    assert.deepEqual(names, ['甲', '乙', '丙']);
  });

  test('不含待机 / 转向 / 拖拽 / 点击 / 移动 / 事件动画', () => {
    const names = chatActionNames(ANIMATIONS);
    for (const excluded of [
      '待机呼吸休闲',
      '东张西望',
      '被鼠标拖拽悬空反馈',
      '点击回应-开心跃动',
      '原地漂浮踏步',
      '看钱包',
      '深度思考碎碎念',
    ]) {
      assert.equal(names.includes(excluded), false, excluded + ' 不应进入对话动作范围');
    }
    assert.deepEqual(names, ['原地专心玩魔方', '举牌文字']);
  });

  test('非法输入 → 空名单（不抛错，开关关闭时的实际路径）', () => {
    for (const bad of [
      undefined,
      null,
      'x',
      42,
      {},
      { categories: 'oops' },
      { categories: [null, 1, { actions: 'x' }] },
    ]) {
      assert.deepEqual(chatActionNames(bad), []);
    }
  });
});

describe('actionInstruction —— 注入 user 正文的动作指令', () => {
  test('与配图同句式：可选、按语境挑、没有合适的就不写', () => {
    const text = actionInstruction(['优雅女仆舞']);
    assert.ok(text.includes('[动作]'), '必须有 [动作] 段');
    assert.ok(text.includes('挑最贴合当前语境的'), '要按语境挑，不是随机抽');
    assert.ok(text.includes('没有合适的就完全不要写这个标记'), '不强选');
  });

  test('每个名字各占一行（与配图清单同款）', () => {
    const names = ['优雅女仆舞', '原地小憩沉眠'];
    const text = actionInstruction(names);
    for (const name of names) assert.ok(text.includes('- ' + name), '清单里缺 ' + name);
    assert.equal(text.split('\n').filter((line) => line.startsWith('- ')).length, names.length);
  });

  test('ru：说明是俄语，标记格式仍是 [动作:…]，动作名不翻译', () => {
    const text = actionInstruction(['优雅女仆舞'], 'ru');
    assert.ok(text.includes('В конце ответа можно показать одно действие'));
    assert.ok(text.includes('[动作:имя]'));
    assert.ok(text.includes('- 优雅女仆舞'));
    assert.equal(text.includes('回复结尾'), false);
  });

  test('标记格式与解析一致：另起一行写 [动作:名称]', () => {
    const text = actionInstruction(['优雅女仆舞']);
    assert.ok(text.includes('[动作:名称]'));
    assert.ok(text.includes('名称原样照抄'));
  });
});

describe('extractChatAction —— 动作标记的采纳与剥离', () => {
  const NAMES = ['优雅女仆舞', '原地小憩沉眠', '轻快摇摆舞'];

  test('命中 → 剥掉标记、返回动作名', () => {
    const r = extractChatAction('好呀～看我转一圈！\n[动作:轻快摇摆舞]', NAMES);
    assert.equal(r.text, '好呀～看我转一圈！');
    assert.equal(r.action, '轻快摇摆舞');
  });

  test('全角冒号与名称前后空白都能识别', () => {
    assert.equal(extractChatAction('好的\n[动作：优雅女仆舞]', NAMES).action, '优雅女仆舞');
    assert.equal(extractChatAction('好的\n[动作:  原地小憩沉眠  ]', NAMES).action, '原地小憩沉眠');
  });

  test('名称不在白名单 → 剥掉标记但不采纳（不把标记露给用户）', () => {
    const r = extractChatAction('好的\n[动作:自创动作]', NAMES);
    assert.equal(r.action, undefined);
    assert.equal(r.text, '好的');
  });

  test('多个标记 → 只采纳白名单内第一个，其余全剥', () => {
    const r = extractChatAction('嗯\n[动作:不存在]\n[动作:优雅女仆舞]\n[动作:轻快摇摆舞]', NAMES);
    assert.equal(r.action, '优雅女仆舞');
    assert.equal(r.text.includes('[动作'), false);
  });

  test('无标记 → 原样返回（不动正文）', () => {
    const r = extractChatAction('嗯嗯，我明白了', NAMES);
    assert.equal(r.text, '嗯嗯，我明白了');
    assert.equal(r.action, undefined);
  });

  test('只写标记没有正文 → 文本为空（调用方据此不弹气泡）', () => {
    const r = extractChatAction('[动作:优雅女仆舞]', NAMES);
    assert.equal(r.text, '');
    assert.equal(r.action, '优雅女仆舞');
  });

  test('空名单 → 标记照剥但不采纳（开关关闭时的路径）', () => {
    const r = extractChatAction('好的\n[动作:优雅女仆舞]', []);
    assert.equal(r.action, undefined);
    assert.equal(r.text, '好的');
  });
});
