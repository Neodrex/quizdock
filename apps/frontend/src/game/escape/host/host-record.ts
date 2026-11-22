import { storedRecord } from '../escape-record';

/**
 * The host console's record of its last run (`live.escape.host.last`, M5 §1.5): after
 * the room closed, `host:attach` is refused and this is how the console finds the run
 * whose results it may still read (the host path of `escape:results`).
 */
export interface HostRecord {
  pin: string;
  /** The run's 32-hex id, the key for `escape:results`. */
  gameId: string;
  /** Epoch ms of the save: an old record is another evening's game. */
  savedAt: number;
}

const host = storedRecord<HostRecord>('live.escape.host.last');

export function saveHostRecord(r: Omit<HostRecord, 'savedAt'>): void {
  host.save(r);
}

/** The record for this PIN, or null (none, another room's, too old, or no storage). */
export function loadHostRecord(pin: string): HostRecord | null {
  return host.load(pin);
}

export function clearHostRecord(): void {
  host.clear();
}
