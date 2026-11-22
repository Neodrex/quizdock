/**
 * The phone's record of its last escape run (`live.escape.last`): enough to fetch the
 * results after a reload. Kept apart from `live.session`, which `useGameSession` clears
 * when a reconnect is refused, the very moment the token is still needed.
 */
export interface EscapeRecord {
  pin: string;
  /** The run's 32-hex id, the key for `escape:results`. */
  gameId: string;
  playerId: string;
  sessionToken: string;
  teamId: string | null;
  /** Epoch ms of the save: an old record is another evening's game. */
  savedAt: number;
}

/** How long a record is kept: past this the room is long gone. */
export const RECORD_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * A record of one room in `localStorage` under `key`: saved with its time, read back
 * for its PIN only while fresh. Every access is wrapped: private mode or a full
 * storage only loses the results after a reload.
 */
export function storedRecord<T extends { pin: string; savedAt: number }>(key: string) {
  return {
    save(r: Omit<T, 'savedAt'>): void {
      try {
        localStorage.setItem(key, JSON.stringify({ ...r, savedAt: Date.now() }));
      } catch {
        /* private mode: no results after a reload */
      }
    },
    /** The record for this PIN, or null (none, another room's, too old, or no storage). */
    load(pin: string): T | null {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const r = JSON.parse(raw) as T;
        const fresh = typeof r.savedAt === 'number' && Date.now() - r.savedAt <= RECORD_TTL_MS;
        return r.pin === pin && fresh ? r : null;
      } catch {
        return null;
      }
    },
    clear(): void {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

const phone = storedRecord<EscapeRecord>('live.escape.last');

export function saveEscapeRecord(r: Omit<EscapeRecord, 'savedAt'>): void {
  phone.save(r);
}

/** The record for this PIN, or null (none, another room's, too old, or no storage). */
export function loadEscapeRecord(pin: string): EscapeRecord | null {
  return phone.load(pin);
}

export function clearEscapeRecord(): void {
  phone.clear();
}
