import type { BridgeStatus, CompanionState, Snapshot } from './shared/wow-companion.ts';

/** Host eligibility covers the current character, speech configuration, and global mute. Busy work delays one interaction. */
export interface IdleEligibility {
  eligible: boolean;
  busy: boolean;
}

/** Fresh, living noncombat observations permit an interaction. The host also applies character, speech, and activity eligibility. */
export function canInteract(
  state: CompanionState,
  now: number,
): state is CompanionState & { bridge: BridgeStatus & { snapshot: Snapshot } } {
  const bridge = state.bridge;
  const snapshot = bridge?.snapshot;
  const observedAt = Date.parse(bridge?.lastSeen ?? '');
  return (
    Number.isFinite(now) &&
    state.settings.enabled &&
    !state.settings.muted &&
    !state.error &&
    !!bridge &&
    !bridge.error &&
    bridge.status === 'live' &&
    bridge.source === 'screen' &&
    !bridge.config.paused &&
    !!snapshot?.online &&
    !snapshot.combat &&
    !snapshot.dead &&
    bridge.ageSeconds !== null &&
    Number.isFinite(bridge.ageSeconds) &&
    bridge.ageSeconds >= 0 &&
    bridge.ageSeconds <= 5 &&
    Number.isFinite(observedAt) &&
    now - observedAt <= 5000 &&
    observedAt - now <= 5000
  );
}

/**
 * One character session earns an interaction after one continuous minute outside combat.
 * Invalid observations reset the interval. Busy work retains one opportunity without accumulating missed interactions.
 */
export class CompanionIdlePolicy {
  private identity = '';
  private nextAt = 0;
  private lastObservedAt: number | undefined;

  /** Releases the runtime interval when its desktop owner stops or loses the current character. */
  reset() {
    this.identity = '';
    this.nextAt = 0;
    this.lastObservedAt = undefined;
  }

  /** Returns only the current, fresh snapshot. The caller consumes an opportunity even when playback fails. */
  observe(state: CompanionState, now: number, { eligible, busy }: IdleEligibility): Snapshot | undefined {
    if (!eligible || !canInteract(state, now)) {
      this.reset();
      return;
    }

    const bridge = state.bridge;
    const snapshot = bridge.snapshot;
    const identity = JSON.stringify([state.game, bridge.instanceId, snapshot.account, snapshot.guid, snapshot.session]);
    // A suspended renderer cannot establish continuous noncombat time across sleep or a large clock change.
    const interrupted =
      this.lastObservedAt === undefined || now < this.lastObservedAt || now - this.lastObservedAt > 30_000;
    this.lastObservedAt = now;
    if (identity !== this.identity || interrupted) {
      this.identity = identity;
      this.nextAt = now + 60_000;
      return;
    }
    if (now < this.nextAt || busy) return;
    this.nextAt = now + 60_000;
    return snapshot;
  }
}
