import type { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { GameVersion } from '../shared/wow-companion';
import type { MacroImportRequest } from '../shared/wow-macro-import';
import type { GameCaptureWindow } from './wow-screen-assist-runtime';

import process from 'node:process';

import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { errorMessageFrom } from './errors';
import {
  integer,
  literal,
  looseObject,
  minLength,
  minValue,
  number,
  optional,
  parse,
  picklist,
  pipe,
  safeParse,
  string,
} from 'valibot';

import { gameProfiles, gameVersionSchema } from '../shared/wow-companion';
import { companionError } from '../shared/wow-companion-errors';
import { macroImportResultSchema } from '../shared/wow-macro-import';

const execFileAsync = promisify(execFile);
const healthSchema = looseObject({
  ok: literal(true),
  service: literal('wow-companion-bridge'),
  protocol: picklist(['WCP1', 'WCF1']),
  game: optional(gameVersionSchema),
  version: string(),
  instanceId: pipe(string(), minLength(1)),
});
const pythonSchema = looseObject({
  executable: pipe(string(), minLength(1)),
  major: literal(3),
  minor: pipe(number(), integer(), minValue(10)),
});

/** The trusted host supplies these paths. No renderer input can select an executable or service address. */
export interface RuntimeOptions {
  appPath: string;
  resourcesPath: string;
  userDataPath: string;
  platform: NodeJS.Platform;
  /** @default 'retail' */
  game?: GameVersion;
}

interface OwnedProcess {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  done: boolean;
  stderr: string;
}

/**
 * Reuses a compatible external bridge or owns one hidden Python child.
 * An abort generation isolates starts from stop/dispose. Only the owned child is stopped.
 * Errors delay new attempts for 30 seconds. Closing stdin also stops the child after an AIRI crash.
 */
export class CompanionBridgeRuntime {
  private status: 'stopped' | 'starting' | 'running' | 'external' | 'error' = 'stopped';
  private error: string | null = null;
  private retryAt = 0;
  private disposed = false;
  private generation = 0;
  private active: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private owned: OwnedProcess | undefined;
  private macroAbort: AbortController | undefined;

  /** The loopback address is fixed in AIRI. Tests use an isolated local HTTP server. */
  private readonly options: RuntimeOptions;
  private readonly baseUrl: string;

  constructor(options: RuntimeOptions, baseUrl = `http://127.0.0.1:${gameProfiles[options.game ?? 'retail'].port}`) {
    this.options = options;
    this.baseUrl = baseUrl;
    const address = new URL(baseUrl);
    if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password)
      throw new Error(companionError('bridge-local-address'));
  }

  /** Returns lifecycle diagnostics, not a live game observation. */
  read() {
    return { status: this.status, error: this.error };
  }

  /** Starts at most one helper and waits until its health endpoint is ready. */
  async ensureReady() {
    const generation = this.generation;
    await this.stopping;
    if (this.disposed) throw new Error(companionError('bridge-stopped'));
    if (generation !== this.generation) throw new Error(companionError('bridge-cancelled'));
    if (this.active) return this.active;
    if (Date.now() < this.retryAt) throw new Error(this.error ?? companionError('bridge-retry', { detail: '' }));
    const controller = new AbortController();
    this.abort = controller;
    const operation = this.connect(controller.signal);
    this.active = operation;
    try {
      await operation;
    } finally {
      if (this.active === operation) this.active = undefined;
      if (this.abort === controller) this.abort = undefined;
    }
  }

  /** Cancels a pending start and releases the owned helper. Later calls can start again. */
  stop() {
    this.generation++;
    this.abort?.abort();
    this.macroAbort?.abort();
    if (this.stopping) return this.stopping;
    const active = this.active;
    const operation = (async () => {
      await active?.catch(() => {});
      await this.releaseOwned();
      this.status = 'stopped';
      this.error = null;
      this.retryAt = 0;
    })();
    this.stopping = operation;
    void operation
      .finally(() => {
        if (this.stopping === operation) this.stopping = undefined;
      })
      .catch(() => {});
    return operation;
  }

  /** Permanently rejects starts and waits for owned process cleanup. */
  dispose() {
    this.disposed = true;
    return this.stop();
  }

  private async connect(signal: AbortSignal) {
    try {
      if (await this.healthy(signal)) {
        signal.throwIfAborted();
        this.status = this.owned ? 'running' : 'external';
        this.error = null;
        return;
      }
      if (this.owned) await this.releaseOwned();
      signal.throwIfAborted();
      this.status = 'starting';
      this.error = null;
      if (this.options.platform !== 'win32') throw new Error(companionError('bridge-windows'));
      const resources = await this.findResources();
      signal.throwIfAborted();
      const python = await this.findPython(signal);
      signal.throwIfAborted();
      const child = spawn(
        python,
        [
          resources.script,
          '--game',
          this.options.game ?? 'retail',
          '--port',
          new URL(this.baseUrl).port || '80',
          '--config',
          resources.config,
          '--managed-stdin',
        ],
        {
          cwd: dirname(resources.script),
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
        },
      );
      const owned: OwnedProcess = { child, done: false, stderr: '', exited: Promise.resolve() };
      owned.exited = new Promise<void>((resolveExit) => {
        const finish = () => {
          owned.done = true;
          if (this.owned === owned && this.status === 'running') {
            this.owned = undefined;
            this.fail(companionError('bridge-retry', { detail: companionError('bridge-exited') }));
          }
          resolveExit();
        };
        child.once('error', (error) => {
          owned.stderr = errorMessageFrom(error) ?? '';
          finish();
        });
        child.once('exit', finish);
      });
      // Drain output so a full pipe cannot freeze capture. Retain only bounded startup diagnostics.
      child.stdout.resume();
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        owned.stderr = (owned.stderr + chunk).slice(-4096);
      });
      child.stdin.on('error', () => {});
      this.owned = owned;
      const deadline = Date.now() + 10_000;
      do {
        await delay(200, undefined, { signal });
        signal.throwIfAborted();
        if (owned.done) throw new Error(companionError('bridge-start-failed', { detail: owned.stderr.trim() }));
        if (await this.healthy(signal)) {
          signal.throwIfAborted();
          if (owned.done) throw new Error(companionError('bridge-start-exited'));
          this.status = 'running';
          this.error = null;
          return;
        }
      } while (Date.now() < deadline);
      throw new Error(companionError('bridge-timeout'));
    } catch (error) {
      await this.releaseOwned();
      if (!signal.aborted)
        this.fail(
          companionError('bridge-retry', { detail: errorMessageFrom(error) ?? companionError('bridge-unavailable') }),
        );
      throw signal.aborted
        ? new Error(companionError('bridge-cancelled'))
        : new Error(this.error ?? companionError('bridge-unavailable'));
    }
  }

  /**
   * Runs one fixed import workflow. Closing stdin cancels native input after a shutdown or settings change.
   *
   * Call stack:
   * wowMacroImport (IPC) -> CompanionProfile.importMacro -> runMacroImport -> macro_import.py
   */
  async runMacroImport(request: MacroImportRequest, window: GameCaptureWindow) {
    if (this.disposed || this.options.platform !== 'win32' || this.macroAbort)
      throw new Error('macro-import-unavailable');
    const controller = new AbortController();
    this.macroAbort = controller;
    const generation = this.generation;
    try {
      const resources = await this.findResources();
      const python = await this.findPython(controller.signal);
      controller.signal.throwIfAborted();
      if (generation !== this.generation) throw new Error('macro-import-cancelled');
      const script = join(dirname(resources.script), 'macro_import.py');
      if (!(await this.isFile(script))) throw new Error('macro-import-files-missing');
      const result = await new Promise<string>((resolveResult, reject) => {
        const child = spawn(python, [script], {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
        });
        let output = '';
        const cancel = () => child.stdin.end();
        const timeout = setTimeout(() => {
          cancel();
          child.kill();
          reject(new Error('macro-import-timeout'));
        }, 180_000);
        controller.signal.addEventListener('abort', cancel, { once: true });
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (output.length > 8192) {
            cancel();
            child.kill();
          }
        });
        child.stderr.resume();
        child.stdin.on('error', () => {
          /* Exit reports a failed or cancelled child. */
        });
        child.once('error', reject);
        child.once('close', (code) => {
          clearTimeout(timeout);
          controller.signal.removeEventListener('abort', cancel);
          if (code === 0 && !controller.signal.aborted && output.length <= 8192) resolveResult(output);
          else reject(new Error('macro-import-cancelled-or-failed'));
        });
        // The stream remains open as a lifetime lease. Macro text is data, never a process argument or shell script.
        child.stdin.write(`${JSON.stringify({ ...request, window })}\n`);
        if (controller.signal.aborted) cancel();
      });
      return parse(macroImportResultSchema, JSON.parse(result));
    } finally {
      if (this.macroAbort === controller) this.macroAbort = undefined;
    }
  }

  private fail(message: string) {
    this.status = 'error';
    this.error = message;
    this.retryAt = Date.now() + 30_000;
  }

  private async healthy(signal: AbortSignal) {
    const port = new URL(this.baseUrl).port;
    const game = this.options.game ?? 'retail';
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/health`, {
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
      });
    } catch (error) {
      signal.throwIfAborted();
      // Only connection refusal means that AIRI can try to start a listener.
      if (
        error instanceof Error &&
        'cause' in error &&
        typeof error.cause === 'object' &&
        error.cause !== null &&
        'code' in error.cause &&
        error.cause.code === 'ECONNREFUSED'
      ) {
        return false;
      }
      throw new Error(companionError('bridge-port-unavailable', { port }), { cause: error });
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(companionError('bridge-port-incompatible', { port }));
    }
    const result = safeParse(healthSchema, value);
    const version = result.success && /^2\.(\d+)\.\d+$/.exec(result.output.version);
    // Full equipment snapshots require the bridge's gear decoder.
    if (
      !response.ok ||
      !result.success ||
      !version ||
      Number(version[1]) < 11 ||
      result.output.protocol !== gameProfiles[game].protocol ||
      (result.output.game !== undefined && result.output.game !== game) ||
      (game === 'forever' && result.output.game !== game)
    ) {
      throw new Error(companionError('bridge-profile-incompatible', { port, game }));
    }
    return true;
  }

  private async findResources() {
    const filename = gameProfiles[this.options.game ?? 'retail'].captureFile;
    const source = resolve(this.options.appPath, 'runtime', 'wow', 'WoWCompanionBridge');
    const bundled = join(this.options.resourcesPath, 'wow-companion-bridge');
    const script = (await this.isFile(join(bundled, 'server.py')))
      ? join(bundled, 'server.py')
      : (await this.isFile(join(source, 'server.py')))
        ? join(source, 'server.py')
        : undefined;
    if (!script) throw new Error(companionError('bridge-files-missing'));
    // Both npm plugin installs and packaged apps keep calibration outside their immutable runtime resources.
    const directory = join(this.options.userDataPath, 'wow-companion-bridge');
    await mkdir(directory, { recursive: true });
    const config = join(directory, filename);
    if (!(await this.isFile(config)) && (await this.isFile(join(source, filename)))) {
      try {
        await copyFile(join(source, filename), config, constants.COPYFILE_EXCL);
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error;
      }
    }
    return { script, config };
  }

  private async findPython(signal: AbortSignal) {
    const directories = (process.env.PATH ?? '')
      .split(delimiter)
      .map((path) => path.replace(/^"|"$/g, ''))
      .filter(Boolean);
    // Resolve PATH entries before execution. WindowsApps aliases can open the Store instead of running Python.
    for (const program of ['python.exe', 'py.exe']) {
      for (const directory of directories) {
        signal.throwIfAborted();
        if (/[\\/]WindowsApps(?:[\\/]|$)/i.test(directory)) continue;
        const executable = join(directory, program);
        if (!(await this.isFile(executable))) continue;
        try {
          const args = program === 'py.exe' ? ['-3'] : [];
          args.push(
            '-c',
            'import json,sys; print(json.dumps({"executable":sys.executable,"major":sys.version_info.major,"minor":sys.version_info.minor}))',
          );
          const result = await execFileAsync(executable, args, {
            windowsHide: true,
            timeout: 3500,
            maxBuffer: 8192,
            encoding: 'utf8',
            signal,
          });
          const python = safeParse(pythonSchema, JSON.parse(result.stdout));
          if (
            python.success &&
            !/[\\/]WindowsApps(?:[\\/]|$)/i.test(python.output.executable) &&
            (await this.isFile(python.output.executable))
          )
            return python.output.executable;
        } catch {
          signal.throwIfAborted();
          // A different installed Python on PATH can satisfy the required version.
        }
      }
    }
    throw new Error(companionError('bridge-python-missing'));
  }

  private async isFile(path: string) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  private async releaseOwned() {
    const owned = this.owned;
    if (!owned) return;
    this.owned = undefined;
    if (owned.done) return;
    owned.child.stdin.end();
    await Promise.race([owned.exited, delay(3500, undefined, { ref: false })]);
    if (!owned.done) {
      owned.child.kill();
      await Promise.race([owned.exited, delay(1500, undefined, { ref: false })]);
    }
  }
}
