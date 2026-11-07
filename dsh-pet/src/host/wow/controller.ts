import { join } from 'node:path';
import { boolean, maxLength, object, parse, picklist, pipe, string } from 'valibot';
import type { InferOutput } from 'valibot';
import { captureSchema, demoSchema, gameVersionSchema, settingsSchema } from './shared/wow-companion.ts';
import type { CompanionState, GameVersion } from './shared/wow-companion.ts';
import { accountNameSchema } from './shared/wow-companion-gold.ts';
import { assessEquipment } from './shared/wow-companion-equipment-comparisons.ts';
import { macroImportSchema } from './shared/wow-macro-import.ts';
import { WowLauncher } from './services/wow-launcher-runtime.ts';
import { WindowsLauncherPlatform } from './services/wow-launcher-windows.ts';
import { WowAddonsController } from './services/addons-controller.ts';
import { createWowSecretStorage } from './secrets.ts';
import { WowJsonSettings } from './storage.ts';
import { WowProfile } from './profile.ts';
import { importWowHistory } from './history-import.ts';
import { searchWowKnowledge } from './knowledge/index.ts';
import type { KnowledgeGame } from './knowledge/index.ts';
import { GameScreenAssist } from './screen.ts';
import type { WowAppearance } from './appearance.ts';
import { prepareWowChatTools, finishWowMacroImport } from './chat-tools.ts';
import type { WowChatToolsPrepared } from './chat-tools.ts';
import type { IdleEligibility } from './idle.ts';
import {
  createWowChatContext,
  CompanionPolicy,
  CompanionIdlePolicy,
  calendarReminder,
  groupBuffReminder,
  formatWowEvent,
  formatWowCalendar,
  formatWowGroupBuff,
  formatWowEquipment,
  formatWowEquipmentOffer,
  formatWowIdle,
  canInteract,
  hasFreshCompanionObservation,
} from './chat-context.ts';

const preferencesSchema = object({
  activeGame: picklist(['retail', 'forever', 'classic']),
  locale: picklist(['zh-CN', 'en']),
  petId: pipe(string(), maxLength(128)),
  eventNotifications: boolean(),
  muted: boolean(),
});
const searchSchema = object({
  query: pipe(string(), maxLength(16000)),
  locale: pipe(string(), maxLength(32)),
  server: picklist(['retail', 'forever', 'classic']),
});
const importSchema = object({ sourceDirectory: pipe(string(), maxLength(32768)) });
type Preferences = InferOutput<typeof preferencesSchema>;

export interface WowControllerOptions {
  root: string;
  appPath: string;
  resourcesPath: string;
  /** Returns false when no awake, unlocked, visible pet can speak. */
  notify: (text: string, petId: string) => boolean;
  /** The host decides whether the selected pet can speak and whether foreground work must defer idle chatter. */
  idleEligibility?: (petId: string) => IdleEligibility;
  warn: (message: string) => void;
  appearance?: WowAppearance;
  appearanceChanged?: (petId: string, changedPetIds: string[]) => void;
}

/** Assembles migrated domain services behind the existing authenticated host router. */
export class WowCompanion {
  private readonly options: WowControllerOptions;
  private readonly preferences: WowJsonSettings<Preferences>;
  private profiles: Record<GameVersion, WowProfile>;
  private readonly launcher: WowLauncher;
  private readonly screen: GameScreenAssist;
  private readonly addons: WowAddonsController;
  private readonly policies = { retail: new CompanionPolicy(), forever: new CompanionPolicy() };
  private readonly idlePolicies = { retail: new CompanionIdlePolicy(), forever: new CompanionIdlePolicy() };
  private idleMessageIndex = 0;
  private readonly receipts: WowJsonSettings<{ keys: string[] }>;
  private readonly lastNotice = { retail: 0, forever: 0 };
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;

