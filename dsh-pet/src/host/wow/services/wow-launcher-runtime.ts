import type {
  LauncherConfig,
  LauncherErrorCode,
  LauncherExecutable,
  LauncherResult,
  LauncherState,
  LauncherTarget,
} from '../shared/wow-launcher';

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parse, safeParse } from 'valibot';

import { launcherConfigSchema, launcherLaunchSchema, launcherSaveSchema } from '../shared/wow-launcher';

/** The operating-system boundary owns executable inspection and process creation. */
export interface LauncherPlatform {
  supported: boolean;
  inspect: (target: LauncherTarget, path: string) => Promise<LauncherExecutable>;
  launch: (executable: LauncherExecutable) => Promise<void>;
}

/** Stable error codes cross IPC. The renderer supplies translated explanations. */
export class LauncherFailure extends Error {
  readonly code: LauncherErrorCode;

  constructor(code: LauncherErrorCode) {
    super(code);
    this.code = code;
  }
}

/**
 * Owns persisted launch paths and serializes saves against launches.
 * Only a successful inspection and atomic write change configuration. Every launch inspects the saved file again.
 */
export class WowLauncher {
  private config: LauncherConfig = {
    defaultTarget: 'battle-net',
    paths: { 'battle-net': '', retail: '', forever: '', classic: '' },
  };
  private loading: Promise<void> | undefined;
  private storageError = false;
  private operation: Promise<LauncherResult> | undefined;
  private nextLaunchAt = 0;

  private readonly filePath: string;
  private readonly platform: LauncherPlatform;

  constructor(filePath: string, platform: LauncherPlatform) {
    this.filePath = filePath;
    this.platform = platform;
  }

  async read(): Promise<LauncherState> {
    await this.load();
    return this.state();
  }

  /** An empty path removes one target. Invalid replacements keep the previous configuration. */
  save(input: unknown): Promise<LauncherResult> {
    return this.run(async () => {
      const parsed = safeParse(launcherSaveSchema, input);
      if (!parsed.success) throw new LauncherFailure('invalid-request');
      const request = parsed.output;
      const path = request.path.trim();
      const executable = path ? await this.platform.inspect(request.target, path) : undefined;
      const next: LauncherConfig = {
        defaultTarget: request.makeDefault ? request.target : this.config.defaultTarget,
        paths: { ...this.config.paths, [request.target]: executable?.path ?? '' },
      };
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const file = await open(temporary, 'wx');
        try {
          await file.writeFile(JSON.stringify(next), 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.filePath);
      } catch {
        throw new LauncherFailure('storage-error');
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      this.config = next;
      return { ok: true, state: this.state(), executable };
    });
  }

  /** Renderer requests name only a target. They cannot supply a command, arguments, or an unsaved launch path. */
  launch(input: unknown): Promise<LauncherResult> {
    return this.run(async () => {
      const parsed = safeParse(launcherLaunchSchema, input);
      if (!parsed.success) throw new LauncherFailure('invalid-request');
      if (Date.now() < this.nextLaunchAt) throw new LauncherFailure('busy');
      const target = parsed.output.target ?? this.config.defaultTarget;
      const path = this.config.paths[target];
      if (!path) throw new LauncherFailure('not-configured');
      const executable = await this.platform.inspect(target, path);
      try {
        await this.platform.launch(executable);
      } catch {
        throw new LauncherFailure('launch-failed');
      }
      // A process-spawn receipt precedes the game's own startup. Suppress rapid repeated clicks during that gap.
      this.nextLaunchAt = Date.now() + 3000;
      return { ok: true, state: this.state(), executable };
    });
  }

  /** Shutdown waits for an accepted save. It never terminates the launched game. */
  async flush() {
    await this.operation;
  }

  private state(): LauncherState {
    return {
      ...structuredClone(this.config),
      supported: this.platform.supported,
      ...(this.storageError ? { error: 'storage-error' as const } : {}),
    };
  }

  private async load() {
    this.loading ??= (async () => {
      try {
        this.config = parse(launcherConfigSchema, JSON.parse(await readFile(this.filePath, 'utf8')));
      } catch (error) {
        // A first launch has no configuration. A corrupt or unreadable file must not be overwritten by an empty state.
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT')
          this.storageError = true;
      }
    })();
    await this.loading;
  }

  private run(action: () => Promise<LauncherResult>): Promise<LauncherResult> {
    if (this.operation) return Promise.resolve({ ok: false, code: 'busy' });
    const operation = (async (): Promise<LauncherResult> => {
      try {
        if (!this.platform.supported) throw new LauncherFailure('unsupported-platform');
        await this.load();
        if (this.storageError) throw new LauncherFailure('storage-error');
        return await action();
      } catch (error) {
        return { ok: false, code: error instanceof LauncherFailure ? error.code : 'inspection-failed' };
      }
    })();
    this.operation = operation;
    void operation.finally(() => {
      if (this.operation === operation) this.operation = undefined;
    });
    return operation;
  }
}
