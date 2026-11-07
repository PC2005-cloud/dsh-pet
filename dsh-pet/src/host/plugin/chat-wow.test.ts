import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createChatMemory } from './chat-memory.ts';
import { createFileLogger } from '../log-file.ts';
import { PlaybackStore } from '../playback.ts';
import { PollStateStore } from '../state.ts';

test('the real chat pipeline sends a transient frame once and saves only the verified reply, never pixels or injected context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wow-chat-'));
  const userFile = join(root, 'config.jsonc');
  await writeFile(
    userFile,
    JSON.stringify({ chatImageEnabled: false, chatAnimationEnabled: false, chatMemoryRounds: 5 }),
  );
  const log = createFileLogger({ file: join(root, 'log.txt'), base: {} });
  const state = new PollStateStore();
  const playback = new PlaybackStore();
  const frames: unknown[] = [];
  const image = {
    dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgD/2Q==',
    width: 100,
    height: 100,
    capturedAt: Date.now(),
    game: 'retail' as const,
    windowTitle: 'fixture',
  };
  const chat = createChatMemory({
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
      llm: {
        supportsTransientImages: true,
        stream(options: unknown) {
          frames.push(options);
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'text-delta', index: 0, text: 'MODEL-ANSWER' };
            },
          };
        },
      },
    },
    configPaths: {
      defaultFile: fileURLToPath(new URL('../../../assets/config.jsonc', import.meta.url)),
      userFile,
      petDir: join(root, 'pets'),
    },
    log,
    playback,
    state,
    userRoot: root,
    memeDirsFor: () => [],
    wow: {
      context: () => 'INJECTED-GAME-CONTEXT',
      prepareChat: async () => ({ context: 'INJECTED-GAME-CONTEXT', transientImage: image, tools: { context: '' } }),
      finishChat: async () => 'VERIFIED-RECEIPT-ANSWER',
    },
  });
  try {
    const result = await chat.chatWithPet('main', '看看游戏画面');
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.text === 'VERIFIED-RECEIPT-ANSWER');
    assert.equal(frames.length, 1);
    assert.match(JSON.stringify(frames), /data:image\/jpeg/);
    assert.match(JSON.stringify(frames), /INJECTED-GAME-CONTEXT/);
    const memory = await readFile(chat.memoryPath, 'utf8');
    assert.match(memory, /看看游戏画面/);
    assert.match(memory, /VERIFIED-RECEIPT-ANSWER/);
    assert.doesNotMatch(memory, /data:image|base64|INJECTED-GAME-CONTEXT|MODEL-ANSWER|capturedAt/);
    assert.equal(chat.isBusy(), false);
  } finally {
    playback.cancelAll();
    state.cancelAll();
    log.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
