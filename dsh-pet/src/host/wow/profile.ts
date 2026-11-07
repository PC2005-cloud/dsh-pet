import { join } from 'node:path';
import { parse } from 'valibot';
import type {
  CaptureSettings,
  CompanionSettings,
  CompanionState,
  DemoRequest,
  GameVersion,
} from './shared/wow-companion.ts';
import type { MacroImportRequest } from './shared/wow-macro-import.ts';
import { defaultSettings, gameProfiles, settingsSchema } from './shared/wow-companion.ts';
import { CompanionBridgeClient } from './services/wow-companion-client.ts';
import { CompanionBridgeRuntime } from './services/wow-companion-runtime.ts';
import { CompanionGoldLedger } from './services/wow-companion-gold.ts';
import { CompanionEquipmentHistory } from './services/wow-companion-equipment-history.ts';
import { CompanionLevelHistory } from './services/wow-companion-level-history.ts';
import { CompanionEquipmentComparisons } from './services/wow-companion-equipment-comparisons.ts';
import { CompanionLoadouts } from './services/wow-companion-loadouts.ts';
import { WindowsGameCapture } from './screen-windows.ts';
import { WowJsonSettings } from './storage.ts';

export interface ProfileOptions {
  game: GameVersion;
  root: string;
  appPath: string;
  resourcesPath: string;
  onState?: (state: CompanionState) => void;
  client?: CompanionBridgeClient;
  runtime?: CompanionBridgeRuntime;
}

/** One game owns one generation, bridge, poller and set of ledgers. Disabled by default in a new installation. */
export class WowProfile {
  private readonly game: GameVersion;
  private readonly settings: WowJsonSettings<CompanionSettings>;
  private readonly client: CompanionBridgeClient;
  private readonly runtime: CompanionBridgeRuntime;
  readonly gold: CompanionGoldLedger;
  private readonly history: CompanionEquipmentHistory;
  private readonly levels: CompanionLevelHistory;
  private readonly comparisons: CompanionEquipmentComparisons;
  private readonly loadouts: CompanionLoadouts;
  private readonly onState?: ProfileOptions['onState'];
  private stopped = false;
  private started = false;
  private generation = 0;
  private connectionError: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private disposal?: Promise<void>;

  constructor(options: ProfileOptions) {
    const { game, root } = options;
    const profile = gameProfiles[game];
    this.game = game;
    this.onState = options.onState;
    this.settings = new WowJsonSettings(
      join(root, `${profile.settingsNamespace}.json`),
      { ...defaultSettings, enabled: false },
      (input) => parse(settingsSchema, input),
    );
    this.client = options.client ?? new CompanionBridgeClient(undefined, game);
    this.runtime =
      options.runtime ??
      new CompanionBridgeRuntime({
        appPath: options.appPath,
        resourcesPath: options.resourcesPath,
        userDataPath: root,
        platform: process.platform,
        game,
      });
    this.gold = new CompanionGoldLedger(join(root, profile.goldFile));
    this.history = new CompanionEquipmentHistory(join(root, profile.historyFile));
    this.levels = new CompanionLevelHistory(join(root, profile.levelsFile));
    this.comparisons = new CompanionEquipmentComparisons(join(root, profile.comparisonsFile));
    this.loadouts = new CompanionLoadouts(join(root, profile.loadoutsFile));
  }

  private stores() {
    return [this.gold, this.history, this.levels, this.comparisons, this.loadouts];
  }
  async load(): Promise<void> {
    await Promise.all(this.stores().map((store) => store.load()));
  }

  read(): CompanionState {
    const state = this.client.read();
    const settings = this.settings.read();
    return {
      game: this.game,
      settings,
      ...state,
      // Never present a stale observation as a connected character after disabling.
      bridge: settings.enabled && !this.settings.error ? state.bridge : null,
      error:
        this.settings.error ??
        (settings.enabled ? (this.connectionError ?? this.runtime.read().error ?? state.error) : null),
      gold: this.gold.read(),
      equipmentHistory: this.history.read(),
      levelHistory: this.levels.read(),
      equipmentComparisons: this.comparisons.read(),
      equipmentLoadouts: this.loadouts.read(),
    };
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.polling = this.poll()
        .catch(() => {
          this.connectionError = 'wow-poll-failed';
        })
        .finally(() => {
          if (!this.stopped) this.schedule(500);
        });
    }, delay);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    await this.load();
    const generation = this.generation;
    if (this.settings.read().enabled && !this.settings.error && !this.stopped) {
      try {
        await this.runtime.ensureReady();
        if (!this.stopped && generation === this.generation) {
          this.connectionError = null;
          await this.client.refresh();
        }
      } catch {
        if (!this.stopped && generation === this.generation) {
          this.connectionError = 'wow-bridge-unavailable';
          this.client.invalidate();
        }
      }
    }
    if (this.stopped || generation !== this.generation) return;
    const state = this.read();
    const bridge = state.settings.enabled && !state.error ? state.bridge : null;
    await Promise.all(this.stores().map((store) => store.observe(bridge, state.error)));
    if (!this.stopped) this.onState?.(this.read());
  }

  async setSettings(input: unknown): Promise<CompanionState> {
    if (this.stopped) throw new Error('wow-disposed');
    const previous = this.settings.read();
    const next = this.settings.save(input);
    if (previous.enabled !== next.enabled) {
      this.generation++;
      this.connectionError = null;
      this.client.invalidate();
      await this.levels.observe(null);
    }
    if (!next.enabled) await this.runtime.stop();
    return this.read();
  }

  private async ensureConnected(): Promise<void> {
    const generation = this.generation;
    if (!this.settings.read().enabled || this.settings.error || this.stopped)
      throw new Error('wow-connection-disabled');
    await this.runtime.ensureReady();
    if (!this.settings.read().enabled || this.stopped || generation !== this.generation)
      throw new Error('wow-connection-changed');
  }

  async setCapture(capture: CaptureSettings): Promise<CompanionState> {
    await this.ensureConnected();
    await this.client.update('/api/config', capture);
    return this.read();
  }

  async demo(request: DemoRequest): Promise<CompanionState> {
    await this.ensureConnected();
    await this.client.update('/api/demo', {
      enabled: request.enabled,
      ...(request.action === 'none' ? {} : { action: request.action }),
    });
    return this.read();
  }

  async importMacro(request: MacroImportRequest): Promise<unknown> {
    if (!this.settings.read().enabled || this.stopped) return { ok: false, code: 'busy-or-disabled' };
    try {
      const platform = new WindowsGameCapture();
      const windows = (await platform.discover()).filter((window) => window.game === this.game);
      if (windows.length !== 1) return { ok: false, code: 'game-window-ambiguous-or-missing' };
      const window = windows[0]!;
      await platform.verify(window, this.game);
      await this.ensureConnected();
      if (!this.settings.read().enabled || this.stopped) return { ok: false, code: 'disabled' };
      return await this.runtime.runMacroImport(request, window);
    } catch {
      return { ok: false, code: 'desktop-import-failed' };
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    this.client.dispose();
    this.disposal = (async () => {
      await this.runtime.dispose();
      await this.polling;
      await Promise.all(this.stores().map((store) => store.flush()));
    })();
    return this.disposal;
  }
}