  constructor(options: WowControllerOptions) {
    this.options = options;
    this.preferences = new WowJsonSettings(
      join(options.root, 'preferences.json'),
      {
        activeGame: 'retail',
        locale: 'zh-CN',
        petId: '',
        eventNotifications: true,
        muted: false,
      },
      (input) => parse(preferencesSchema, input),
    );
    this.receipts = new WowJsonSettings(join(options.root, 'notice-receipts.json'), { keys: [] }, (input) => {
      const value = input as { keys?: unknown };
      if (
        !value ||
        !Array.isArray(value.keys) ||
        value.keys.length > 2000 ||
        !value.keys.every((key) => typeof key === 'string' && key.length <= 2000)
      )
        throw new Error('invalid-receipts');
      return { keys: value.keys as string[] };
    });
    this.profiles = this.createProfiles();
    this.launcher = new WowLauncher(join(options.root, 'launcher.json'), new WindowsLauncherPlatform());
    this.screen = new GameScreenAssist(options.root);
    this.addons = new WowAddonsController(options.root, createWowSecretStorage());
  }

  private createProfiles(): Record<GameVersion, WowProfile> {
    const make = (game: GameVersion) =>
      new WowProfile({ ...this.options, game, onState: (state) => this.notify(state) });
    return { retail: make('retail'), forever: make('forever') };
  }

  start(): void {
    if (!this.stopped) Object.values(this.profiles).forEach((profile) => profile.start());
  }

  async read(): Promise<unknown> {
    await Promise.all(Object.values(this.profiles).map((profile) => profile.load()));
    const project = (profile: WowProfile) => {
      const state = profile.read();
      return {
        ...state,
        equipmentComparisons: {
          ...state.equipmentComparisons,
          entries: state.equipmentComparisons.entries.map((entry) => ({
            ...entry,
            assessment: assessEquipment(entry.comparison),
          })),
        },
      };
    };
    let addonState;
    try {
      addonState = { addons: this.addons.read(), addonsError: null };
    } catch {
      addonState = { addons: null, addonsError: 'wow-addons-settings-invalid' };
    }
    return {
      profiles: { retail: project(this.profiles.retail), forever: project(this.profiles.forever) },
      settings: this.preferences.read(),
      settingsError: this.preferences.error,
      appearance: this.appearance(),
      launcher: await this.launcher.read(),
      screen: { settings: this.screen.readSettings(), error: this.screen.readError() },
      ...addonState,
      runtime: {
        directory: join(this.options.appPath, 'runtime', 'wow'),
        telemetryGames: ['retail', 'forever'],
        source: '2.19.0 / forever addon 1.17.0',
      },
    };
  }

  /** Empty saved selection always resolves to the built-in pet, not an arbitrary custom instance. */
  appearance() {
    const selectedPetId = this.preferences.read().petId;
    return this.options.appearance?.read(selectedPetId) ?? { selectedPetId, resolvedPetId: null, options: [] };
  }

  preferredPetId(): string | null {
    return this.appearance().resolvedPetId ?? (this.preferences.read().petId || null);
  }

