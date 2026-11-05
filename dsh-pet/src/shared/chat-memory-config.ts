/** Shared, non-secret settings for the optional long-term memory backend. */
export interface ChatMemoryConfig {
  backend: 'native' | 'powercontext';
  /** UTF-8 bytes of recent message bodies; zero retains the existing round-only limit. */
  maxHistoryBytes: number;
  serverUrl: string;
  maxRecallBytes: number;
  recallLimit: number;
  timeoutMs: number;
}

export const DEFAULT_CHAT_MEMORY: Readonly<ChatMemoryConfig> = {
  backend: 'native',
  maxHistoryBytes: 0,
  serverUrl: 'http://127.0.0.1:8000',
  maxRecallBytes: 4096,
  recallLimit: 3,
  timeoutMs: 1500,
};

/** Keep credentials out of configuration responses and disallow cleartext remote transport. */
export function memoryServerUrlValid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

/** The complete object is replaced as one configuration value, like the existing model settings. */
export function chatMemoryConfigValid(value: unknown): value is ChatMemoryConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const integer = (key: string, min: number, max: number) =>
    typeof config[key] === 'number' && Number.isInteger(config[key]) && config[key] >= min && config[key] <= max;
  return (
    Object.keys(config).every((key) => Object.prototype.hasOwnProperty.call(DEFAULT_CHAT_MEMORY, key)) &&
    (config.backend === 'native' || config.backend === 'powercontext') &&
    memoryServerUrlValid(config.serverUrl) &&
    integer('maxHistoryBytes', 0, 131072) &&
    integer('maxRecallBytes', 512, 32768) &&
    integer('recallLimit', 1, 8) &&
    integer('timeoutMs', 250, 10000)
  );
}
