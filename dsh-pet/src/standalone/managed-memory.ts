/** Local PowerContext lifecycle. The persisted port keeps per-pet bindings stable across restarts. */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { registerMemoryToken } from '../host/powercontext-auth.ts';
import { memoryServerUrlValid } from '../shared/chat-memory-config.ts';
import { readPrivateJson, writePrivateJson } from './ai-storage.ts';
import { installMemoryRuntime, memoryProcessEnv } from './memory-install.ts';

const printable = (s: string): boolean => [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const text = z.string().trim().min(1).max(200).refine(printable);
const endpoint = z.string().max(2048).refine(memoryServerUrlValid);
const key = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => printable(s) && !/\s/.test(s));
export const memoryModelsSchema = z
  .object({
    baseUrl: endpoint,
    model: text,
    apiKey: key,
    embeddingBaseUrl: endpoint,
    embeddingModel: text,
    embeddingApiKey: key,
    embeddingDimension: z.number().int().min(1).max(65536),
  })
  .strict();
export type MemoryModels = z.infer<typeof memoryModelsSchema>;
const configSchema = memoryModelsSchema
  .extend({ version: z.literal(1), port: z.number().int().min(1024).max(65535), token: key, enabled: z.boolean() })
  .strict();
type MemoryConfig = z.infer<typeof configSchema>;

// EOF means the desktop process exited, including crashes. Only this guardian's own child tree is stopped.
const GUARDIAN = `import os, signal, subprocess, sys, threading
p = subprocess.Popen([sys.executable, '-c', 'from powercontext.cli.app import main; main()', 'server', 'run', '--no-env-file'], stdin=subprocess.DEVNULL, start_new_session=os.name != 'nt')
def watch():
    sys.stdin.buffer.read()
    if p.poll() is not None: return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        try: os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError: return
        try: p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try: os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError: pass
threading.Thread(target=watch, daemon=True).start()
sys.exit(p.wait())
`;

/** Server inputs are isolated from ambient configuration and never passed as command arguments. */
export function managedMemoryEnvironment(directory: string, config: MemoryConfig): NodeJS.ProcessEnv {
  return {
    ...memoryProcessEnv(directory),
    POWERCONTEXT_HOME: join(directory, 'data'),
    POWERCONTEXT_SERVER_DATABASE_KIND: 'sqlite',
    POWERCONTEXT_SERVER_HTTP_HOST: '127.0.0.1',
    POWERCONTEXT_SERVER_HTTP_PORT: String(config.port),
    POWERCONTEXT_SERVER_AUTH_ENABLED: 'true',
    POWERCONTEXT_SERVER_AUTH_TOKEN: config.token,
    POWERCONTEXT_SERVER_INFERENCE_GENERATION_MODEL: 'openai-chat:' + config.model,
    POWERCONTEXT_SERVER_INFERENCE_GENERATION_BASE_URL: config.baseUrl,
    POWERCONTEXT_SERVER_INFERENCE_GENERATION_HEADERS: JSON.stringify({ Authorization: 'Bearer ' + config.apiKey }),
    POWERCONTEXT_SERVER_INFERENCE_EMBEDDING_MODEL: 'openai:' + config.embeddingModel,
    POWERCONTEXT_SERVER_INFERENCE_EMBEDDING_BASE_URL: config.embeddingBaseUrl,
    POWERCONTEXT_SERVER_INFERENCE_EMBEDDING_HEADERS: JSON.stringify({
      Authorization: 'Bearer ' + config.embeddingApiKey,
    }),
    POWERCONTEXT_SERVER_INFERENCE_EMBEDDING_DIMENSION: String(config.embeddingDimension),
    POWERCONTEXT_SERVER_INFERENCE_EMBEDDING_PROFILE_ID: 'dsh-pet-' + config.embeddingDimension,
    POWERCONTEXT_SERVER_RUNTIME_ARTIFACT_PROCESSING_FAMILIES: '["memory"]',
    POWERCONTEXT_SERVER_RUNTIME_MEMORY_SCHEDULE_SECONDS: '30',
    POWERCONTEXT_SERVER_RUNTIME_MEMORY_EXTRACTION_PROFILE: 'conversation',
    POWERCONTEXT_SERVER_INFERENCE_ATOMIC_MEMORY_INPUT_ENCODING: 'active',
    POWERCONTEXT_SERVER_RUNTIME_DREAM_ENABLED: 'false',
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('port_unavailable'))));
    });
  });
}

export class ManagedMemory {
  readonly directory: string;
  private config?: MemoryConfig;
  private child?: ChildProcess;
  private releaseToken?: () => void;
  private lockOwned = false;
  private readonly file: string;

