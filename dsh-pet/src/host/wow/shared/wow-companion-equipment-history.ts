import type { EquipmentRecord } from './wow-companion-equipment';

/** A saved acquisition retains the character labels from its first accepted observation. */
export interface EquipmentHistoryEntry {
  account: string;
  name: string;
  realm: string;
  /** Local receipt time in milliseconds. The addon observation time remains in the record. */
  receivedAt: number;
  record: EquipmentRecord;
}

/** Each game profile retains its latest ten acquisitions across characters, in receipt order from oldest to newest. */
export interface EquipmentHistoryState {
  entries: EquipmentHistoryEntry[];
  storageError: string | null;
}
