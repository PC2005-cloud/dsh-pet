import type { InferOutput } from 'valibot';

import { boolean, maxLength, optional, picklist, pipe, strictObject, string } from 'valibot';

export const launcherTargetSchema = picklist(['battle-net', 'retail', 'forever', 'classic']);
export type LauncherTarget = InferOutput<typeof launcherTargetSchema>;

const executablePathSchema = pipe(string(), maxLength(4096));

export const launcherConfigSchema = strictObject({
  defaultTarget: launcherTargetSchema,
  paths: strictObject({
    'battle-net': executablePathSchema,
    retail: executablePathSchema,
    forever: executablePathSchema,
    classic: executablePathSchema,
  }),
});
export type LauncherConfig = InferOutput<typeof launcherConfigSchema>;

export const launcherSaveSchema = strictObject({
  target: launcherTargetSchema,
  path: executablePathSchema,
  makeDefault: boolean(),
});
export const launcherLaunchSchema = strictObject({ target: optional(launcherTargetSchema) });
export type LauncherSaveRequest = InferOutput<typeof launcherSaveSchema>;

export type LauncherErrorCode =
  | 'unsupported-platform'
  | 'invalid-request'
  | 'invalid-path'
  | 'file-not-found'
  | 'not-executable'
  | 'invalid-signature'
  | 'wrong-product'
  | 'wrong-version'
  | 'unrecognized-version'
  | 'inspection-failed'
  | 'not-configured'
  | 'storage-error'
  | 'launch-failed'
  | 'busy';

export interface LauncherState extends LauncherConfig {
  supported: boolean;
  error?: LauncherErrorCode;
}

/** Metadata describes the file that passed validation, not proof that a game has logged in. */
export interface LauncherExecutable {
  target: LauncherTarget;
  path: string;
  productName: string;
  fileVersion: string;
}

export type LauncherResult =
  { ok: true; state: LauncherState; executable?: LauncherExecutable } | { ok: false; code: LauncherErrorCode };
