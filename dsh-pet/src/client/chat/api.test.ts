/**
 * 对话窗口数据层的测试：`GET /chat` 响应整形、按轮分组、取图地址、删除请求形状与记忆边界。
 *
 * 纯函数直接测；需要 HTTP 的走 `fetch` 桩，断言请求形状与失败归一（不联网）。
 *
 * 跑法：node --experimental-strip-types --test src/client/chat/api.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  attachmentUrl,
  clearHistory,
  deleteRounds,
  fetchChatConfig,
  groupRounds,
  memeUrl,
  memoryBoundaryIndex,
  personaText,
  playAction,
  roundsToRevealMemory,
  toChatMessages,
} from './api.ts';

describe('toChatMessages —— GET /chat 响应整形', () => {
  test('正常消息 → 原样保留 role / content / ts', () => {
    const list = toChatMessages({
      ok: true,
      messages: [
        { role: 'user', content: '在吗', ts: 1000 },
        { role: 'assistant', content: '在的', ts: 1000 },
      ],
      rounds: 5,
    });
    assert.deepEqual(list, [
      { role: 'user', text: '在吗', ts: 1000 },
      { role: 'assistant', text: '在的', ts: 1000 },
    ]);
  });

  test('messages 不是数组 → 空列表（不抛错）', () => {
    for (const bad of [null, undefined, {}, 42, { messages: 'x' }]) {
      assert.deepEqual(toChatMessages(bad), []);
    }
  });

  test('单条坏数据 → 丢弃该条，其余照常显示', () => {
    const list = toChatMessages({
      messages: [
        { role: 'user', content: '好的', ts: 1 },
        null,
        { role: 'system', content: '不该出现', ts: 2 },
        { role: 'user', ts: 3 },
        { role: 'assistant', content: '收到', ts: 4 },
      ],
    });
    assert.deepEqual(
      list.map((m) => m.text),
      ['好的', '收到'],
    );
  });

  test('ts 不是数字 → 记为 0（渲染层据此不显示时间）', () => {
    const list = toChatMessages({ messages: [{ role: 'user', content: '嗨' }] });
    assert.equal(list[0]?.ts, 0);
  });
});

describe('groupRounds —— 按轮分组（显示与删除同一粒度）', () => {
  const user = (text: string, ts: number) => ({ role: 'user' as const, text, ts });
  const pet = (text: string, ts: number) => ({ role: 'assistant' as const, text, ts });

  test('同一 ts 的问与答合成一轮', () => {
    const rounds = groupRounds([user('在吗', 1000), pet('在的', 1000)]);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0]?.user?.text, '在吗');
    assert.equal(rounds[0]?.assistant?.text, '在的');
  });

  test('不同 ts → 各自成轮，顺序不变', () => {
    const rounds = groupRounds([user('一', 1), pet('一答', 1), user('二', 2), pet('二答', 2)]);
    assert.deepEqual(
      rounds.map((round) => round.ts),
      [1, 2],
    );
  });

  test('ts 为 0 → 每条各自成轮（否则无时间戳的消息会挤成一轮）', () => {
    const rounds = groupRounds([user('甲', 0), pet('乙', 0)]);
    assert.equal(rounds.length, 2);
  });

  test('只剩一侧（删过或截断）→ 该轮只有一半，不补空', () => {
    const rounds = groupRounds([pet('孤零零的回答', 5)]);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0]?.user, undefined);
    assert.equal(rounds[0]?.assistant?.text, '孤零零的回答');
  });
});

describe('toChatMessages —— 图信息', () => {
  const REF = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 12, width: 8, height: 6 };

  test('user 带图 → 收下附件引用，渲染层据此拼 /attachment', () => {
    const list = toChatMessages({ messages: [{ role: 'user', content: '看图', ts: 1, image: REF }] });
    assert.deepEqual(list[0]?.image, REF);
  });

  test('assistant 带配图名 → 记下 meme，不当作附件引用', () => {
    const list = toChatMessages({ messages: [{ role: 'assistant', content: '好耶', ts: 1, meme: '可爱' }] });
    assert.equal(list[0]?.meme, '可爱');
    assert.equal(list[0]?.image, undefined);
  });

  test('引用形状不对（旧记录 / 坏数据）→ 当作没带图，不影响正文', () => {
    for (const bad of [null, 'x', {}, { attachmentId: '' }, { attachmentId: 42 }]) {
      const list = toChatMessages({ messages: [{ role: 'user', content: '嗨', ts: 1, image: bad }] });
      assert.equal(list[0]?.image, undefined);
      assert.equal(list[0]?.text, '嗨');
    }
  });

  test('assistant 带动作名 → 记下 action，供喇叭右边的重播按钮用', () => {
    const list = toChatMessages({
      messages: [{ role: 'assistant', content: '好耶', ts: 1, action: '优雅女仆舞' }],
    });
    assert.equal(list[0]?.action, '优雅女仆舞');
    assert.equal(list[0]?.meme, undefined);
  });

  test('动作名空串或非字符串 → 当作没演动作', () => {
    for (const bad of ['', 42, null, {}]) {
      const list = toChatMessages({ messages: [{ role: 'assistant', content: '嗯', ts: 1, action: bad }] });
      assert.equal(list[0]?.action, undefined);
    }
  });
});

describe('取图地址', () => {
  test('attachmentUrl 对 attachmentId 做 URL 编码', () => {
    assert.equal(
      attachmentUrl({ attachmentId: 'sha256:a b', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }),
      '/dsh-pet-7340/attachment?id=sha256%3Aa%20b',
    );
  });

  test('memeUrl 带素材根；素材根为空时退回两段形式', () => {
    assert.equal(memeUrl('可爱', 'main'), '/dsh-pet-7340/pic/memes/main/%E5%8F%AF%E7%88%B1.png');
    assert.equal(memeUrl('可爱', '  '), '/dsh-pet-7340/pic/memes/%E5%8F%AF%E7%88%B1.png');
  });
});

describe('playAction —— 重播动作走 /anim', () => {
  /** 用给定响应替身跑一次，回收请求与返回值。 */
  async function withFetch<T>(
    body: unknown,
    run: () => Promise<T>,
  ): Promise<{ calls: { url: string; method: string; body: unknown }[]; value: T }> {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      return { calls, value: await run() };
    } finally {
      globalThis.fetch = original;
    }
  }

  test('POST /anim?pet=&surface=any，body 只带动作名', async () => {
    const { calls, value } = await withFetch({ ok: true, playbackId: 'pb_1' }, () => playAction('main', '优雅女仆舞'));
    assert.deepEqual(
      calls.map((call) => call.url),
      // surface 是 /anim 的必填项：缺了它宿主直接 400，按钮会表现为「点了没反应」
      ['/dsh-pet-7340/anim?pet=main&surface=any'],
    );
    assert.equal(calls[0]?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.body)), { name: '优雅女仆舞' });
    assert.equal(value, true);
  });

  test('宿主拒绝（名字不在池内 / 宠物没在显示）→ 返回 false，不抛错', async () => {
    const { value } = await withFetch({ ok: false, reason: 'unknown-animation' }, () =>
      playAction('main', '不存在的动作'),
    );
    assert.equal(value, false);
  });
});

