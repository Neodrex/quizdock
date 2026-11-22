import type { EscapeScreenFinale } from '@quiz-dock/contracts';

/**
 * The big screen's record of its run's finale (`live.escape.screen.<pin>`, M6 §1.6), in
 * `sessionStorage`: a reload in the finale shows the standings without replaying the
 * race, and the finale stays up after the room closed. Every access is wrapped: private
 * mode or a full storage only loses that.
 */
export interface ScreenRecord {
  pin: string;
  gameId: string;
  /** The split-time replay was played for this run. */
  replayed: boolean;
  finale: EscapeScreenFinale;
}

const keyOf = (pin: string) => `live.escape.screen.${pin}`;

export function saveScreenRecord(pin: string, r: Omit<ScreenRecord, 'pin'>): void {
  try {
    sessionStorage.setItem(keyOf(pin), JSON.stringify({ pin, ...r }));
  } catch {
    /* private mode: the replay plays again after a reload */
  }
}

/** This PIN's record, or null (none, broken, or no storage). */
export function loadScreenRecord(pin: string): ScreenRecord | null {
  try {
    const raw = sessionStorage.getItem(keyOf(pin));
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<ScreenRecord> | null;
    if (!r || r.pin !== pin || typeof r.gameId !== 'string' || !r.finale) return null;
    return { pin, gameId: r.gameId, replayed: r.replayed === true, finale: r.finale };
  } catch {
    return null;
  }
}

/** The replay of run `gameId` was played: a reload shows the standings straight away. */
export function markScreenReplayed(pin: string, gameId: string): void {
  const r = loadScreenRecord(pin);
  if (!r || r.gameId !== gameId || r.replayed) return;
  saveScreenRecord(pin, { gameId, replayed: true, finale: r.finale });
}