  /** Mutations are serialized across launch, macro import and history replacement. */
  action(action: string, game: unknown, data: unknown): Promise<unknown> {
    if (this.stopped) return Promise.resolve({ ok: false, code: 'wow-stopped' });
    if (
      action === 'preferences.save' ||
      action === 'screen.save' ||
      action === 'knowledge.search' ||
      /^addons\.(?:installed|metadata|search|files|recommend)$/.test(action)
    ) {
      return this.perform(action, game, data);
    }
    // A stop request cancels a macro waiting for focus/combat immediately, rather than queueing behind it.
    if (action === 'settings.save') {
      try {
        const next = parse(settingsSchema, data);
        if (!next.enabled) return this.profiles[parse(gameVersionSchema, game)].setSettings(next);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const run = this.queue.then(() => {
      if (this.stopped) throw new Error('wow-stopped');
      return this.perform(action, game, data);
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async perform(action: string, game: unknown, data: unknown): Promise<unknown> {
    switch (action) {
      case 'appearance.select': {
        const { petId } = parse(object({ petId: pipe(string(), maxLength(128)) }), data);
        const service = this.options.appearance;
        if (!service) throw new Error('wow-appearance-unavailable');
        const previous = this.preferences.read().petId;
        const result = await service.select(petId, previous, () => {
          if (this.stopped) throw new Error('wow-stopped');
          this.preferences.save({ ...this.preferences.read(), petId });
        });
        if (result.resolvedPetId) this.options.appearanceChanged?.(result.resolvedPetId, result.changedPetIds);
        return result;
      }
      case 'preferences.save': {
        const next = parse(preferencesSchema, data);
        if (this.options.appearance && next.petId !== this.preferences.read().petId)
          throw new Error('wow-appearance-select-required');
        return this.preferences.save(next);
      }
      case 'launcher.save':
        return this.launcher.save(data);
      case 'launcher.launch':
        return this.launcher.launch(data ?? {});
      case 'screen.save':
        return this.screen.saveSettings(data);
      case 'knowledge.search': {
        const request = parse(searchSchema, data);
        return searchWowKnowledge({ text: request.query, locale: request.locale, game: request.server });
      }
      case 'history.import': {
        const request = parse(importSchema, data);
        await Promise.all(Object.values(this.profiles).map((profile) => profile.dispose()));
        try {
          return await importWowHistory(request.sourceDirectory, this.options.root);
        } finally {
          this.profiles = this.createProfiles();
          Object.values(this.policies).forEach((policy) => policy.reset());
          Object.values(this.idlePolicies).forEach((policy) => policy.reset());
          this.start();
        }
      }
    }
    if (action.startsWith('addons.')) return this.addons.action(action.slice(7), data);
    const profile = this.profiles[parse(gameVersionSchema, game)];
    switch (action) {
      case 'settings.save':
        return profile.setSettings(data);
      case 'capture.save':
        return profile.setCapture(parse(captureSchema, data));
      case 'demo':
        return profile.demo(parse(demoSchema, data));
      case 'account.rename':
        await profile.gold.setAccountName(parse(accountNameSchema, data));
        return profile.read();
      case 'macro.import': {
        const request = parse(macroImportSchema, data);
        if (request.game !== game) throw new Error('wow-game-mismatch');
        return profile.importMacro(request);
      }
      default:
        throw new Error('wow-unknown-action');
    }
  }

  context(text: string, gameOverride?: KnowledgeGame, maxChars?: number, preferGame = false): string {
    const settings = this.preferences.read();
    return createWowChatContext({
      text,
      game: gameOverride ?? settings.activeGame,
      locale: settings.locale,
      profiles: Object.values(this.profiles).map((profile) => profile.read()),
      maxChars,
      preferGame,
    });
  }

  async prepareChat(text: string, hasUserImage = false) {
    if (this.stopped) return { context: '', error: '魔兽陪伴服务已停止，本次没有截图或读取游戏画面。' };
    const game = this.preferences.read().activeGame;
    const active = game === 'classic' ? undefined : this.profiles[game].read();
    const tools = await prepareWowChatTools({
      text,
      game: game === 'classic' || (active && hasFreshCompanionObservation(active, Date.now())) ? game : undefined,
      action: (name, selected, data) => this.action(name, selected, data),
    });
    const selectedGame = tools.recommendations?.game ?? tools.macroIntent?.game;
    const contextBudget = 20000 - tools.context.length;
    const context = [this.context(text, selectedGame, contextBudget), tools.context].filter(Boolean).join('\n\n');
    if (hasUserImage) return { context, tools };
    const result = await this.screen.capture(text);
    if (this.stopped) return { context: '', error: '魔兽陪伴服务已停止，本次截图结果已丢弃。' };
    if (!result.ok) return { context, error: result.prompt };
    if ('skipped' in result) return { context, tools };
    return {
      context: [this.context(text, result.image.game, contextBudget, true), tools.context, result.prompt]
        .filter(Boolean)
        .join('\n\n'),
      transientImage: result.image,
      tools,
    };
  }

  /** Only a current user permit can cause one import; model prose never confirms success. */
  async finishChat(answer: string, prepared?: WowChatToolsPrepared): Promise<string> {
    if (!prepared) return answer;
    const result = await finishWowMacroImport({
      prepared,
      answer,
      action: (name, game, data) => this.action(name, game, data),
    });
    return result.text || answer;
  }

  private notify(state: CompanionState): void {
    if (this.stopped) return;
    const preferences = this.preferences.read();
    const effectiveSettings = {
      ...state.settings,
      muted: state.settings.muted || preferences.muted || !preferences.eventNotifications,
    };
    const now = Date.now();
    const eventBridge =
      state.error ||
      state.bridge?.error ||
      state.bridge?.config.paused ||
      (state.bridge?.source === 'screen' && !hasFreshCompanionObservation(state, now))
        ? null
        : state.bridge;
    const event = this.policies[state.game].accept(eventBridge, effectiveSettings, now);
    const effectiveState = { ...state, settings: effectiveSettings };
    const idlePolicy = this.idlePolicies[state.game];
    if (effectiveSettings.muted || this.preferences.error || this.receipts.error) {
      idlePolicy.reset();
      return;
    }
    const companionId = this.preferredPetId() ?? preferences.petId;
    const hostIdle = this.options.idleEligibility?.(companionId) ?? { eligible: false, busy: true };
    const observeIdle = (busy: boolean) =>
      idlePolicy.observe(effectiveState, now, {
        eligible: preferences.activeGame === state.game && hostIdle.eligible,
        busy: busy || hostIdle.busy,
      });
    if (now - this.lastNotice[state.game] < Math.max(5000, state.settings.cooldownSeconds * 1000)) {
      observeIdle(true);
      return;
    }
    const keys = this.receipts.read().keys;
    let text = event ? formatWowEvent(event, preferences.locale) : '';
    let receipts: string[] = [];
    if (!text) {
      if (!canInteract(effectiveState, now)) {
        idlePolicy.reset();
        return;
      }
      const calendar = calendarReminder(effectiveState, keys, now);
      const buff = groupBuffReminder(effectiveState, keys, now);
      if (calendar) {
        text = formatWowCalendar(calendar.calendar, preferences.locale);
        receipts = calendar.keys;
      } else if (buff) {
        text = formatWowGroupBuff(buff.buff, preferences.locale);
        receipts = [buff.key];
      }
    }
    if (!text && state.bridge?.snapshot) {
      const snapshot = state.bridge.snapshot;
      const comparison = state.bridge.equipmentComparisons?.find(
        (value) =>
          value.guid === snapshot.guid &&
          value.session === snapshot.session &&
          now - value.observedAt * 1000 >= -5000 &&
          now - value.observedAt * 1000 < 30_000 &&
          !keys.includes(JSON.stringify([state.game, snapshot.guid, snapshot.session, 'comparison', value.id])),
      );
      if (comparison) {
        text = formatWowEquipment(comparison, preferences.locale);
        receipts = [JSON.stringify([state.game, snapshot.guid, snapshot.session, 'comparison', comparison.id])];
      } else if (
        state.bridge.equipmentOffer?.st === 'ready' &&
        state.bridge.equipmentOffer.g === snapshot.guid &&
        state.bridge.equipmentOffer.s === snapshot.session &&
        state.bridge.equipmentOffer.until * 1000 > now
      ) {
        const offer = state.bridge.equipmentOffer;
        const key = JSON.stringify([state.game, snapshot.guid, snapshot.session, 'offer', offer]);
        if (!keys.includes(key)) {
          text = formatWowEquipmentOffer(offer, preferences.locale);
          receipts = [key];
        }
      }
    }
    const idle = observeIdle(Boolean(text));
    if (!text && idle) {
      text = formatWowIdle(idle, preferences.locale, this.idleMessageIndex++);
    }
    if (!text || !this.options.notify(text, companionId)) return;
    this.lastNotice[state.game] = now;
    if (receipts.length) {
      try {
        this.receipts.save({ keys: [...new Set([...keys, ...receipts])].slice(-1000) });
      } catch {
        this.options.warn('[wow] 提醒回执保存失败');
      }
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopped = true;
    this.screen.dispose();
    Object.values(this.idlePolicies).forEach((policy) => policy.reset());
    // Revoke native input/download leases before waiting for the action queue that owns those operations.
    const stoppedProfiles = Object.values(this.profiles);
    this.disposal = (async () => {
      await Promise.all([this.addons.dispose(), ...stoppedProfiles.map((profile) => profile.dispose())]);
      await this.queue;
      // A pending history import may have rebuilt profiles in its finally block while shutting down.
      await Promise.all([this.launcher.flush(), ...Object.values(this.profiles).map((profile) => profile.dispose())]);
    })();
    return this.disposal;
  }
}
