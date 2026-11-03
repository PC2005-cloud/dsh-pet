/**
 * 设置页与宿主 HTTP 契约的契约测试。
 *
 * 三条契约：
 *   1. 失败不抛：读接口失败返回 `null`，写接口失败返回判别联合，调用方只管分支与文案；
 *   2. 写配置强制显式 `force`：只有严格 `true` 才拼 `?force=1`（事件对象绝不能冒充真值绕过损坏预检）；
 *   3. 失败看体里的 `reason`：`user-config-unparsable` = 损坏（带出宿主给的真实写入路径）、
 *      `bad-request` / `invalid-json` = 校验失败、其余否定实体与非 2xx = 通用错误。
 *
 * 每个用例都换掉 `globalThis.fetch`，结束时还原——不发真实请求。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSaveBody,
  loadConfig,
  loadMeta,
  loadModelCatalog,
  saveConfig,
  syncConfig,
  type SaveFields,
} from './http.ts';

/** 一次请求的记录。 */
interface Call {
  url: string;
  init?: RequestInit;
}

/** 换掉全局 fetch，跑一段用例，最后还原。 */
async function withFetch(
  handler: (url: string, init?: RequestInit) => Response,
  run: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(handler(String(input), init));
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = previous;
  }
}

/** JSON 响应。 */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('loadConfig —— 读成品配置', () => {
  test('2xx 返回聚合；非 2xx 与网络错误都返回 null', async () => {
    await withFetch(
      () => json({ main: { pets: [] } }),
      async () => {
        assert.deepEqual(await loadConfig(), { main: { pets: [] } });
      },
    );
    await withFetch(
      () => json({}, 500),
      async () => {
        assert.equal(await loadConfig(), null);
      },
    );
    await withFetch(
      () => {
        throw new Error('断网');
      },
      async () => {
        assert.equal(await loadConfig(), null, '网络错误不能让设置页崩掉');
      },
    );
  });

  test('把 AbortSignal 带进请求（卸载时能中断）', async () => {
    const controller = new AbortController();
    await withFetch(json0, async (calls) => {
      await loadConfig(controller.signal);
      assert.equal(calls[0].init?.signal, controller.signal);
    });
  });
});

/** 固定返回空对象。 */
function json0(): Response {
  return json({ main: { pets: [] } });
}

describe('loadMeta / loadModelCatalog —— 读元信息与候选清单', () => {
  test('meta：2xx 返回原文，非 2xx 返回 null', async () => {
    await withFetch(
      () => json({ user: 'u', default: 'd', animations: 'a' }),
      async () => {
        assert.equal((await loadMeta())?.user, 'u');
      },
    );
    await withFetch(
      () => json({}, 404),
      async () => {
        assert.equal(await loadMeta(), null);
      },
    );
  });

  test('候选清单：providers 是数组才认，否则返回 null（选择器显示拉取失败）', async () => {
    await withFetch(
      () => json({ providers: [{ id: 'a', name: 'A', models: [] }] }),
      async () => {
        assert.deepEqual(await loadModelCatalog(), [{ id: 'a', name: 'A', models: [] }]);
      },
    );
    await withFetch(
      () => json({ providers: 'nope' }),
      async () => {
        assert.equal(await loadModelCatalog(), null);
      },
    );
    await withFetch(
      () => json({}, 503),
      async () => {
        assert.equal(await loadModelCatalog(), null);
      },
    );
  });
});

