import { ValiError } from 'valibot';
import type { RouteHandler } from './types.ts';
import { invalidJson, methodNotAllowed, okResult, payloadTooLarge } from './result.ts';

/** Uses the normal host authentication and request-size limits; no new listener or arbitrary URL proxy. */
export const handleWowRoutes: RouteHandler = async (deps, input) => {
  if (input.rest !== 'wow' && !input.rest.startsWith('wow/')) return undefined;
  if (input.rest !== 'wow/state' && input.rest !== 'wow/action' && input.rest !== 'wow/appearance')
    return { kind: 'json', status: 404, obj: { ok: false, code: 'wow-not-found' } };
  if (input.method !== (input.rest === 'wow/action' ? 'POST' : 'GET')) return methodNotAllowed();
  if (!deps.wow) return { kind: 'json', status: 503, obj: { ok: false, code: 'wow-unavailable' } };
  try {
    if (input.rest === 'wow/state') return okResult(await deps.wow.read());
    if (input.rest === 'wow/appearance') return okResult(deps.wow.appearance());
    if (Buffer.byteLength(input.body ?? '', 'utf8') > 1024 * 1024) return payloadTooLarge();
    let raw: unknown;
    try {
      raw = JSON.parse(input.body ?? '');
    } catch {
      return invalidJson();
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalidJson();
    const request = raw as Record<string, unknown>;
    if (typeof request.action !== 'string' || request.action.length > 80)
      return { kind: 'json', status: 400, obj: { ok: false, code: 'wow-invalid-action' } };
    return okResult(await deps.wow.action(request.action, request.game, request.data));
  } catch (error) {
    // Filesystem paths, provider responses and credentials never become exception text in HTTP responses.
    const known = error instanceof Error && /^wow-[a-z-]+$/.test(error.message) ? error.message : undefined;
    const invalid = error instanceof ValiError;
    if (!invalid) deps.log.warn('[wow] 请求失败：' + (known ?? 'wow-request-failed'));
    return {
      kind: 'json',
      status: invalid ? 400 : 200,
      obj: { ok: false, code: invalid ? 'wow-invalid-request' : (known ?? 'wow-request-failed') },
    };
  }
};