  constructor(home: string) {
    this.directory = join(home, 'dsh-pet', 'powercontext');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('unsafe_memory_directory');
    this.file = join(this.directory, 'settings.json');
    const saved = readPrivateJson(this.file);
    if (saved !== undefined) this.config = configSchema.parse(saved);
  }

  get enabled(): boolean {
    return this.config?.enabled === true;
  }
  get url(): string | undefined {
    return this.config && `http://127.0.0.1:${this.config.port}`;
  }
  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null;
  }
  settings(): Omit<MemoryModels, 'apiKey' | 'embeddingApiKey'> | undefined {
    if (!this.config) return undefined;
    const { baseUrl, model, embeddingBaseUrl, embeddingModel, embeddingDimension } = this.config;
    return { baseUrl, model, embeddingBaseUrl, embeddingModel, embeddingDimension };
  }

  /** Claim the private runtime before touching configuration or processes; never terminate another owner. */
  private claim(): void {
    if (this.lockOwned) return;
    const file = join(this.directory, 'owner');
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw new Error('memory_already_owned');
      try {
        process.kill(pid, 0);
        throw new Error('memory_already_owned');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          throw new Error('memory_already_owned', { cause: error });
      }
      unlinkSync(file);
    }
    const fd = openSync(file, 'wx', 0o600);
    try {
      writeFileSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    this.lockOwned = true;
  }

  validateModels(models: MemoryModels): MemoryModels {
    const next = memoryModelsSchema.parse(models);
    // Reusing old vectors with a different embedding space would corrupt retrieval semantics.
    if (
      this.config &&
      ['embeddingBaseUrl', 'embeddingModel', 'embeddingDimension'].some(
        (name) => this.config![name as keyof MemoryModels] !== next[name as keyof MemoryModels],
      )
    )
      throw new Error('embedding_change_requires_new_store');
    return next;
  }

  async configure(models: MemoryModels): Promise<void> {
    const next = this.validateModels(models);
    this.claim();
    await this.stopProcess();
    this.config = {
      ...next,
      version: 1,
      port: this.config?.port ?? (await freePort()),
      token: this.config?.token ?? randomBytes(32).toString('base64url'),
      enabled: false,
    };
    writePrivateJson(this.file, this.config);
  }

  setEnabled(enabled: boolean): void {
    if (!this.config) return;
    this.claim();
    writePrivateJson(this.file, { ...this.config, enabled });
    this.config.enabled = enabled;
  }

  async start(signal: AbortSignal, progress: (stage: 'installing' | 'starting') => void): Promise<string> {
    this.claim();
    if (!this.config) throw new Error('memory_not_configured');
    if (this.running) return this.url!;
    progress('installing');
    const python = await installMemoryRuntime(this.directory, signal);
    signal.throwIfAborted();
    progress('starting');
    // A persisted endpoint must never silently attach to a different service or acquire a new identity.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', () => reject(new Error('memory_port_in_use')));
      probe.listen(this.config!.port, '127.0.0.1', () => probe.close(() => resolve()));
    });
    signal.throwIfAborted();
    const child = spawn(python, ['-c', GUARDIAN], {
      cwd: this.directory,
      env: managedMemoryEnvironment(this.directory, this.config),
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    this.child = child;
    let failed = false;
    child.on('error', () => {
      failed = true;
    });
    child.stdin!.on('error', () => {
      failed = true;
    });
    this.releaseToken = registerMemoryToken(this.url!, this.config.token);
    const deadline = Date.now() + 120_000;
    try {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (failed || !this.running) throw new Error('memory_start_failed');
        try {
          const response = await fetch(this.url! + '/health/ready', {
            headers: { Authorization: 'Bearer ' + this.config.token },
            signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
            redirect: 'error',
          });
          const result = (await response.json()) as { status?: string };
          if (response.ok && result.status === 'ready' && this.running) return this.url!;
        } catch {
          signal.throwIfAborted();
        }
        await delay(500, undefined, { signal });
      }
      throw new Error('memory_not_ready');
    } catch (error) {
      await this.stopProcess();
      throw error;
    }
  }

  async stopProcess(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.releaseToken?.();
    this.releaseToken = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('close', resolve);
        // Closing the ownership pipe also works when the JS parent is killed unexpectedly.
        child.stdin?.end();
      });
    }
  }

  async dispose(): Promise<void> {
    await this.stopProcess();
    if (this.lockOwned) {
      unlinkSync(join(this.directory, 'owner'));
      this.lockOwned = false;
    }
  }
}
