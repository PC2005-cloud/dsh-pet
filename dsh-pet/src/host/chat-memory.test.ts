/**
 * 对话记忆写入的单元测试 —— 钉住「聊天记录存档」的两类图信息：
 * 带图那一轮 user 消息记下附件引用、配图那一轮 assistant 消息记下表情包名；
 * 不带图那一轮两条消息的字段集合必须与加字段前完全一致（纯增量，不破坏旧格式）。
 *
 * 走真实 memory.json 落盘（临时目录隔离），默认配置取仓库内 assets/config.jsonc（与生产同一份，
 * 不手抄第二份）；LLM 用假流驱动、不联网。
 *
 * 跑法：node --experimental-strip-types --test src/host/chat-memory.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createChatMemory, type ChatMemoryInput } from './plugin/chat-memory.ts';
import type { ChatMemoryMessage } from './chat.ts';
import type { ConfigPaths } from './config.ts';
import type { PetImageRef } from './image-attachment.ts';

/** 一条已落盘的图片引用：字段与附件服务返回的一致。 */
const IMAGE: PetImageRef = {
  attachmentId: '9f2c4a1b',
  mediaType: 'image/png',
  bytes: 10108,
  width: 257,
  height: 173,
};

/** 一份假 ctx：对话生成只读 agentDefaultModel 与 llm.stream，reply 为模型回的那句。 */
function fakeCtx(reply: string): unknown {
  return {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    llm: {
      stream: () =>
        (async function* () {
          yield { type: 'text-delta', index: 0, text: reply };
        })(),
    },
  };
}

/** 临时工作区：用户配置与记忆目录隔离，默认配置指回仓库里那一份。 */
function tempWorkspace(overlay: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-memory-test-'));
  const configPaths: ConfigPaths = {
    defaultFile: fileURLToPath(new URL('../../assets/config.jsonc', import.meta.url)),
    userFile: join(dir, 'main-config.jsonc'),
    petDir: join(dir, 'pet'), // 不存在 = 无文件宠物
  };
  writeFileSync(configPaths.userFile, JSON.stringify(overlay));
  return { dir, configPaths, memeDir: join(dir, 'memes'), userRoot: join(dir, 'user') };
}

/** 造一份对话记忆；memeDir 缺省 = 没有表情包目录（池为空）。
 *  `collect.writes` 记下每次写气泡叶子的「宠物.叶子」，`collect.records` 连同载荷一起留（断言字段用）。 */
function createMemory(
  reply: string,
  ws: ReturnType<typeof tempWorkspace>,
  memeDir?: string,
  collect?: {
    writes?: string[];
    records?: Array<{ petId: string; leaf: string; data: Record<string, unknown> }>;
  },
) {
  return createChatMemory({
    ctx: fakeCtx(reply),
    configPaths: ws.configPaths,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    memeDirsFor: () => (memeDir === undefined ? [] : [memeDir]),
    state: {
      writePet: (petId: string, leaf: string, data: Record<string, unknown>) => {
        collect?.writes?.push(petId + '.' + leaf);
        collect?.records?.push({ petId, leaf, data });
      },
    },
    userRoot: ws.userRoot,
  } as unknown as ChatMemoryInput);
}

/** 读回刚落盘的记忆消息（只应有一只宠物一个分桶）。 */
function readMessages(userRoot: string): ChatMemoryMessage[] {
  const mem = JSON.parse(readFileSync(join(userRoot, 'memory.json'), 'utf8')) as Record<
    string,
    Record<string, { messages: ChatMemoryMessage[] }>
  >;
  const buckets = Object.values(mem).flatMap((byPet) => Object.values(byPet));
  const bucket = buckets[0];
  assert.ok(bucket && buckets.length === 1, '应当只写入一只宠物的记忆');
  return bucket.messages;
}

