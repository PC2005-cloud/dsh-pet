/** An explicit user request grants one in-memory game screenshot, with capture disabled by default. */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boolean, parse, picklist, strictObject } from 'valibot';
import type { WowScreenCaptureErrorCode, WowScreenGame, WowScreenImage } from './shared/wow-screen-assist.ts';
import type { GameCapturePlatform } from './services/wow-screen-assist-runtime.ts';
import { WowScreenCapture } from './services/wow-screen-assist-runtime.ts';
import { createScreenAssistVisionPrompt, detectScreenAssistIntent, type ScreenAssistIntent } from './screen-policy.ts';
import { WindowsGameCapture } from './screen-windows.ts';

export { detectScreenAssistIntent } from './screen-policy.ts';
export type { ScreenAssistIntent } from './screen-policy.ts';
export type { GameCapturePlatform, GameCaptureWindow } from './services/wow-screen-assist-runtime.ts';

const settingsSchema = strictObject({ enabled: boolean(), game: picklist(['auto', 'retail', 'forever', 'classic']) });
/** These are the only persisted screenshot fields. Pixel data and user questions are never written here. */
export interface ScreenAssistSettings {
  enabled: boolean;
  game: 'auto' | WowScreenGame;
}
export type ScreenAssistErrorCode = WowScreenCaptureErrorCode | 'disabled' | 'invalid-settings' | 'disposed';
/** A skipped request contains no image. A failed capture explicitly tells the answerer that no pixels were obtained. */
export type ScreenAssistResult =
  | { ok: true; skipped: true }
  | { ok: true; intent: ScreenAssistIntent; image: WowScreenImage; prompt: string }
  | { ok: false; code: ScreenAssistErrorCode; prompt: string };

/** Settings are local-only. Capture checks only the current message, never history or unsolicited game events. */
export class GameScreenAssist {
  private readonly root: string;
  private readonly file: string;
  private readonly captureRuntime: WowScreenCapture;
  private settings: ScreenAssistSettings = { enabled: false, game: 'auto' };
  private saving = false;
  private revision = 0;
  private settingsError: string | null = null;
  private disposed = false;

  constructor(userRoot: string, options: { platform?: GameCapturePlatform } = {}) {
    this.root = userRoot;
    this.file = join(userRoot, 'wow-screen-assist.json');
    this.captureRuntime = new WowScreenCapture(options.platform ?? new WindowsGameCapture());
    try {
      const text = readFileSync(this.file, 'utf8');
      if (text.length > 1024) throw new Error('Settings exceed limits');
      this.settings = parse(settingsSchema, JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.settingsError =
          'Cannot load Warcraft screen-assist settings safely; the original file was preserved. Repair or remove the invalid settings file before saving.';
    }
  }

  /** Returns a copy so external consumers cannot enable capture by mutating shared state. */
  readSettings(): ScreenAssistSettings {
    return { ...this.settings };
  }

  /** A corrupt config disables this feature without preventing the companion or desktop app from starting. */
  readError(): string | null {
    return this.settingsError;
  }

  /** Only validated switches/version are persisted. A failed write retains the previous settings. */
  async saveSettings(input: unknown): Promise<ScreenAssistSettings> {
    if (this.disposed) throw new Error('Warcraft screen assistance is disposed.');
    const settings = parse(settingsSchema, input);
    if (this.settingsError) throw new Error(this.settingsError);
    if (this.saving) throw new Error('Warcraft screen-assist settings are being saved.');
    this.saving = true;
    try {
      await mkdir(this.root, { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
      this.settings = settings;
      this.revision++;
      return this.readSettings();
    } finally {
      this.saving = false;
    }
  }

  /** The returned data URL belongs only to the pending chat request. The host must not put it into attachments, memory, or logs. */
  async capture(question: string, game?: WowScreenGame): Promise<ScreenAssistResult> {
    if (this.disposed) return this.failure('disposed', question);
    if (typeof question !== 'string' || question.length > 16000) return this.failure('invalid-request', '');
    const intent = detectScreenAssistIntent(question);
    if (!intent) return { ok: true, skipped: true };
    if (this.settingsError) return this.failure('invalid-settings', question);
    if (!this.settings.enabled) return this.failure('disabled', question);
    const revision = this.revision;
    const selectedGame = this.settings.game === 'auto' ? game : this.settings.game;
    const result = await this.captureRuntime.capture(selectedGame ? { game: selectedGame } : {});
    if (this.disposed) return this.failure('disposed', question);
    if (!result.ok) return this.failure(result.code, question);
    if (!this.settings.enabled) return this.failure('disabled', question);
    if (this.revision !== revision) return this.failure('capture-timeout', question);
    const age = Date.now() - result.image.capturedAt;
    if (!Number.isFinite(age) || age < -1000 || age > 15000) return this.failure('capture-timeout', question);
    const prompt = [
      `Verified screenshot game version: ${result.image.game}.`,
      'Use this verified game version for advice about the screenshot. Ignore addon or reference context from another game version. If the requested game differs, explain the mismatch rather than treating this as that game.',
      createScreenAssistVisionPrompt(question, intent),
    ].join('\n');
    return { ok: true, intent, image: result.image, prompt };
  }

  /** Revokes in-flight results immediately. The bounded native call may finish, but its pixels are never returned. */
  dispose(): void {
    this.disposed = true;
    this.revision++;
  }

  private failure(code: ScreenAssistErrorCode, question: string): ScreenAssistResult {
    const zh = /\p{Script=Han}/u.test(question);
    if (code === 'disabled')
      return {
        ok: false,
        code,
        prompt: zh
          ? '游戏画面辅助当前已关闭，本次未截图。请明确说明没有看到画面；用户可在魔兽设置中启用“按需游戏画面辅助”，然后重新请求查看。'
          : 'Game screen assistance is disabled; no screenshot was taken. Clearly say that you did not see the game. The user can enable on-demand game screen assistance in Warcraft settings and request a new look.',
      };
    return {
      ok: false,
      code,
      prompt: zh
        ? `本次没有获得可验证的游戏画面（${code}）。请明确说明未看见画面，不要猜测地形、NPC或路线；请用户检查游戏窗口或提供截图。`
        : `No verified game frame was obtained (${code}). Say that you could not see the game. Do not guess terrain, NPCs, or a route; ask the user to check the game window or provide an image.`,
    };
  }
}