describe('删除对话记忆 —— 请求形状与失败归一', () => {
  /** 用给定响应替身跑一次，回收请求与返回值。 */
  async function withFetch<T>(
    body: unknown,
    run: () => Promise<T>,
  ): Promise<{ calls: { url: string; method: string }[]; value: T }> {
    const calls: { url: string; method: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    try {
      return { calls, value: await run() };
    } finally {
      globalThis.fetch = original;
    }
  }

  test('deleteRounds 用 DELETE，并把每个 ts 作为重复的 query 参数', async () => {
    const { calls, value } = await withFetch({ ok: true, removed: 2 }, () => deleteRounds('main', [1000, 2000]));
    assert.deepEqual(calls, [{ url: '/dsh-pet-7340/chat?pet=main&ts=1000&ts=2000', method: 'DELETE' }]);
    assert.deepEqual(value, { ok: true, removed: 2 });
  });

  test('clearHistory 不带 ts（= 清空整只）', async () => {
    const { calls } = await withFetch({ ok: true, removed: 0 }, () => clearHistory('main'));
    assert.deepEqual(calls, [{ url: '/dsh-pet-7340/chat?pet=main', method: 'DELETE' }]);
  });

  test('空选择不发请求（没有可删的轮）', async () => {
    const { calls, value } = await withFetch({ ok: true, removed: 0 }, () => deleteRounds('main', []));
    assert.deepEqual(calls, [], '没有勾选时不该打扰宿主');
    assert.deepEqual(value, { ok: true, removed: 0 });
  });

  test('业务失败 → 带回服务端文案，不抛错', async () => {
    const { value } = await withFetch({ ok: false, reason: 'unknown-pet', message: '没有这只桌宠' }, () =>
      deleteRounds('nobody', [1]),
    );
    assert.deepEqual(value, { ok: false, message: '没有这只桌宠' });
  });
});

describe('memoryBoundaryIndex —— 记忆边界线的位置', () => {
  test('总轮数多于记忆轮数 → 返回分界下标（线之前是存档）', () => {
    assert.equal(memoryBoundaryIndex(10, 5), 5);
    assert.equal(memoryBoundaryIndex(3, 1), 2);
  });

  test('全部都在记忆里 → 不画线', () => {
    assert.equal(memoryBoundaryIndex(5, 5), null);
    assert.equal(memoryBoundaryIndex(3, 9), null);
  });

  test('关闭记忆（0）或配置里没这个值 → 不画线', () => {
    assert.equal(memoryBoundaryIndex(10, 0), null);
    assert.equal(memoryBoundaryIndex(10, undefined), null);
  });

  test('没有消息 → 不画线', () => {
    assert.equal(memoryBoundaryIndex(0, 5), null);
  });
});

describe('roundsToRevealMemory —— 让记忆线进入视窗要放多少轮', () => {
  test('线在倒数第 N 轮之前：至少要 N + 1 轮，线上才有一轮可显示', () => {
    assert.equal(roundsToRevealMemory(5), 6);
    assert.equal(roundsToRevealMemory(1), 2);
  });

  test('没有记忆（0 或负数）→ 0，调用方不必放轮', () => {
    assert.equal(roundsToRevealMemory(0), 0);
    assert.equal(roundsToRevealMemory(-3), 0);
  });
});

describe('fetchChatConfig —— 同一份 /config 里带出记忆轮数', () => {
  test('按条目读 chatMemoryRounds，同时拍平宠物列表', async () => {
    const body = {
      main: { pets: [{ id: 'main', name: '主宠' }], chatMemoryRounds: 7 },
      extra: { pets: [{ id: 'pig', name: '猪' }], chatMemoryRounds: 3 },
      broken: { pets: [], chatMemoryRounds: 'nope' },
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    try {
      const config = await fetchChatConfig();
      assert.deepEqual(config.roundsByEntry, { main: 7, extra: 3 }, '非法轮数不该进入表里');
      assert.deepEqual(
        config.pets.map((pet) => pet.id),
        ['main', 'pig'],
      );
      assert.equal(config.pets[0]?.assetRoot, 'main');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('同一次请求带回每只宠物的人设：实例级优先，没有就用所属条目那份', async () => {
    const body = {
      main: {
        pets: [
          { id: 'main', name: '主宠' },
          { id: 'cat', name: '猫', whisperPrompt: '我自己的人设' },
        ],
        whisperPrompt: '条目默认人设',
      },
      pack: { pets: [{ id: 'pig', name: '猪' }], whisperPrompt: '种类人设' },
    };
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    try {
      const config = await fetchChatConfig();
      assert.deepEqual(config.personaByPet, {
        main: '条目默认人设',
        cat: '我自己的人设',
        pig: '种类人设',
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('personaText —— 面板显示哪一份人设', () => {
  test('实例级非空白 → 用实例原文（替换条目那份，保留排版）', () => {
    assert.equal(personaText('  我的猫娘人设\n第二行 ', '条目人设'), '  我的猫娘人设\n第二行 ');
  });

  test('实例级纯空白或缺失 → 回落到所属条目顶层那份', () => {
    assert.equal(personaText('   ', '条目人设'), '条目人设');
    assert.equal(personaText(undefined, '条目人设'), '条目人设');
  });

  test('两处都没有 → 空串（内置默认由配置合并保证，这里不凭空造文案）', () => {
    assert.equal(personaText(undefined, undefined), '');
    assert.equal(personaText('', ''), '');
  });

  test('非字符串的脏值 → 按没写处理，不把对象显示给用户', () => {
    assert.equal(personaText({ text: '对象' }, '条目人设'), '条目人设');
    assert.equal(personaText(undefined, 42), '');
  });
});
