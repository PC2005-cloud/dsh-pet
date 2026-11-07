import type { BridgeStatus, CompanionEvent, CompanionSettings } from './shared/wow-companion.ts';

/**
 * Tracks one bridge cursor and one character session. New sessions establish a baseline.
 * Muting discards events. Combat and cooldown retain at most one recent event.
 */
export class CompanionPolicy {
  private identity = '';
  private cursor = -1;
  private lastSpokenAt = -Infinity;
  private pending?: CompanionEvent;

  reset() {
    this.identity = '';
    this.cursor = -1;
    this.pending = undefined;
    this.lastSpokenAt = -Infinity;
  }

  /** Returns at most one notification. Call with the current wall-clock time in milliseconds. */
  accept(bridge: BridgeStatus | null, settings: CompanionSettings, now: number): CompanionEvent | undefined {
    if (!bridge || !settings.enabled || !['live', 'demo'].includes(bridge.status) || !bridge.snapshot?.online) {
      this.reset();
      return;
    }
    const identity = `${bridge.instanceId}:${bridge.source}:${bridge.snapshot.guid}:${bridge.snapshot.session}`;
    if (identity !== this.identity || bridge.eventCursor < this.cursor) {
      this.reset();
      this.identity = identity;
      this.cursor = bridge.eventCursor;
      return;
    }

    const newEvents = bridge.events.filter((event) => event.id > this.cursor);
    this.cursor = bridge.eventCursor;
    if (settings.muted || (bridge.source === 'demo' && !settings.allowDemo)) {
      this.pending = undefined;
      return;
    }

    for (const event of newEvents) {
      const matchesSession =
        event.snapshot?.guid === bridge.snapshot.guid && event.snapshot.session === bridge.snapshot.session;
      const age = now - Date.parse(event.timestamp);
      const fresh = Number.isFinite(age) && age >= -5000 && age <= 30_000;
      if (!matchesSession || !fresh || !this.isEnabled(event, settings)) continue;
      // An upgrade survives incidental zone changes during the same combat.
      if (!this.pending || event.type === 'level_up' || this.pending.type !== 'level_up') this.pending = event;
    }
    if (this.pending && (!this.isEnabled(this.pending, settings) || now - Date.parse(this.pending.timestamp) > 30_000))
      this.pending = undefined;
    if ((settings.quietInCombat && bridge.snapshot.combat) || now - this.lastSpokenAt < settings.cooldownSeconds * 1000)
      return;
    const next = this.pending;
    this.pending = undefined;
    if (next) this.lastSpokenAt = now;
    return next;
  }

  private isEnabled(event: CompanionEvent, settings: CompanionSettings) {
    if (
      event.type === 'zone' &&
      (!event.snapshot?.map || !event.snapshot.zone || event.snapshot.zone === '当前位置暂不可用')
    )
      return false;
    return (
      (event.type === 'level_up' && settings.levelUp) ||
      (event.type === 'zone' && settings.zone) ||
      (event.type === 'death' && settings.death) ||
      (event.type === 'revive' && settings.revive)
    );
  }
}
