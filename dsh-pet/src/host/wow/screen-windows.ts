/** Windows capture works from either the DSH plugin process or standalone Node, without Electron or screenshot files. */
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { array, boolean, integer, minValue, number, object, parse, pipe, string } from 'valibot';
import type { WowScreenGame } from './shared/wow-screen-assist.ts';
import type { GameCapturePlatform, GameCaptureWindow } from './services/wow-screen-assist-runtime.ts';
import { ScreenCaptureFailure } from './services/wow-screen-assist-runtime.ts';
import { WindowsLauncherPlatform } from './services/wow-launcher-windows.ts';
import { captureScript, discoveryScript } from './screen-native.ts';

const execute = promisify(execFile);
const windowsSchema = array(
  object({
    handle: string(),
    processId: pipe(number(), integer(), minValue(1)),
    processStartedAt: string(),
    path: string(),
    title: string(),
    minimized: boolean(),
    visible: boolean(),
  }),
);

/** The fixed installation directory selects a product; signature and executable metadata are checked separately. */
export function gameForCapturePath(path: string): WowScreenGame | undefined {
  switch (win32.basename(win32.dirname(path)).toLowerCase()) {
    case '_retail_':
      return 'retail';
    case '_forever_':
      return 'forever';
    case '_classic_':
    case '_classic_era_':
    case '_classic_titan_':
    case '_anniversary_':
      return 'classic';
  }
}

async function runNative(script: string, values: Record<string, string> = {}) {
  const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1];
  if (!systemRoot) throw new ScreenCaptureFailure('capture-failed');
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.toLowerCase() !== 'psmodulepath' && !name.toUpperCase().startsWith('DSH_WOW_'),
    ),
  );
  const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...environment, PSMODULEPATH: win32.join(win32.dirname(powershell), 'Modules'), ...values },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 9 * 1024 * 1024,
  });
  return JSON.parse(result.stdout.trim()) as unknown;
}

/** Native discovery and PrintWindow share one HWND/process lifetime, never a title substring or desktop rectangle. */
export class WindowsGameCapture implements GameCapturePlatform {
  readonly supported = process.platform === 'win32';
  private readonly inspector = new WindowsLauncherPlatform();

  async discover(): Promise<GameCaptureWindow[]> {
    if (!this.supported) throw new ScreenCaptureFailure('unsupported-platform');
    return parse(windowsSchema, await runNative(discoveryScript)).map((window) => ({
      ...window,
      game: gameForCapturePath(window.path),
    }));
  }

  async verify(window: GameCaptureWindow, game: WowScreenGame): Promise<void> {
    try {
      await this.inspector.inspect(game, window.path);
    } catch {
      throw new ScreenCaptureFailure('unverified-game');
    }
  }

  async capture(window: GameCaptureWindow) {
    if (!this.supported) throw new ScreenCaptureFailure('unsupported-platform');
    const result = await runNative(captureScript, {
      DSH_WOW_HANDLE: window.handle,
      DSH_WOW_PID: String(window.processId),
      DSH_WOW_START: window.processStartedAt,
      DSH_WOW_PATH: window.path,
    });
    if (typeof result !== 'object' || result === null) throw new ScreenCaptureFailure('capture-failed');
    const frame = result as Record<string, unknown>;
    if (frame.ok !== true) {
      const code = frame.code;
      throw new ScreenCaptureFailure(
        code === 'empty-frame' || code === 'window-changed' || code === 'minimized-window' ? code : 'capture-failed',
      );
    }
    if (
      typeof frame.dataUrl !== 'string' ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.dataUrl) ||
      frame.dataUrl.length > 9 * 1024 * 1024 ||
      typeof frame.width !== 'number' ||
      !Number.isInteger(frame.width) ||
      frame.width < 160 ||
      frame.width > 1920 ||
      typeof frame.height !== 'number' ||
      !Number.isInteger(frame.height) ||
      frame.height < 90 ||
      frame.height > 1080 ||
      typeof frame.capturedAt !== 'number' ||
      !Number.isFinite(frame.capturedAt)
    )
      throw new ScreenCaptureFailure('capture-failed');
    return { dataUrl: frame.dataUrl, width: frame.width, height: frame.height, capturedAt: frame.capturedAt };
  }
}
