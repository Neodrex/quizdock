import { Injectable } from '@nestjs/common';
import { ANSWER_COUNT_EVERY_MS } from '../game/game.keys';

/** An escape room waits this long for a host who left (owner decision 1). */
export const ESCAPE_HOST_WINDOW_MS = 15 * 60_000;

/**
 * Escape run timings (M3 plan §1.5). Not in SETTINGS: the backend reads
 * `process.env` only in the settings module, and new entries would touch the
 * upstream registry. Public and mutable so tests can speed them up through
 * `app.get(EscapeTimings)`. Move to SETTINGS if operators need to tune them.
 */
@Injectable()
export class EscapeTimings {
  /** Ticker period: timed hints, time-up, stuck, presence. */
  tickMs = 1000;
  /** No progress for this long: the host sees the team as stuck. */
  stuckMs = 300_000;
  /** A member gone for less than this still holds their roles. */
  roleGraceMs = 10_000;
  /** Wrong answers a team may give in one window before it has to wait. */
  wrongMax = 6;
  wrongWindowS = 60;
  /** The big-screen board, at most this often. */
  boardEveryMs = ANSWER_COUNT_EVERY_MS;
  /** An escape room waits this long for a host who left: read by GameEngine. */
  readonly hostWindowMs = ESCAPE_HOST_WINDOW_MS;
}
