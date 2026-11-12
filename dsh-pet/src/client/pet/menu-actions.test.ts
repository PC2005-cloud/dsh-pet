/**
 * 菜单动作派发（src/client/pet/menu-actions.ts）的契约测试。
 *
 * 四条契约：内置动作各走各的端点和回调；点播移动动画优先走真实位移，挪不动才退化成纯播放；
 * 文字类动画点播前强制朝左（keepFacing 时跳过）；移动系统接管点播时如实回 failed/busy。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createMenuActions, type MenuActionDeps } from './menu-actions.ts';
import type { MenuLeaf } from '../../shared/menu.ts';
import type { Animations } from '../../shared/types.ts';

const animations = {
  idle: ['idle1'],
  turn: [],
  drag: [],
  clicks: [],
  moves: { default: {}, actions: [{ name: 'walk1' }] },
  // noMirror: true 的分类：朝右站姿是镜像的，点播前要强制朝左。
  categories: [{ id: 'text', weight: 1, noMirror: true, actions: ['say1'] }],
  events: {},
} as unknown as Animations;

/** 造一套记录调用的依赖。 */
function harness(overrides: Partial<MenuActionDeps> = {}) {
  const calls: string[] = [];
  const deps: MenuActionDeps = {
    petId: 'pet-1',
    animations: () => animations,
    isFacingRight: () => true,
    faceLeft: () => calls.push('faceLeft'),
    tryMove: () => 'walk1',
    stopMove: () => calls.push('stopMove'),
    stopThrow: () => calls.push('stopThrow'),
    playOnce: (anim, playbackId) => calls.push(`playOnce:${anim}:${playbackId ?? 'null'}`),
    resetPosition: () => calls.push('resetPosition'),
    openChat: () => calls.push('openChat'),
    openTodo: () => calls.push('openTodo'),
    report: (id, status, reason) => calls.push(`report:${id}:${status}:${reason}`),
    applyMerged: () => calls.push('applyMerged'),
    warn: (message) => calls.push('warn:' + message.slice(0, 20)),
    ...overrides,
  };
  return { actions: createMenuActions(deps), calls };
}

describe('createMenuActions —— 内置动作', () => {
  test('回到初始位置：先停飞行与走位再清位置', () => {
    const { actions, calls } = harness();
    actions.run({ label: '回到初始位置', action: 'home' } as MenuLeaf);
    assert.deepEqual(calls, ['stopThrow', 'stopMove', 'resetPosition']);
  });

  test('对话：交给 openChat', () => {
    const { actions, calls } = harness();
    actions.run({ label: '对话', action: 'chat' } as MenuLeaf);
    assert.deepEqual(calls, ['openChat']);
  });

  test('待办：交给 openTodo', () => {
    const { actions, calls } = harness();
    actions.run({ label: '待办事项', action: 'todo' } as MenuLeaf);
    assert.deepEqual(calls, ['openTodo']);
  });

  test('显示位置：没有 display 就什么都不做', () => {
    const { actions, calls } = harness();
    actions.run({ label: '显示位置', action: 'set-display' } as MenuLeaf);
    assert.deepEqual(calls, []);
  });
});

describe('createMenuActions —— 点播动画', () => {
  test('普通动画：停走位后纯播放，并把点播编号带上', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'idle1', anim: 'idle1' } as MenuLeaf, 'pb-1');
    assert.deepEqual(calls, ['stopMove', 'playOnce:idle1:pb-1']);
  });

  test('移动动画：走位接管，不换视频源；点播如实回 failed/busy', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'walk1', anim: 'walk1' } as MenuLeaf, 'pb-1');
    assert.deepEqual(calls, ['report:pb-1:failed:busy'], '走位在跑，这段点播不可能真的播起来');
  });

  test('移动动画 + 自播（无点播编号）：什么都不额外做', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'walk1', anim: 'walk1' } as MenuLeaf);
    assert.deepEqual(calls, []);
  });

  test('移动动画挪不动：退化成纯播放', () => {
    const { actions, calls } = harness({ tryMove: () => false });
    actions.run({ label: 'walk1', anim: 'walk1' } as MenuLeaf);
    assert.deepEqual(calls, ['stopMove', 'playOnce:walk1:null']);
  });

  test('走位已被占用（返回 true）：同样如实回 failed/busy', () => {
    const busy = harness({ tryMove: () => true });
    busy.actions.run({ label: 'walk1', anim: 'walk1' } as MenuLeaf, 'pb-2');
    assert.deepEqual(busy.calls, ['report:pb-2:failed:busy']);
  });

  test('文字类动画 + 朝右：点播前强制朝左', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'say1', anim: 'say1' } as MenuLeaf);
    assert.equal(calls[0], 'faceLeft');
    assert.equal(calls[1], 'stopMove');
  });

  test('keepFacing：显式朝向优先，不强制朝左', () => {
    const { actions, calls } = harness();
    actions.run({ label: 'say1', anim: 'say1' } as MenuLeaf, undefined, true);
    assert.deepEqual(calls, ['stopMove', 'playOnce:say1:null']);
  });

  test('朝左时不需要再强制朝左', () => {
    const { actions, calls } = harness({ isFacingRight: () => false });
    actions.run({ label: 'say1', anim: 'say1' } as MenuLeaf);
    assert.deepEqual(calls, ['stopMove', 'playOnce:say1:null']);
  });
});

