/** A level change uses the desktop receipt time, in Unix milliseconds. */
export interface LevelHistoryRecord {
  id: number;
  fromLevel: number | null;
  level: number;
  recordedAt: number;
  /** Gaps and clock changes cannot identify the exact upgrade time. */
  source: 'baseline' | 'live' | 'gap' | 'decrease' | 'clock-change';
  durationMs: number | null;
  /** Complete intervals join two observed upgrades. Partial intervals start when AIRI first observed the previous level. */
  durationBasis: 'complete' | 'partial' | 'unknown';
}

/** Account and character GUID identify one history inside a fixed game profile. */
export interface LevelHistoryCharacter {
  account: string;
  guid: string;
  name: string;
  realm: string;
  currentLevel: number;
  firstSeen: number;
  lastSeen: number;
  /** Entries retain receipt order, including decreases and clock corrections. */
  records: LevelHistoryRecord[];
}

/** Saved level histories remain available when the game or desktop connection stops. */
export interface LevelHistoryState {
  characters: LevelHistoryCharacter[];
  storageError: string | null;
}
