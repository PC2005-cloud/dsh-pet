/** Private credentials for a managed local service, scoped to its exact endpoint. */
const managedTokens = new Map<string, string>();

export function registerMemoryToken(url: string, token: string): () => void {
  const key = url.replace(/\/+$/, '');
  managedTokens.set(key, token);
  return () => {
    if (managedTokens.get(key) === token) managedTokens.delete(key);
  };
}

export function memoryToken(url: string): string | undefined {
  return managedTokens.get(url.replace(/\/+$/, '')) ?? process.env.DSH_PET_POWERCONTEXT_TOKEN;
}
