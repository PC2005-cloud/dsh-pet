/**
 * PowerContext 记忆实现的契约测试。
 *
 * 四条契约：
 *   1. 地址没配就不发任何请求，整轮不介入；
 *   2. scope 先查后建——已存在时不再 POST，不存在时按标题创建并用返回的 id 检索；
 *   3. 召回把命中拼成证据块前插到 userText，system 与 history 原样不动；没命中就返回 undefined；
 *   4. 任何一步失败（HTTP 非 2xx、响应形状不对、改写超时）都不抛错，最多退回原句继续；
 *   5. 两层都查：主题记忆与原子记忆并行，分层写进证据块，任一层失败都不影响另一层。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import type { CaptureTurn, ChatRequest, ChatTurn, RecallRequest } from '../chat-memory-provider.ts';
import { createPowerContextMemory } from './powercontext.ts';

/** 一次被记下的请求。 */
interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/** 服务端替身的一次答复；`undefined` 表示这个用例不关心该请求。 */
interface Reply {
  status?: number;
  json?: unknown;
  /** 延迟多久再答复（ms）；用来模拟检索那次远程向量化的耗时。 */
  delayMs?: number;
}

interface Stub {
  readonly endpoint: string;
  readonly requests: Recorded[];
  close(): Promise<void>;
}

