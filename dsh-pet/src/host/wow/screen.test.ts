import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameScreenAssist, detectScreenAssistIntent } from './screen.ts';
import {
  WowScreenCapture,
  ScreenCaptureFailure,
  type GameCapturePlatform,
  type GameCaptureWindow,
} from './services/wow-screen-assist-runtime.ts';
import { createScreenAssistVisionPrompt } from './screen-policy.ts';
import { gameForCapturePath } from './screen-windows.ts';

const retail: GameCaptureWindow = {
  handle: '12345',
  processId: 100,
  processStartedAt: '45678',
  path: 'C:\\Games\\_retail_\\Wow.exe',
  title: 'World of Warcraft',
  game: 'retail',
  minimized: false,
  visible: true,
};
const image = () => ({
  dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgD/2Q==',
  width: 1920,
  height: 1080,
  capturedAt: Date.now(),
});
function fixture() {
  const calls = { discover: 0, verify: 0, capture: 0 };
  const platform: GameCapturePlatform = {
    supported: true,
    discover: async () => {
      calls.discover++;
      return [{ ...retail }];
    },
    verify: async () => {
      calls.verify++;
    },
    capture: async () => {
      calls.capture++;
      return image();
    },
  };
  return { platform, calls };
}

test('capture permission comes only from direct, current game-view requests', () => {
  assert.equal(detectScreenAssistIntent('你帮我看看我面前这个地形我走的过去吗'), 'terrain');
  assert.equal(detectScreenAssistIntent('任务显示npc在这里，但是我到了没看见，你能带我过去吗'), 'quest');
  assert.equal(detectScreenAssistIntent('/look'), 'scene');
  assert.equal(detectScreenAssistIntent('/look can I cross this bridge?'), 'terrain');
  for (const question of [
    '部落DZ怎么玩',
    '例如“帮我看看面前地形能走过去吗”',
    '翻译 /look',
    '昨天这个地形能跳过去吗',
    '帮我看一下这个浏览器画面',
    '帮我分析这张截图',
    '不要截图 /look',
    "Don't take screenshots /look",
    '```/look```',
  ]) {
    assert.equal(detectScreenAssistIntent(question), undefined, question);
  }
  const prompt = createScreenAssistVisionPrompt('NPC在哪里', 'quest');
  assert.match(prompt, /not live video/);
  assert.match(prompt, /Do not invent an NPC name/);
  assert.match(prompt, /Never operate the game/);
});

