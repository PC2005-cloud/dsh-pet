import type {
  WowScreenCaptureErrorCode,
  WowScreenCaptureResult,
  WowScreenGame,
  WowScreenImage,
} from '../shared/wow-screen-assist.ts';

import { safeParse } from 'valibot';

import { wowScreenCaptureSchema } from '../shared/wow-screen-assist.ts';

/** Native discovery identifies a process lifetime and its window, independently of the window title. */
export interface GameCaptureWindow {
  handle: string;
  processId: number;
  processStartedAt: string;
  path: string;
  title: string;
  minimized: boolean;
  visible: boolean;
  game?: WowScreenGame;
}

/** The OS boundary owns discovery, executable verification, and window pixels. */
export interface GameCapturePlatform {
  supported: boolean;
  discover: () => Promise<GameCaptureWindow[]>;
  verify: (window: GameCaptureWindow, game: WowScreenGame) => Promise<void>;
  capture: (window: GameCaptureWindow) => Promise<Pick<WowScreenImage, 'dataUrl' | 'width' | 'height' | 'capturedAt'>>;
}

export class ScreenCaptureFailure extends Error {
  readonly code: WowScreenCaptureErrorCode;

  constructor(code: WowScreenCaptureErrorCode) {
    super(code);
    this.code = code;
  }
}

/**
 * Each invocation captures one window. There is no image cache, timer loop, or screenshot file.
 * A timeout releases the caller. The OS operation retains the lock until completion, and its late result is discarded.
 */
export class WowScreenCapture {
  private pending: Promise<WowScreenCaptureResult> | undefined;

  private readonly platform: GameCapturePlatform;

  constructor(platform: GameCapturePlatform) {
    this.platform = platform;
  }

  async capture(input: unknown): Promise<WowScreenCaptureResult> {
    if (!this.platform.supported) return { ok: false, code: 'unsupported-platform' };
    const request = safeParse(wowScreenCaptureSchema, input);
    if (!request.success) return { ok: false, code: 'invalid-request' };
    if (this.pending) return { ok: false, code: 'busy' };

    let expired = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operation = (async (): Promise<WowScreenCaptureResult> => {
      try {
        const windows = await this.platform.discover();
        const candidates = request.output.game
          ? windows.filter((window) => window.game === request.output.game)
          : windows;
        if (candidates.length === 0) throw new ScreenCaptureFailure('game-not-found');
        if (candidates.length > 1) throw new ScreenCaptureFailure('ambiguous-window');
        const window = candidates[0]!;
        if (window.minimized || !window.visible) throw new ScreenCaptureFailure('minimized-window');
        if (!window.game) throw new ScreenCaptureFailure('unverified-game');
        await this.platform.verify(window, window.game);
        if (expired) throw new ScreenCaptureFailure('capture-timeout');
        // Signature verification can take time. Recheck visibility and process identity before reading any pixels.
        await this.checkWindow(window);
        if (expired) throw new ScreenCaptureFailure('capture-timeout');
        const frame = await this.platform.capture(window);
        await this.checkWindow(window);
        if (expired) throw new ScreenCaptureFailure('capture-timeout');
        return { ok: true, image: { ...frame, game: window.game, windowTitle: window.title } };
      } catch (error) {
        return { ok: false, code: error instanceof ScreenCaptureFailure ? error.code : 'capture-failed' };
      }
    })();
    this.pending = operation;
    void operation.finally(() => {
      if (this.pending === operation) this.pending = undefined;
    });
    try {
      return await Promise.race([
        operation,
        new Promise<WowScreenCaptureResult>((resolve) => {
          timeout = setTimeout(() => {
            expired = true;
            resolve({ ok: false, code: 'capture-timeout' });
          }, 30000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async checkWindow(original: GameCaptureWindow) {
    const windows = await this.platform.discover();
    const current = windows.find((window) => window.handle === original.handle);
    if (
      !current ||
      current.processId !== original.processId ||
      current.processStartedAt !== original.processStartedAt ||
      current.path.toLowerCase() !== original.path.toLowerCase()
    ) {
      throw new ScreenCaptureFailure('window-changed');
    }
    if (current.minimized || !current.visible) throw new ScreenCaptureFailure('minimized-window');
  }
}