/** 起一个本机替身服务：把每次请求记下来，按 handler 的返回值答复。 */
async function startStub(handler: (req: Recorded) => Reply): Promise<Stub> {
  const requests: Recorded[] = [];
  const server = createServer((incoming, outgoing) => {
    let raw = '';
    incoming.on('data', (chunk) => {
      raw += String(chunk);
    });
    incoming.on('end', () => {
      const recorded: Recorded = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        body: raw === '' ? undefined : JSON.parse(raw),
      };
      requests.push(recorded);
      const reply = handler(recorded);
      const send = () => {
        outgoing.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify(reply.json ?? {}));
      };
      if (reply.delayMs === undefined) send();
      else setTimeout(send, reply.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    endpoint: 'http://127.0.0.1:' + port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 一份可用的召回请求；用例只改自己关心的字段。 */
function recallRequest(
  userText = '晚饭吃什么好',
  history: ChatTurn[] = [{ role: 'user', content: '早', ts: 1 }],
  petId = 'main',
): RecallRequest {
  const prepared: ChatRequest = {
    system: '你是桌宠',
    history,
    userText,
  };
  return {
    petId,
    userText,
    prepared,
    raw: {
      persona: '你是桌宠',
      now: 0,
      memes: [],
      actions: [],
      pet: { id: petId, name: '小女仆', entry: 'main', display: 'both' },
    },
  };
}

/** 默认替身：scope 已存在，检索返回一条命中。 */
function defaultHandler(over: { hits?: unknown[]; scopes?: unknown[] } = {}) {
  return (req: Recorded): Reply => {
    if (req.method === 'GET' && req.path.startsWith('/v1/scopes')) {
      return {
        json: { items: over.scopes ?? [{ scope_id: 'scp_1', title: 'dsh-pet:main' }], next_cursor: null },
      };
    }
    if (req.method === 'POST' && req.path === '/v1/atomic-memory/search') {
      return {
        json: {
          mode: 'hybrid',
          hits: over.hits ?? [{ memory: { kind: 'preference', text: '用户不吃香菜' }, score: 0.03, matched_by: [] }],
        },
      };
    }
    return { json: {} };
  };
}

describe('PowerContext —— 召回', () => {
  test('地址没配 → 返回 undefined 且一个请求都不发', async () => {
    const stub = await startStub(defaultHandler());
    try {
      const provider = createPowerContextMemory({ endpoint: () => '', token: () => '' });
      assert.equal(await provider.recall?.(recallRequest(), new AbortController().signal), undefined);
      assert.equal(stub.requests.length, 0);
    } finally {
      await stub.close();
    }
  });

  test('scope 已存在 → 不创建，直接用查到的 id 检索', async () => {
    const stub = await startStub(defaultHandler());
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      await provider.recall?.(recallRequest(), new AbortController().signal);
      const creates = stub.requests.filter((req) => req.method === 'POST' && req.path === '/v1/scopes');
      assert.equal(creates.length, 0, '已存在就不该再创建');
      const search = stub.requests.find((req) => req.path === '/v1/atomic-memory/search');
      assert.equal((search?.body as { scope_id: string }).scope_id, 'scp_1');
    } finally {
      await stub.close();
    }
  });

  test('两只宠物各用各的 scope，记忆不互相串', async () => {
    const stub = await startStub((req) => {
      if (req.method === 'GET' && req.path.startsWith('/v1/scopes')) {
        // 服务端按标题模糊查，两个 scope 都会被返回：谁能选中靠本地精确比对
        return {
          json: {
            items: [
              { scope_id: 'scp_pet2', title: 'dsh-pet:pet-2' },
              { scope_id: 'scp_baimao', title: 'dsh-pet:baimao1' },
            ],
          },
        };
      }
      return { json: { mode: 'hybrid', hits: [] } };
    });
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      await provider.recall?.(recallRequest('红烧肉', undefined, 'pet-2'), new AbortController().signal);
      await provider.recall?.(recallRequest('红烧肉', undefined, 'baimao1'), new AbortController().signal);
      const searched = stub.requests
        .filter((req) => req.path === '/v1/atomic-memory/search')
        .map((req) => (req.body as { scope_id: string }).scope_id);
      assert.deepEqual(searched, ['scp_pet2', 'scp_baimao'], '各查各的 scope');
      const looked = stub.requests
        .filter((req) => req.path.startsWith('/v1/scopes'))
        .map((req) => decodeURIComponent(req.path));
      assert.deepEqual(looked, [
        '/v1/scopes?query=dsh-pet:pet-2&query_field=title&limit=50',
        '/v1/scopes?query=dsh-pet:baimao1&query_field=title&limit=50',
      ]);
    } finally {
      await stub.close();
    }
  });

  test('scope 不存在 → 按标题创建，字段齐全，并用返回的 id 检索', async () => {
    const stub = await startStub((req) => {
      if (req.method === 'GET' && req.path.startsWith('/v1/scopes')) return { json: { items: [] } };
      if (req.method === 'POST' && req.path === '/v1/scopes') {
        return { status: 201, json: { scope_id: 'scp_new', title: 'dsh-pet:main' } };
      }
      return { json: { mode: 'hybrid', hits: [] } };
    });
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      await provider.recall?.(recallRequest(), new AbortController().signal);
      const create = stub.requests.find((req) => req.method === 'POST' && req.path === '/v1/scopes');
      assert.ok(create, '应该创建 scope');
      const body = create.body as { title: string; summary: string; idempotency_key: string };
      assert.equal(body.title, 'dsh-pet:main');
      assert.equal(body.idempotency_key, 'dsh-pet:main:v1', '幂等键也要按宠物分');
      assert.ok(body.summary.length > 0, 'summary 是必填字段，不能省');
      assert.ok(body.idempotency_key.length > 0);
      const search = stub.requests.find((req) => req.path === '/v1/atomic-memory/search');
      assert.equal((search?.body as { scope_id: string }).scope_id, 'scp_new');
    } finally {
      await stub.close();
    }
  });

  test('检索请求带 hybrid 与三条上限，查询用用户原话', async () => {
    const stub = await startStub(defaultHandler());
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      await provider.recall?.(recallRequest('晚饭吃什么好'), new AbortController().signal);
      const search = stub.requests.find((req) => req.path === '/v1/atomic-memory/search');
      assert.deepEqual(
        { ...(search?.body as object), scope_id: undefined },
        { scope_id: undefined, query: '晚饭吃什么好', mode: 'hybrid', limit: 3 },
      );
    } finally {
      await stub.close();
    }
  });

  test('有命中 → 证据块前插到 userText，system 与 history 不动', async () => {
    const stub = await startStub(defaultHandler());
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      const req = recallRequest('晚饭吃什么好');
      const result = await provider.recall?.(req, new AbortController().signal);
      assert.ok(result, '应该返回请求体');
      assert.ok(result.userText.includes('[preference] 用户不吃香菜'), '证据块要带 kind 与正文');
      assert.ok(result.userText.endsWith('\n\n晚饭吃什么好'), '用户原话必须在证据块之后');
      assert.equal(result.system, req.prepared.system);
      assert.deepEqual(result.history, req.prepared.history);
    } finally {
      await stub.close();
    }
  });

  test('主题记忆有命中 → 分层写进证据块，主题段排在原子段之前', async () => {
    const stub = await startStub((req) => {
      if (req.method === 'GET' && req.path.startsWith('/v1/scopes')) {
        return { json: { items: [{ scope_id: 'scp_1', title: 'dsh-pet:main' }] } };
      }
      if (req.path === '/v1/topic-memory/search') {
        return {
          json: {
            mode: 'hybrid',
            hits: [
              {
                title: '家庭成员特长',
                summary: '姐姐缝扣子手巧，弟弟专拆遥控器',
                snippet: '姐姐缝扣子手可巧了',
                score: 50,
              },
            ],
          },
        };
      }
      return { json: { mode: 'hybrid', hits: [{ memory: { kind: 'preference', text: '用户不吃香菜' } }] } };
    });
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      const result = await provider.recall?.(recallRequest('介绍一下你的家人'), new AbortController().signal);
      assert.ok(result, '两层都有命中时应该返回请求体');
      assert.ok(result.userText.includes('[主题记忆]'), '主题段要有自己的标题');
      assert.ok(result.userText.includes('- 家庭成员特长：姐姐缝扣子手巧，弟弟专拆遥控器'), '主题行带标题与摘要');
      assert.ok(result.userText.includes('[原子记忆]'), '原子段要有自己的标题');
      assert.ok(result.userText.includes('[preference] 用户不吃香菜'), '原子记忆的 kind 与正文都要在');
      assert.ok(
        result.userText.indexOf('[主题记忆]') < result.userText.indexOf('[原子记忆]'),
        '主题段必须排在原子段之前',
      );
      assert.ok(result.userText.endsWith('\n\n介绍一下你的家人'), '用户原话仍在证据块之后');
    } finally {
      await stub.close();
    }
  });

  test('主题记忆那条路失败 → 原子记忆照常进证据块', async () => {
    const stub = await startStub((req) => {
      if (req.method === 'GET' && req.path.startsWith('/v1/scopes')) {
        return { json: { items: [{ scope_id: 'scp_1', title: 'dsh-pet:main' }] } };
      }
      if (req.path === '/v1/topic-memory/search') return { status: 500, json: {} };
      return { json: { mode: 'hybrid', hits: [{ memory: { kind: 'fact', text: '用户养了一只猫' } }] } };
    });
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      const result = await provider.recall?.(recallRequest(), new AbortController().signal);
      assert.ok(result, '一层失败不该让整轮召回作废');
      assert.ok(result.userText.includes('用户养了一只猫'));
      assert.ok(!result.userText.includes('[主题记忆]'), '没有主题命中就不该出现主题段标题');
    } finally {
      await stub.close();
    }
  });

  test('没有命中 → 返回 undefined，不拿空证据块去污染提示词', async () => {
    const stub = await startStub(defaultHandler({ hits: [] }));
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      assert.equal(await provider.recall?.(recallRequest(), new AbortController().signal), undefined);
    } finally {
      await stub.close();
    }
  });

  test('命中过多过长 → 证据块按字节封顶，靠后的整条丢弃', async () => {
    const original = '晚饭吃什么好';
    const long = '很长的记忆'.repeat(200);
    const hits = Array.from({ length: 10 }, (_, index) => ({
      memory: { kind: 'fact', text: index + ':' + long },
      score: 1,
      matched_by: [],
    }));
    const stub = await startStub(defaultHandler({ hits }));
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      const result = await provider.recall?.(recallRequest(original), new AbortController().signal);
      assert.ok(result);
      // 返回的 userText 是「证据块 + 空行 + 用户原话」，封顶只约束证据块那一段
      const evidenceBytes = Buffer.byteLength(result.userText, 'utf8') - Buffer.byteLength('\n\n' + original, 'utf8');
      assert.ok(evidenceBytes <= 3_072, '证据块必须封顶');
      assert.ok(result.userText.includes('0:很长的记忆'), '第一条要留下（截断也算）');
      assert.ok(!result.userText.includes('9:很长的记忆'), '末条应该被丢掉');
    } finally {
      await stub.close();
    }
  });

  test('改写成功 → 用改写结果检索', async () => {
    const stub = await startStub(defaultHandler());
    try {
      const provider = createPowerContextMemory({
        endpoint: () => stub.endpoint,
        token: () => '',
        rewrite: async () => '香菜 忌口',
      });
      await provider.recall?.(recallRequest('我女朋友是不是不吃香菜来着'), new AbortController().signal);
      const search = stub.requests.find((req) => req.path === '/v1/atomic-memory/search');
      assert.equal((search?.body as { query: string }).query, '香菜 忌口');
    } finally {
      await stub.close();
    }
  });

  test('改写拿到的是最近两轮（4 条），不是全量历史', async () => {
    const seen: Array<{ userText: string; contents: string[] }> = [];
    const stub = await startStub(defaultHandler());
    try {
      const provider = createPowerContextMemory({
        endpoint: () => stub.endpoint,
        token: () => '',
        rewrite: async (input) => {
          seen.push({ userText: input.userText, contents: input.history.map((turn) => turn.content) });
          return '它 是什么';
        },
      });
      const history: ChatTurn[] = [
        { role: 'user', content: 'm1', ts: 1 },
        { role: 'assistant', content: 'm2', ts: 2 },
        { role: 'user', content: 'm3', ts: 3 },
        { role: 'assistant', content: 'm4', ts: 4 },
        { role: 'user', content: 'm5', ts: 5 },
        { role: 'assistant', content: 'm6', ts: 6 },
      ];
      await provider.recall?.(recallRequest('那它呢', history), new AbortController().signal);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].userText, '那它呢');
      assert.deepEqual(seen[0].contents, ['m3', 'm4', 'm5', 'm6'], '只带最近两轮');
    } finally {
      await stub.close();
    }
  });

  test('改写抛错 → 退回用户原话继续检索', async () => {
    const stub = await startStub(defaultHandler());
    try {
      const provider = createPowerContextMemory({
        endpoint: () => stub.endpoint,
        token: () => '',
        rewrite: async () => {
          throw new Error('模型不可用');
        },
      });
      await provider.recall?.(recallRequest('晚饭吃什么好'), new AbortController().signal);
      const search = stub.requests.find((req) => req.path === '/v1/atomic-memory/search');
      assert.equal((search?.body as { query: string }).query, '晚饭吃什么好');
    } finally {
      await stub.close();
    }
  });

  test('改写卡住 → 预算到点就用原话，不拖住对话', async () => {
    const stub = await startStub(defaultHandler());
    try {
      const provider = createPowerContextMemory({
        endpoint: () => stub.endpoint,
        token: () => '',
        rewrite: () => new Promise<string>(() => {}),
      });
      const started = Date.now();
      await provider.recall?.(recallRequest('晚饭吃什么好'), new AbortController().signal);
      assert.ok(Date.now() - started < 2_000, '改写不能把召回拖到两秒以上');
      const search = stub.requests.find((req) => req.path === '/v1/atomic-memory/search');
      assert.equal((search?.body as { query: string }).query, '晚饭吃什么好');
    } finally {
      await stub.close();
    }
  });

  test('检索慢到 3.2s 仍能拿到结果（hybrid 要跑向量化，预算不能按 CRUD 算）', async () => {
    const stub = await startStub((req) =>
      req.path === '/v1/atomic-memory/search'
        ? {
            delayMs: 3_200,
            json: { mode: 'hybrid', hits: [{ memory: { kind: 'fact', text: '用户养了一只猫' }, score: 1 }] },
          }
        : { json: { items: [{ scope_id: 'scp_1', title: 'dsh-pet:main' }] } },
    );
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      const result = await provider.recall?.(recallRequest(), new AbortController().signal);
      assert.ok(result, '3.2s 的检索不该被掐掉');
      assert.ok(result.userText.includes('用户养了一只猫'));
    } finally {
      await stub.close();
    }
  });

  test('服务返回 500 → 返回 undefined，不抛错', async () => {
    const stub = await startStub(() => ({ status: 500, json: {} }));
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      assert.equal(await provider.recall?.(recallRequest(), new AbortController().signal), undefined);
    } finally {
      await stub.close();
    }
  });

  test('检索响应形状不对 → 当作没命中', async () => {
    const stub = await startStub((req) =>
      req.path === '/v1/atomic-memory/search'
        ? { json: { hits: 'oops' } }
        : { json: { items: [{ scope_id: 'scp_1', title: 'dsh-pet:main' }] } },
    );
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      assert.equal(await provider.recall?.(recallRequest(), new AbortController().signal), undefined);
    } finally {
      await stub.close();
    }
  });

  test('配了令牌 → 请求带上 Bearer 头', async () => {
    const headers: string[] = [];
    const server = createServer((incoming, outgoing) => {
      headers.push(String(incoming.headers.authorization ?? ''));
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ items: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const provider = createPowerContextMemory({
        endpoint: () => 'http://127.0.0.1:' + port,
        token: () => 'tk-123',
      });
      await provider.recall?.(recallRequest(), new AbortController().signal);
      assert.equal(headers[0], 'Bearer tk-123');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('PowerContext —— 存储', () => {
  const turn: CaptureTurn = { petId: 'main', userText: '以后别放香菜', replyText: '记住啦', ts: 1_700_000_000_000 };

  test('把这一轮问答写成一条证据，来源 id 可复现', async () => {
    const stub = await startStub((req) => {
      if (req.method === 'POST' && req.path === '/v1/sources/content')
        return { status: 202, json: { status: 'accepted' } };
      return { json: { items: [{ scope_id: 'scp_1', title: 'dsh-pet:main' }] } };
    });
    try {
      const provider = createPowerContextMemory({ endpoint: () => stub.endpoint, token: () => '' });
      await provider.capture?.(turn);
      await provider.capture?.(turn);
      const posts = stub.requests.filter((req) => req.method === 'POST' && req.path === '/v1/sources/content');
      assert.equal(posts.length, 2);
      const body = posts[0].body as { scope_id: string; source_id: string; content: string; metadata?: unknown };
      assert.equal(body.scope_id, 'scp_1');
      assert.equal(body.source_id, 'dsh-pet:1700000000000');
      assert.ok(body.content.includes('以后别放香菜') && body.content.includes('记住啦'), '问答都要写进去');
      assert.equal(body.metadata, undefined, '只传 scope_id / source_id / content 三个必填字段');
      assert.equal((posts[1].body as { source_id: string }).source_id, body.source_id, '重试不该产生第二条');
    } finally {
      await stub.close();
    }
  });

  test('地址没配 → 不发请求也不抛错', async () => {
    const stub = await startStub(defaultHandler());
    try {
      const provider = createPowerContextMemory({ endpoint: () => '', token: () => '' });
      await provider.capture?.(turn);
      assert.equal(stub.requests.length, 0);
    } finally {
      await stub.close();
    }
  });
});