test('screen assist defaults off and never persists pixels, questions, or a prior image', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wow-screen-'));
  const { platform, calls } = fixture();
  try {
    const service = new GameScreenAssist(root, { platform });
    assert.deepEqual(service.readSettings(), { enabled: false, game: 'auto' });
    const disabled = await service.capture('/look');
    assert.ok(!disabled.ok && disabled.code === 'disabled');
    assert.equal(calls.discover, 0);
    await service.saveSettings({ enabled: true, game: 'retail' });
    assert.deepEqual(await service.capture('DZ是什么意思'), { ok: true, skipped: true });
    const result = await service.capture('/look 我的任务NPC在哪里');
    assert.ok(result.ok && 'image' in result);
    assert.equal(calls.discover, 3);
    assert.equal(calls.capture, 1);
    assert.deepEqual(readdirSync(root), ['wow-screen-assist.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'wow-screen-assist.json'), 'utf8')), {
      enabled: true,
      game: 'retail',
    });
    platform.capture = async () => {
      throw new ScreenCaptureFailure('empty-frame');
    };
    const failed = await service.capture('/look');
    assert.equal(failed.ok, false);
    assert.ok(!failed.ok && failed.code === 'empty-frame');
    assert.equal('image' in failed, false);
    await assert.rejects(service.saveSettings({ enabled: true, game: 'retail', image: 'anything' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt screenshot settings preserve the file and only disable this feature', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wow-screen-'));
  try {
    writeFileSync(join(root, 'wow-screen-assist.json'), '{invalid-json');
    const service = new GameScreenAssist(root, { platform: fixture().platform });
    assert.ok(service.readError());
    assert.deepEqual(await service.capture('DZ是什么意思'), { ok: true, skipped: true });
    const result = await service.capture('/look');
    assert.ok(!result.ok && result.code === 'invalid-settings');
    await assert.rejects(service.saveSettings({ enabled: true, game: 'retail' }), /preserved/);
    assert.equal(readFileSync(join(root, 'wow-screen-assist.json'), 'utf8'), '{invalid-json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime rejects unsupported input, no game, ambiguous windows, hidden windows, and unsigned executables before reading pixels', async () => {
  const { platform, calls } = fixture();
  const runtime = new WowScreenCapture(platform);
  assert.deepEqual(await runtime.capture({ sourceId: 'screen:0:0' }), { ok: false, code: 'invalid-request' });
  platform.supported = false;
  assert.deepEqual(await runtime.capture({}), { ok: false, code: 'unsupported-platform' });
  assert.equal(calls.discover, 0);
  platform.supported = true;
  for (const [windows, code] of [
    [[], 'game-not-found'],
    [[retail, { ...retail, handle: '2' }], 'ambiguous-window'],
    [[{ ...retail, minimized: true }], 'minimized-window'],
    [[{ ...retail, visible: false }], 'minimized-window'],
    [[{ ...retail, game: undefined }], 'unverified-game'],
  ] as const) {
    platform.discover = async () => [...windows];
    assert.deepEqual(await runtime.capture({}), { ok: false, code });
  }
  platform.discover = async () => [retail];
  platform.verify = async () => {
    throw new ScreenCaptureFailure('unverified-game');
  };
  assert.deepEqual(await runtime.capture({}), { ok: false, code: 'unverified-game' });
  assert.equal(calls.capture, 0);
});

test('explicit product selection avoids cross-version capture and rechecks the process lifetime after reading pixels', async () => {
  const { platform, calls } = fixture();
  const classic = {
    ...retail,
    handle: '67890',
    game: 'classic' as const,
    path: 'C:\\Games\\_classic_\\WowClassic.exe',
  };
  platform.discover = async () => [retail, classic];
  platform.capture = async (window) => {
    assert.equal(window.handle, classic.handle);
    return image();
  };
  const result = await new WowScreenCapture(platform).capture({ game: 'classic' });
  assert.ok(result.ok && result.image.game === 'classic');
  for (const changed of [{ processId: 999 }, { processStartedAt: '999' }, { path: 'C:\\Other\\Wow.exe' }]) {
    let reads = 0;
    platform.discover = async () => [++reads < 3 ? retail : { ...retail, ...changed }];
    platform.capture = async () => {
      calls.capture++;
      return image();
    };
    assert.deepEqual(await new WowScreenCapture(platform).capture({}), { ok: false, code: 'window-changed' });
  }
  assert.equal(calls.capture, 3);
  assert.equal(gameForCapturePath('C:\\Games\\_forever_\\Wow.exe'), 'forever');
  assert.equal(gameForCapturePath('C:\\Other\\Wow.exe'), undefined);
});

test('a timeout retains the native lock until verification ends and discards late pixels', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { platform, calls } = fixture();
  let finish: (() => void) | undefined;
  platform.verify = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const runtime = new WowScreenCapture(platform);
  const first = runtime.capture({});
  await Promise.resolve();
  context.mock.timers.tick(30001);
  assert.deepEqual(await first, { ok: false, code: 'capture-timeout' });
  assert.deepEqual(await runtime.capture({}), { ok: false, code: 'busy' });
  finish?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.capture, 0);
});

test('a version-specific capture choice overrides the default active game and labels the verified frame', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wow-screen-'));
  const { platform } = fixture();
  const classic = { ...retail, game: 'classic' as const, path: 'C:\\Games\\_classic_\\WowClassic.exe' };
  platform.discover = async () => [classic];
  platform.verify = async (_window, game) => {
    assert.equal(game, 'classic');
  };
  try {
    const service = new GameScreenAssist(root, { platform });
    await service.saveSettings({ enabled: true, game: 'classic' });
    const result = await service.capture('/look', 'retail');
    assert.ok(result.ok && 'image' in result);
    assert.equal(result.image.game, 'classic');
    assert.match(result.prompt, /Verified screenshot game version: classic/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disabling or disposing during a native capture revokes the result before it reaches chat', async () => {
  for (const action of ['disable', 'dispose']) {
    const root = mkdtempSync(join(tmpdir(), 'wow-screen-'));
    const { platform } = fixture();
    let finish: (() => void) | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    platform.capture = async () => {
      started?.();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return image();
    };
    try {
      const service = new GameScreenAssist(root, { platform });
      await service.saveSettings({ enabled: true, game: 'auto' });
      const pending = service.capture('/look');
      await ready;
      if (action === 'dispose') service.dispose();
      else await service.saveSettings({ enabled: false, game: 'auto' });
      finish?.();
      const result = await pending;
      assert.ok(!result.ok && result.code === (action === 'dispose' ? 'disposed' : 'disabled'));
      assert.equal('image' in result, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