describe('saveConfig —— 写配置', () => {
  const body = { pets: [] };

  test('成功：PUT + JSON 头，返回成品聚合；不带 force 参数', async () => {
    await withFetch(
      () => json({ main: { pets: [] } }),
      async (calls) => {
        const outcome = await saveConfig(body, false);
        assert.equal(outcome.kind, 'ok');
        assert.deepEqual(outcome.kind === 'ok' ? outcome.merged : null, { main: { pets: [] } });
        assert.equal(calls[0].url.endsWith('/config'), true, '不带参数时 URL 不能有 ?force=1');
        assert.equal(calls[0].init?.method, 'PUT');
        assert.equal((calls[0].init?.headers as Record<string, string>)['content-type'], 'application/json');
        assert.equal(calls[0].init?.body, JSON.stringify(body));
      },
    );
  });

  test('force 严格为 true 才拼 ?force=1（事件对象不算）', async () => {
    await withFetch(
      () => json({ main: { pets: [] } }),
      async (calls) => {
        await saveConfig(body, true);
        assert.equal(calls[0].url.endsWith('/config?force=1'), true);
      },
    );
    await withFetch(
      () => json({ main: { pets: [] } }),
      async (calls) => {
        // React 会把 MouseEvent 当第一实参传进 onClick，这里复现那种「真值但不是 true」的输入。
        await saveConfig(body, { type: 'click' } as unknown as boolean);
        assert.equal(calls[0].url.endsWith('/config'), true, '非严格 true 绝不能拼 force');
      },
    );
  });

  test('user-config-unparsable：返回损坏结果并带出宿主给的真实写入路径', async () => {
    await withFetch(
      () => json({ ok: false, reason: 'user-config-unparsable', userFile: 'C:/x/main-config.jsonc' }),
      async () => {
        assert.deepEqual(await saveConfig(body, true), { kind: 'corrupt', userFile: 'C:/x/main-config.jsonc' });
      },
    );
    await withFetch(
      () => json({ ok: false, reason: 'user-config-unparsable' }),
      async () => {
        assert.deepEqual(await saveConfig(body, true), { kind: 'corrupt', userFile: null }, '没有 userFile 时也不能抛');
      },
    );
  });

  test('bad-request 是校验失败、其余否定实体与非 2xx 是通用错误、网络错误也是通用错误', async () => {
    await withFetch(
      () => json({ ok: false, reason: 'bad-request' }),
      async () => {
        assert.deepEqual(await saveConfig(body, false), { kind: 'invalid' });
      },
    );
    await withFetch(
      () => json({}, 500),
      async () => {
        assert.deepEqual(await saveConfig(body, false), { kind: 'error' });
      },
    );
    await withFetch(
      () => {
        throw new Error('断网');
      },
      async () => {
        assert.deepEqual(await saveConfig(body, false), { kind: 'error' });
      },
    );
  });
});

describe('syncConfig —— 同步内置默认', () => {
  test('成功返回成品聚合，失败返回 null', async () => {
    await withFetch(
      () => json({ main: { pets: [] } }),
      async (calls) => {
        assert.deepEqual(await syncConfig(), { main: { pets: [] } });
        assert.equal(calls[0].init?.method, 'POST');
      },
    );
    await withFetch(
      () => json({}, 500),
      async () => {
        assert.equal(await syncConfig(), null);
      },
    );
  });
});

describe('buildSaveBody —— 请求体字段', () => {
  test('键名与宿主校验的字段一一对应，一个不多一个不少', () => {
    const fields = {
      pets: [],
      notificationsEnabled: true,
      clickSoundEnabled: false,
      whisperImageEnabled: false,
      chatImageEnabled: false,
      chatAnimationEnabled: false,
      confineToScreen: false,
      trayEnabled: true,
      voiceEnabled: true,
      voiceName: 'zh-CN-XiaoyiNeural',
      physics: {},
      whisperModel: { provider: '', model: '' },
      chatModel: { provider: '', model: '' },
      chatMemoryRounds: 5,
      chatImageLimit: 10,
      font: {},
      animationWeights: { idle: 10, turn: 5, move: 5 },
    } as unknown as SaveFields;
    assert.deepEqual(Object.keys(buildSaveBody(fields)).sort(), [
      'animationWeights',
      'chatAnimationEnabled',
      'chatImageEnabled',
      'chatImageLimit',
      'chatMemoryRounds',
      'chatModel',
      'clickSoundEnabled',
      'confineToScreen',
      'font',
      'notificationsEnabled',
      'pets',
      'physics',
      'trayEnabled',
      'voiceEnabled',
      'voiceName',
      'voiceTodoEnabled',
      'voiceVolume',
      'voiceWhisperEnabled',
      'whisperImageEnabled',
      'whisperModel',
    ]);
  });

  test('值原样带出，不做二次包装', () => {
    const fields = {
      pets: [{ id: 'pet-1' }],
      notificationsEnabled: false,
      clickSoundEnabled: true,
      whisperImageEnabled: true,
      chatImageEnabled: true,
      chatAnimationEnabled: true,
      confineToScreen: true,
      trayEnabled: false,
      physics: { gravity: 3 },
      whisperModel: { provider: 'a', model: 'b' },
      chatModel: { provider: '', model: '' },
      chatMemoryRounds: 0,
      chatImageLimit: 3,
      font: { size: 20 },
    } as unknown as SaveFields;
    const body = buildSaveBody(fields);
    assert.equal(body.chatMemoryRounds, 0);
    assert.deepEqual(body.physics, { gravity: 3 });
    assert.equal(body.notificationsEnabled, false);
  });
});