describe('createChatMemory —— 图信息写入记忆文件', () => {
  test('带图的一轮：user 原样记下附件引用，assistant 不凭空多出 meme 字段', async () => {
    const ws = tempWorkspace();
    try {
      const r = await createMemory('好看', ws).chatWithPet('main', '看看这个', IMAGE);
      assert.equal(r.ok, true);
      const messages = readMessages(ws.userRoot);
      assert.equal(messages.length, 2);
      const assistant = messages[1];
      assert.ok(assistant);
      assert.deepEqual(messages[0]?.image, IMAGE, 'user 消息应原样存下附件引用');
      assert.equal('meme' in assistant, false, '这一轮没配图，不得写 meme 字段');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('不带图的一轮：两条消息的字段集合与加字段前逐字节一致', async () => {
    const ws = tempWorkspace();
    try {
      const r = await createMemory('在的', ws).chatWithPet('main', '在吗');
      assert.equal(r.ok, true);
      const messages = readMessages(ws.userRoot);
      assert.equal(messages.length, 2);
      for (const m of messages) {
        assert.deepEqual(Object.keys(m).sort(), ['content', 'role', 'ts'], '不该出现 image / meme 字段');
      }
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('配图的一轮：assistant 记下表情包名，正文里的标记仍被剥离', async () => {
    const ws = tempWorkspace({ chatImageEnabled: true, memes: { 可爱: '卖萌立绘' } });
    mkdirSync(ws.memeDir, { recursive: true });
    writeFileSync(join(ws.memeDir, '可爱.png'), '');
    try {
      const r = await createMemory('你好呀\n[图:可爱]', ws, ws.memeDir).chatWithPet('main', '在吗');
      assert.equal(r.ok, true);
      const assistant = readMessages(ws.userRoot)[1];
      assert.ok(assistant);
      assert.equal(assistant.meme, '可爱', 'assistant 消息应记下配图名');
      assert.equal(assistant.content, '你好呀', '配图标记属于展示层，不得留在记忆正文里');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
});

describe('createChatMemory —— 指定配图的碎碎念', () => {
  /** 池里两张图、文件都在；自动配图开关关着，用来验证「点名不受自动开关门控」。 */
  function poolWorkspace() {
    const ws = tempWorkspace({ whisperImageEnabled: false, memes: { 可爱: '卖萌立绘', 生气: '鼓腮帮子' } });
    mkdirSync(ws.memeDir, { recursive: true });
    writeFileSync(join(ws.memeDir, '可爱.png'), '');
    writeFileSync(join(ws.memeDir, '生气.png'), '');
    return ws;
  }

  test('点名池内的图：用这张说话，自动配图开关关着也生效', async () => {
    const ws = poolWorkspace();
    const writes: string[] = [];
    try {
      const r = await createMemory('随便一句', ws, ws.memeDir, { writes }).publishWhisper('main', '生气');
      assert.equal(r.ok, true);
      assert.equal(r.ok === true ? r.image : '', '生气', '必须用点名的那张，不能随机抽');
      assert.deepEqual(writes, ['main.say'], '成功时写一次气泡叶子');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('点名不存在的图：unknown-image，且不写气泡', async () => {
    const ws = poolWorkspace();
    const writes: string[] = [];
    try {
      const r = await createMemory('不该生成', ws, ws.memeDir, { writes }).publishWhisper('main', '查无此图');
      assert.equal(r.ok, false);
      assert.equal(r.ok === false ? r.reason : '', 'unknown-image');
      assert.deepEqual(writes, [], '明确失败时不写叶子，否则等于静默换了一张');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('配置写了但图片文件已删：同样 unknown-image（池判定含文件存在性）', async () => {
    const ws = poolWorkspace();
    rmSync(join(ws.memeDir, '生气.png'));
    try {
      const r = await createMemory('不该生成', ws, ws.memeDir).publishWhisper('main', '生气');
      assert.equal(r.ok === false ? r.reason : '', 'unknown-image');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('不点名：保持原行为（开关关 = 纯文本，不带 image）', async () => {
    const ws = poolWorkspace();
    try {
      const r = await createMemory('纯文本一句', ws, ws.memeDir).publishWhisper('main');
      assert.equal(r.ok, true);
      assert.equal(r.ok === true && 'image' in r, false, '自动配图关闭时不该带图');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('voiceTo：传了就用传的，没传按 display 推导（默认宠物 display=both → desktop）', async () => {
    const ws = poolWorkspace();
    const records: Array<{ petId: string; leaf: string; data: Record<string, unknown> }> = [];
    try {
      await createMemory('随便一句', ws, ws.memeDir, { records }).publishWhisper('main', undefined, 'web');
      assert.equal(records[0]?.data.voiceTo, 'web', '显式传入优先于 display');

      await createMemory('纯文本一句', ws, ws.memeDir, { records }).publishWhisper('main');
      assert.equal(records[1]?.data.voiceTo, 'desktop', '没传时按 display 推导：桌面优先');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
  test('kind=whisper 受 voiceWhisperEnabled 管；手动（缺省 kind）不受它管', async () => {
    const off = poolWorkspace();
    const offRecords: Array<{ petId: string; leaf: string; data: Record<string, unknown> }> = [];
    try {
      await createMemory('一句', off, off.memeDir, { records: offRecords }).publishWhisper(
        'main',
        undefined,
        undefined,
        'whisper',
      );
      assert.equal('voiceTo' in (offRecords[0]?.data ?? {}), false, '开关关着时周期碎碎念不该写 voiceTo');

      await createMemory('一句', off, off.memeDir, { records: offRecords }).publishWhisper('main');
      assert.equal(offRecords[1]?.data.voiceTo, 'desktop', '手动触发不看那个开关，照常按 display 推导');
    } finally {
      rmSync(off.dir, { recursive: true, force: true });
    }

    const on = tempWorkspace({ voiceWhisperEnabled: true });
    const onRecords: Array<{ petId: string; leaf: string; data: Record<string, unknown> }> = [];
    try {
      await createMemory('一句', on, undefined, { records: onRecords }).publishWhisper(
        'main',
        undefined,
        undefined,
        'whisper',
      );
      assert.equal(onRecords[0]?.data.voiceTo, 'desktop', '开关打开后周期碎碎念照常带 voiceTo');
    } finally {
      rmSync(on.dir, { recursive: true, force: true });
    }
  });
});

describe('createChatMemory —— 对话回复的 voiceTo', () => {
  test('回复写叶子时带上该由哪一端念（对话请求没有具体端，按 display 推导）', async () => {
    const ws = tempWorkspace();
    const records: Array<{ petId: string; leaf: string; data: Record<string, unknown> }> = [];
    try {
      const r = await createMemory('在的', ws, undefined, { records }).chatWithPet('main', '在吗');
      assert.equal(r.ok, true);
      assert.equal(records[0]?.data.voiceTo, 'desktop', '默认宠物 display=both，桌面优先');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
});

describe('createChatMemory —— 删除对话记忆', () => {
  /** 预置一份带两轮记忆的文件（时间戳固定，避免依赖真实时钟）。 */
  function seed(userRoot: string): void {
    mkdirSync(userRoot, { recursive: true });
    const messages = [
      { role: 'user', content: '第一问', ts: 1000 },
      { role: 'assistant', content: '第一答', ts: 1000 },
      { role: 'user', content: '第二问', ts: 2000 },
      { role: 'assistant', content: '第二答', ts: 2000 },
    ];
    writeFileSync(join(userRoot, 'memory.json'), JSON.stringify({ main: { main: { messages } } }));
  }

  test('按 ts 删：命中的轮成对移除，其余轮原样保留', async () => {
    const ws = tempWorkspace();
    seed(ws.userRoot);
    try {
      const r = await createMemory('无关', ws).deleteHistory('main', [1000]);
      assert.deepEqual(r, { ok: true, removed: 2 });
      const rest = readMessages(ws.userRoot);
      assert.deepEqual(
        rest.map((m) => m.content),
        ['第二问', '第二答'],
        '只删 ts=1000 的两条，另一轮必须完整留下',
      );
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('不存在的 ts → removed 为 0，文件内容不变（不因空操作重写记忆）', async () => {
    const ws = tempWorkspace();
    seed(ws.userRoot);
    const before = readFileSync(join(ws.userRoot, 'memory.json'), 'utf8');
    try {
      const r = await createMemory('无关', ws).deleteHistory('main', [999]);
      assert.deepEqual(r, { ok: true, removed: 0 });
      assert.equal(readFileSync(join(ws.userRoot, 'memory.json'), 'utf8'), before);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('不带 ts → 清空整只，并把空叶子与空条目一起摘掉', async () => {
    const ws = tempWorkspace();
    seed(ws.userRoot);
    try {
      const r = await createMemory('无关', ws).deleteHistory('main');
      assert.deepEqual(r, { ok: true, removed: 4 });
      const mem = JSON.parse(readFileSync(join(ws.userRoot, 'memory.json'), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(mem, {}, '清空后不应残留空条目或空宠物叶子');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('宠物不存在 → unknown-pet，且不写文件', async () => {
    const ws = tempWorkspace();
    try {
      const r = await createMemory('无关', ws).deleteHistory('nobody');
      assert.equal(r.ok, false);
      assert.equal(r.ok === false ? r.reason : '', 'unknown-pet');
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
});
