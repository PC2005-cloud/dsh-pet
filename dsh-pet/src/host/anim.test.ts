/**
 * 点播动画（`POST /dsh-pet-7340/anim`）的决策层单测。
 *
 * 契约核心是"名字必须在菜单能点到的集合里"——播放端"名字即文件名"，播不存在的动画只会
 * 静默失败（404 → 加载失败 → 表现为"点了没反应"），所以这条校验必须钉死。
 * 本模块只依赖配置，可完全离线测。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { animationNames, decideAnim } from './anim.ts';

/** 与 assets/config.jsonc 同形状的动画配置：覆盖菜单树取的全部 7 个池 */
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
    workStatus: [
      ['档位0-A', '档位0-B'], // 数组槽位：候选多个
      '档位1', // 单候选
    ],
  },
};

const cfg = {
  main: {
    animations: ANIMATIONS,
    pets: [
      { id: 'main', name: '蓝毛小女仆' },
      { id: 'test1', name: '测试宠' },
    ],
  },
};

/** 决策的便捷调用：只覆盖本次关心的参数 */
const decide = (over: Partial<Parameters<typeof decideAnim>[0]> = {}) =>
  decideAnim({ cfg, requested: 'main', active: '', name: '东张西望', ...over });

describe('animationNames —— 与右键菜单同一份动画集合', () => {
  test('七个池全部收到（菜单树取的就是这些）', () => {
    const names = animationNames(ANIMATIONS);
    for (const n of [
      '待机呼吸休闲', // idle
      '东张西望', // turn
      '被鼠标拖拽悬空反馈', // drag
      '点击回应-开心跃动', // clicks
      '原地漂浮踏步', // moves.actions[].name
      '原地专心玩魔方', // categories[].actions
      '举牌文字', // noMirror 分类照样可点播
      '看钱包', // events.balance
      '深度思考碎碎念', // events.whisper
      '档位0-A', // events.workStatus 数组槽位展平
      '档位0-B',
      '档位1',
    ]) {
      assert.ok(names.includes(n), `缺少 ${n}`);
    }
  });

  test('顺序对齐菜单树：idle → turn → drag → clicks → moves → categories → events', () => {
    assert.deepEqual(animationNames(ANIMATIONS).slice(0, 5), [
      '待机呼吸休闲',
      '东张西望',
      '被鼠标拖拽悬空反馈',
      '点击回应-开心跃动',
      '点击回应-害羞惊讶',
    ]);
  });

  test('去重：同一个动画出现在多个池里只留一次', () => {
    const dup = { idle: ['A', 'A'], clicks: ['A'], events: { whisper: [['A', 'B']] } };
    assert.deepEqual(animationNames(dup), ['A', 'B']);
  });

  test('形状非法一律当空池（不抛）', () => {
    for (const bad of [undefined, null, 42, 'x', [], { idle: 'not-array' }, { moves: { actions: 'x' } }]) {
      assert.deepEqual(animationNames(bad), []);
    }
  });

  test('过滤非字符串与空串（配置里混进脏值不至于让它变成合法动画名）', () => {
    const dirty = { idle: ['A', '', null, 3, undefined, 'B'] };
    assert.deepEqual(animationNames(dirty), ['A', 'B']);
  });
});

describe('decideAnim —— 名字校验', () => {
  test('空 / 纯空白 / 非字符串 → bad-request', () => {
    for (const name of ['', '   ', undefined, null, 42, {}]) {
      const d = decide({ name });
      assert.equal(d.ok, false);
      assert.equal(d.ok === false && d.reason, 'bad-request');
    }
  });

  test('名字前后空白 → trim 后判定并通过', () => {
    const d = decide({ name: '  东张西望  ' });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.name, '东张西望');
  });

  test('池外的名字 → unknown-animation（播放端没有兜底，必须在这里拦）', () => {
    for (const name of ['根本不存在的动画', '东张西望.webm', '../../etc/passwd', '待机呼吸']) {
      const d = decide({ name });
      assert.equal(d.ok, false, `${name} 不应通过`);
      assert.equal(d.ok === false && d.reason, 'unknown-animation');
    }
  });

  test('全部七个池的名字都能点播', () => {
    for (const name of animationNames(ANIMATIONS)) {
      assert.equal(decide({ name }).ok, true, `${name} 应可点播`);
    }
  });
});

describe('decideAnim —— 宠物选择', () => {
  test('指定存在的宠物 → 用它', () => {
    const d = decide({ requested: 'test1' });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.petId, 'test1');
  });

  test('不指定 pet → 落到当前桌宠（active）', () => {
    const d = decide({ requested: '', active: 'test1' });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.petId, 'test1');
  });

  test('不指定且没有当前桌宠 → 兜底 main', () => {
    const d = decide({ requested: '', active: '' });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.petId, 'main');
  });

  test('指定不存在的宠物 → unknown-pet', () => {
    const d = decide({ requested: 'ghost' });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, 'unknown-pet');
    assert.match(d.ok === false ? d.message : '', /ghost/);
  });

  test('宠物 id 含点号照常（不按点号切分 id）', () => {
    const dotted = { main: { ...cfg.main, pets: [{ id: 'a.b', name: '点号宠' }] } };
    const d = decide({ cfg: dotted, requested: 'a.b' });
    assert.equal(d.ok, true);
    assert.equal(d.ok === true && d.petId, 'a.b');
  });

  test('动画池按所属条目判定，不跨条目串池', () => {
    const two = {
      main: { animations: { idle: ['主池动画'] }, pets: [{ id: 'main', name: 'A' }] },
      pack1: { animations: { idle: ['包池动画'] }, pets: [{ id: 'pack1', name: 'B' }] },
    };
    assert.equal(decide({ cfg: two, requested: 'main', name: '包池动画' }).ok, false);
    assert.equal(decide({ cfg: two, requested: 'pack1', name: '主池动画' }).ok, false);
    assert.equal(decide({ cfg: two, requested: 'main', name: '主池动画' }).ok, true);
    assert.equal(decide({ cfg: two, requested: 'pack1', name: '包池动画' }).ok, true);
  });
});
