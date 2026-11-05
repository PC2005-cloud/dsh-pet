import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createChatMemory, type ChatMemoryInput } from './plugin/chat-memory.ts';
import { boundedHistory } from './memory-context.ts';
import { DEFAULT_CHAT_MEMORY, chatMemoryConfigValid } from '../shared/chat-memory-config.ts';
import { readAllConfig } from './config.ts';

/** Controlled HTTP boundary; generation is deliberately fake and is not a memory-quality benchmark. */
async function fixture(backend: 'native' | 'powercontext' = 'powercontext') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pet-powercontext-'));
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const scopes = new Map<string, string>();
  const sources = new Map<string, string>();
  let failCapture = false;
  let captureErrorStatus = 503;
  const disposers: Array<() => void> = [];
  let failPrepare = false;
  let invalidContext = false;
  let captureWait: Promise<void> | undefined;
  let captureStarted: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    await once(request, 'end');
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    calls.push({ path: request.url!, body });
    response.setHeader('content-type', 'application/json');
    const reply = (value: unknown, status = 200) => {
      response.statusCode = status;
      response.end(JSON.stringify(value));
    };
    if (request.url === '/v1/scopes') {
      const key = String(body.idempotency_key);
      if (!scopes.has(key)) scopes.set(key, 'scope-' + scopes.size);
      reply({ scope_id: scopes.get(key) });
    } else if (request.url === '/v1/sources/content') {
      captureStarted?.();
      await captureWait;
      if (failCapture) return reply({ detail: 'not available' }, captureErrorStatus);
      const id = String(body.source_id);
      if (sources.has(id)) assert.equal(sources.get(id), body.content);
      sources.set(id, String(body.content));
      reply({ status: 'accepted', source: { name: 'content', source_id: id }, position: sources.size }, 202);
    } else if (request.url === '/v1/context/prepare') {
      if (failPrepare) return reply({}, 503);
      const content = '历史证据：喜欢无糖咖啡。';
      reply({
        schema: 'powercontext.prepared-context.v1',
        status: 'ready',
        content,
        content_bytes: invalidContext ? 0 : Buffer.byteLength(content),
      });
    } else reply({}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const configPaths = {
    defaultFile: fileURLToPath(new URL('../../assets/config.jsonc', import.meta.url)),
    userFile: join(root, 'main-config.jsonc'),
    petDir: join(root, 'pet'),
  };
  const config = {
    chatMemoryRounds: 1,
    chatMemory: { ...DEFAULT_CHAT_MEMORY, backend, serverUrl: url },
    chatImageEnabled: false,
    chatAnimationEnabled: false,
  };
  await writeFile(configPaths.userFile, JSON.stringify(config));
  const requests: Array<Record<string, unknown>> = [];
  const makeMemory = () =>
    createChatMemory({
      ctx: {
        effect: (start: () => () => void) => {
          disposers.push(start());
        },
        agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
        llm: {
          stream: async function* (options: Record<string, unknown>) {
            requests.push(options);
            yield { type: 'text-delta', index: 0, text: '记住啦' };
          },
        },
      },
      configPaths,
      log: { info() {}, warn() {}, error() {} },
      memeDirsFor: () => [],
      playback: { create: () => ({ playbackId: 'unused' }) },
      state: { writePet() {} },
      userRoot: root,
    } as unknown as ChatMemoryInput);
  return {
    root,
    calls,
    sources,
    requests,
    config,
    configPaths,
    makeMemory,
    setFailCapture: (value: boolean) => {
      failCapture = value;
    },
    setCaptureConflict: () => {
      failCapture = true;
      captureErrorStatus = 409;
    },
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
    setFailPrepare: (value: boolean) => {
      failPrepare = value;
    },
    setInvalidContext: () => {
      invalidContext = true;
    },
    pauseCapture: () => {
      const started = new Promise<void>((resolve) => {
        captureStarted = resolve;
      });
      let release = () => {};
      captureWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { started, release };
    },
    close: async () => {
      for (const dispose of disposers.splice(0)) dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('native mode keeps the original prompt and makes no PowerContext requests', async () => {
  const f = await fixture('native');
  try {
    const memory = f.makeMemory();
    assert.equal((await memory.chatWithPet('main', '你好')).ok, true);
    await memory.syncMemory('main');
    assert.equal(f.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(f.requests), /PowerContext/);
    assert.equal((await memory.memoryStatus('main')).backend, 'native');
  } finally {
    await f.close();
  }
});

test('the real chat assembly injects exact evidence as user content, preserves persona, and captures both roles', async () => {
  const f = await fixture();
  try {
    const memory = f.makeMemory();
    assert.equal((await memory.chatWithPet('main', '我喜欢咖啡')).ok, true);
    await memory.syncMemory('main');
    const request = f.requests[0];
    assert.doesNotMatch(String(request.system), /历史证据：喜欢无糖咖啡/);
    const messages = request.messages as Array<{ role: string; content: Array<{ text: string }> }>;
    assert.equal(messages[messages.length - 1]?.role, 'user');
    assert.match(messages[messages.length - 1]!.content[0].text, /历史证据：喜欢无糖咖啡。$/);
    assert.equal(messages[messages.length - 1]!.content.slice(-1)[0].text, '我喜欢咖啡');
    const stored = JSON.parse([...f.sources.values()][0]);
    assert.deepEqual(stored.messages, [
      { role: 'user', content: '我喜欢咖啡' },
      { role: 'assistant', content: '记住啦' },
    ]);
    assert.doesNotMatch([...f.sources.values()][0], /历史证据|Bearer/);
    assert.equal((await memory.memoryStatus('main')).pending, 0);
    assert.equal((await memory.memoryStatus('main')).captured, 1);
  } finally {
    await f.close();
  }
});

test('failed ingestion survives restart and retries the same exact Source without resending older turns', async () => {
  const f = await fixture();
  try {
    f.setFailCapture(true);
    const first = f.makeMemory();
    await first.chatWithPet('main', '周五演示');
    await first.syncMemory('main');
    assert.equal((await first.memoryStatus('main')).pending, 1);
    const failed = f.calls.find((call) => call.path === '/v1/sources/content')!.body;
    const restarted = f.makeMemory();
    f.setFailCapture(false);
    await restarted.syncMemory('main');
    const last = f.calls.filter((call) => call.path === '/v1/sources/content').slice(-1)[0].body;
    assert.deepEqual(last, failed);
    await restarted.chatWithPet('main', '现在改成喝茶');
    await restarted.syncMemory('main');
    assert.equal(f.sources.size, 2);
    assert.equal((await restarted.memoryStatus('main')).captured, 2);
    assert.equal((await first.memoryStatus('main')).scopeId, (await restarted.memoryStatus('main')).scopeId);
  } finally {
    await f.close();
  }
});

test('unavailable or malformed recall does not inject evidence or prevent a normal reply', async () => {
  const f = await fixture();
  try {
    f.setFailPrepare(true);
    const memory = f.makeMemory();
    assert.equal((await memory.chatWithPet('main', '你好')).ok, true);
    await memory.syncMemory('main');
    f.setFailPrepare(false);
    f.setInvalidContext();
    assert.equal((await memory.chatWithPet('main', '再聊聊')).ok, true);
    await memory.syncMemory('main');
    assert.doesNotMatch(JSON.stringify(f.requests), /历史证据：喜欢/);
    assert.equal((await memory.memoryStatus('main')).recall, 'unavailable');
  } finally {
    await f.close();
  }
});

test('different pets use isolated persistent scopes and local deletion cancels pending evidence', async () => {
  const f = await fixture();
  try {
    const defaults = readAllConfig(f.configPaths).main;
    const firstPet = (defaults.pets as Array<Record<string, unknown>>)[0];
    const pets = [firstPet, { ...firstPet, id: 'second', name: '第二只' }];
    await writeFile(f.configPaths.userFile, JSON.stringify({ ...f.config, pets }));
    f.setFailCapture(true);
    const memory = f.makeMemory();
    await memory.chatWithPet('main', '第一只的偏好');
    await memory.syncMemory('main');
    await memory.chatWithPet('second', '第二只的偏好');
    await memory.syncMemory('second');
    const originalScope = (await memory.memoryStatus('main')).scopeId;
    assert.notEqual(originalScope, (await memory.memoryStatus('second')).scopeId);
    await memory.deleteHistory('main');
    assert.equal((await memory.memoryStatus('main')).pending, 0);
    assert.equal(
      (await memory.memoryStatus('main')).scopeId,
      originalScope,
      'local deletion must not silently lose the remote binding',
    );
    assert.equal((await memory.memoryStatus('second')).pending, 1);
  } finally {
    await f.close();
  }
});

test('recent history budget keeps whole rounds and measures Chinese in UTF-8 bytes', () => {
  const messages = [
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '旧回答' },
    { role: 'user', content: '茶' },
    { role: 'assistant', content: '好' },
  ];
  assert.deepEqual(boundedHistory(messages, 10, 6), messages.slice(-2));
  assert.deepEqual(boundedHistory(messages, 10, 5), []);
  assert.deepEqual(boundedHistory(messages, 0, 0), []);
  assert.deepEqual(boundedHistory(messages, 1, 0), messages.slice(-2));
});

test('configuration rejects inline credentials, remote cleartext, and unsupported budgets', () => {
  assert.equal(chatMemoryConfigValid(DEFAULT_CHAT_MEMORY), true);
  for (const serverUrl of ['https://user:secret@example.com', 'http://example.com', 'https://example.com?key=x'])
    assert.equal(chatMemoryConfigValid({ ...DEFAULT_CHAT_MEMORY, serverUrl }), false);
  assert.equal(chatMemoryConfigValid({ ...DEFAULT_CHAT_MEMORY, token: 'secret' }), false);
  assert.equal(chatMemoryConfigValid({ ...DEFAULT_CHAT_MEMORY, maxRecallBytes: 511 }), false);
});

test('a pending network upload does not block the next chat response', async () => {
  const f = await fixture();
  const held = f.pauseCapture();
  try {
    const memory = f.makeMemory();
    await memory.chatWithPet('main', '第一句');
    await held.started;
    assert.equal((await memory.chatWithPet('main', '第二句')).ok, true);
    assert.equal((await memory.memoryStatus('main')).pending, 2);
    held.release();
    await memory.syncMemory('main');
    assert.equal(f.sources.size, 2);
  } finally {
    held.release();
    await f.close();
  }
});

test('an invalid journal is preserved and never replaced with new remote identities', async () => {
  const f = await fixture();
  try {
    const file = join(f.root, 'memory.json');
    await writeFile(file, '{broken journal');
    await assert.rejects(f.makeMemory().chatWithPet('main', '你好'), /memory is invalid/);
    assert.equal(await readFile(file, 'utf8'), '{broken journal');
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('host disposal leaves an in-flight Source pending for idempotent recovery', async () => {
  const f = await fixture();
  const held = f.pauseCapture();
  try {
    const memory = f.makeMemory();
    await memory.chatWithPet('main', '请记住这句话');
    await held.started;
    const upload = memory.syncMemory('main');
    f.dispose();
    held.release();
    await upload;
    assert.equal((await memory.memoryStatus('main')).pending, 1);
    const restarted = f.makeMemory();
    await restarted.syncMemory('main');
    assert.equal((await restarted.memoryStatus('main')).pending, 0);
    assert.equal(f.sources.size, 1);
  } finally {
    held.release();
    await f.close();
  }
});

test('a Source identity conflict stays blocked even if a later recall fails differently', async () => {
  const f = await fixture();
  try {
    f.setCaptureConflict();
    const memory = f.makeMemory();
    await memory.chatWithPet('main', '第一句话');
    await memory.syncMemory('main');
    const attempts = f.calls.filter((call) => call.path === '/v1/sources/content').length;
    f.setFailPrepare(true);
    await memory.chatWithPet('main', '第二句话');
    await memory.syncMemory('main');
    assert.equal(f.calls.filter((call) => call.path === '/v1/sources/content').length, attempts);
    assert.equal((await memory.memoryStatus('main')).pending, 2);
    assert.equal((await memory.memoryStatus('main')).error, 'http_409');
  } finally {
    await f.close();
  }
});