describe('createMenuActions —— 配图碎碎念', () => {
  /** 临时接管全局 fetch（postAction 走它），返回被请求的 URL 列表。 */
  function captureFetch(): { urls: string[]; restore: () => void } {
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { urls, restore: () => (globalThis.fetch = original) };
  }

  test('点具体的图：请求带上编码后的图名，仍走手动碎碎念端点', async () => {
    const captured = captureFetch();
    try {
      harness().actions.run({ label: '大的要来啦', action: 'whisper', image: '大的要来啦' } as MenuLeaf);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      captured.restore();
    }
    assert.equal(captured.urls.length, 1, '一次点击只该发一次请求');
    const url = captured.urls[0] ?? '';
    assert.match(url, /\/whisper\?pet=pet-1&surface=web&image=/, '应带上 image 参数');
    assert.ok(url.endsWith(encodeURIComponent('大的要来啦')), '中文与空格必须编码：' + url);
  });

  test('普通碎碎念：不带 image 参数（行为与加这个功能之前一致）', async () => {
    const captured = captureFetch();
    try {
      harness().actions.run({ label: '碎碎念', action: 'whisper' } as MenuLeaf);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      captured.restore();
    }
    assert.equal(captured.urls.length, 1);
    assert.doesNotMatch(captured.urls[0] ?? '', /image=/, '没点名具体图就不该带 image 参数');
  });

  test('查询天气：POST /environment，带 pet、surface=any 与 fresh=1', async () => {
    const captured = captureFetch();
    try {
      harness().actions.run({ label: '查询天气', action: 'show-environment' } as MenuLeaf);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      captured.restore();
    }
    assert.equal(captured.urls.length, 1, '一次点击只该发一次请求');
    const url = captured.urls[0] ?? '';
    assert.match(url, /\/environment\?pet=pet-1&surface=any&fresh=1$/, '必须强制刷新：' + url);
  });

  test('查看余额：POST /balance 带上 pet 与 surface，只让被点的那只弹', async () => {
    const captured = captureFetch();
    try {
      harness().actions.run({ label: '查看余额', action: 'show-balance' } as MenuLeaf);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      captured.restore();
    }
    assert.equal(captured.urls.length, 1, '一次点击只该发一次请求');
    assert.match(captured.urls[0] ?? '', /\/balance\?pet=pet-1&surface=any$/, '应带归属参数：' + captured.urls[0]);
  });
});

describe('createMenuActions —— 睡觉闸门（渲染端拒绝）', () => {
  test('睡着时点对话：只弹拒绝台词，不打开弹窗', () => {
    const { actions, calls } = harness({
      sleeping: () => true,
      say: (text) => calls.push('say:' + text),
      sleepRefuseTexts: () => ['我在睡觉'],
    });
    actions.run({ label: '对话', action: 'chat' } as MenuLeaf);
    assert.deepEqual(calls, ['say:我在睡觉']);
  });

  test('睡着时点待办 / 余额同样被拒', () => {
    const { actions, calls } = harness({
      sleeping: () => true,
      say: (text) => calls.push('say:' + text),
      sleepRefuseTexts: () => ['别吵'],
    });
    actions.run({ label: '待办事项', action: 'todo' } as MenuLeaf);
    actions.run({ label: '查看余额', action: 'show-balance' } as MenuLeaf);
    assert.deepEqual(calls, ['say:别吵', 'say:别吵']);
  });

  test('睡觉 / 起来 / 维护类照常放行', () => {
    const { actions, calls } = harness({
      sleeping: () => true,
      say: () => calls.push('say'),
      sleepRefuseTexts: () => ['别吵'],
    });
    actions.run({ label: '回到初始位置', action: 'home' } as MenuLeaf);
    assert.deepEqual(calls, ['stopThrow', 'stopMove', 'resetPosition']);
  });

  test('醒着时拒绝逻辑完全不动（对话照旧走 openChat）', () => {
    const { actions, calls } = harness({ sleeping: () => false, say: () => calls.push('say') });
    actions.run({ label: '对话', action: 'chat' } as MenuLeaf);
    assert.deepEqual(calls, ['openChat']);
  });
});

describe('createMenuActions —— 持锁时睡觉闸门让路', () => {
  test('睡着但持锁：动作照常执行（锁的语义是把控制权交给第三方）', () => {
    const { actions, calls } = harness({
      sleeping: () => true,
      locked: () => true,
      say: (text) => calls.push('say:' + text),
      sleepRefuseTexts: () => ['别吵'],
    });
    actions.run({ label: '对话', action: 'chat' } as MenuLeaf);
    assert.deepEqual(calls, ['openChat']);
  });

  test('睡着且未持锁：仍然拒绝', () => {
    const { actions, calls } = harness({
      sleeping: () => true,
      locked: () => false,
      say: (text) => calls.push('say:' + text),
      sleepRefuseTexts: () => ['别吵'],
    });
    actions.run({ label: '对话', action: 'chat' } as MenuLeaf);
    assert.deepEqual(calls, ['say:别吵']);
  });
});

describe('createMenuActions —— 宿主指令不按「用户点击」判睡觉', () => {
  test('睡着且未持锁，但来自 pets.anim 的宿主指令：照常播放（放行由宿主闸门决定）', () => {
    const { actions, calls } = harness({
      sleeping: () => true,
      locked: () => false,
      say: (text) => calls.push('say:' + text),
      sleepRefuseTexts: () => ['别吵'],
    });
    actions.run({ anim: 'idle1', label: 'idle1' } as MenuLeaf, undefined, false, true);
    assert.deepEqual(calls, ['stopMove', 'playOnce:idle1:null']);
  });
});
