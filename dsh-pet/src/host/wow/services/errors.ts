/** Extract a user-facing failure message without depending on the former UI runtime. */
export function errorMessageFrom(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string')
    return error.message;
  return undefined;
}
