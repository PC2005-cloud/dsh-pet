import type { InferOutput } from 'valibot';

import { boolean, check, maxLength, minLength, object, optional, pipe, string, transform } from 'valibot';

import { gameVersionSchema } from './wow-companion';

/** Only a macro body and game cross IPC. The main process chooses all paths, windows, and input operations. */
export const macroImportSchema = object({
  game: gameVersionSchema,
  body: pipe(
    string(),
    maxLength(2048),
    transform((value) => value.replace(/\r\n?/g, '\n').replace(/^[ \t\n\v\f]+|[ \t\n\v\f]+$/g, '')),
    minLength(1),
    check((value) => new TextEncoder().encode(value).length <= 255, 'Macro exceeds 255 UTF-8 bytes'),
    check(
      (value) =>
        [...value].every((character) => {
          const code = character.codePointAt(0)!;
          return (code >= 32 || code === 9 || code === 10) && code !== 127 && (code < 0xd800 || code > 0xdfff);
        }),
      'Invalid macro text',
    ),
    check(
      (value) => value.split('\n').every((line) => !line.trim() || /^[\t ]*[/#]/.test(line)),
      'Expected macro commands',
    ),
  ),
});

export type MacroImportRequest = InferOutput<typeof macroImportSchema>;

/** Success requires the addon's saved receipt. Sending input alone never confirms an import. */
export const macroImportResultSchema = object({
  ok: boolean(),
  code: pipe(string(), minLength(1), maxLength(100)),
  macroName: optional(string()),
  requestId: optional(string()),
});
export type MacroImportResult = InferOutput<typeof macroImportResultSchema>;
