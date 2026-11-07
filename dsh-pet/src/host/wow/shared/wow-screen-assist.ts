import type { InferOutput } from 'valibot';

import { optional, picklist, strictObject } from 'valibot';

export const wowScreenGameSchema = picklist(['retail', 'forever', 'classic']);
export type WowScreenGame = InferOutput<typeof wowScreenGameSchema>;

/** An omitted game selects the only running game window. Desktop sources are never accepted. */
export const wowScreenCaptureSchema = strictObject({ game: optional(wowScreenGameSchema) });
export type WowScreenCaptureRequest = InferOutput<typeof wowScreenCaptureSchema>;

export type WowScreenCaptureErrorCode =
  | 'unsupported-platform'
  | 'invalid-request'
  | 'game-not-found'
  | 'ambiguous-window'
  | 'minimized-window'
  | 'unverified-game'
  | 'capture-failed'
  | 'empty-frame'
  | 'capture-timeout'
  | 'busy'
  | 'window-changed';

/** One request owns one fresh image. The consumer discards it when that chat turn ends. */
export interface WowScreenImage {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
  game: WowScreenGame;
  windowTitle: string;
}

export type WowScreenCaptureResult =
  { ok: true; image: WowScreenImage } | { ok: false; code: WowScreenCaptureErrorCode };
