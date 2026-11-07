import type { InferOutput } from 'valibot';

import { number, object, picklist, record, safeParse, string, union } from 'valibot';

const prefix = 'wow-companion-error:';
const errorSchema = object({
  code: picklist([
    'bridge-local-address',
    'bridge-stopped',
    'bridge-cancelled',
    'bridge-retry',
    'bridge-windows',
    'bridge-exited',
    'bridge-start-failed',
    'bridge-start-exited',
    'bridge-timeout',
    'bridge-port-unavailable',
    'bridge-port-incompatible',
    'bridge-profile-incompatible',
    'bridge-files-missing',
    'bridge-python-missing',
    'bridge-unavailable',
    'bridge-http',
    'bridge-response-profile',
    'connection-disabled',
    'connection-changed',
    'gold-account-unknown',
    'gold-read',
    'gold-write',
    'levels-read',
    'levels-write',
    'equipment-read',
    'equipment-write',
    'comparisons-read',
    'comparisons-write',
    'loadouts-read',
    'loadouts-write',
  ]),
  parameters: record(string(), union([string(), number()])),
});

type CompanionErrorCode = InferOutput<typeof errorSchema>['code'];

/** Carries a message key and values through string-based IPC errors without selecting the renderer language. */
export function companionError(code: CompanionErrorCode, parameters: Record<string, string | number> = {}): string {
  return prefix + JSON.stringify({ code, parameters });
}

/** Localizes application errors at display time. Operating-system and external bridge diagnostics remain intact. */
export function formatCompanionError(
  message: string | null | undefined,
  translate: (key: string, parameters: Record<string, string | number>) => string,
): string {
  function render(value: string, depth: number): string {
    if (!value.startsWith(prefix) || depth >= 4) return value;

    try {
      const result = safeParse(errorSchema, JSON.parse(value.slice(prefix.length)));
      if (!result.success) return value;

      const parameters = { ...result.output.parameters };
      if (typeof parameters.detail === 'string') parameters.detail = render(parameters.detail, depth + 1);

      return translate(`companion-errors.${result.output.code}`, parameters);
    } catch {
      return value;
    }
  }

  return message ? render(message, 0) : '';
}
