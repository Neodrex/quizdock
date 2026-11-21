import { Injectable } from '@nestjs/common';
import { ANSWER_COUNT_EVERY_MS } from '../game/game.keys';

/**
 * Escape run timings (M3 plan §1.5). Not in SETTINGS: the backend reads
 * the environment only in the settings module, and new entries would touch the
 * upstream registry. Public and mutable so tests can speed them up through
 * `app.get(EscapeTimings)`. Move to SETTINGS if operators need to tune them.
 * The host window is GameEngine's: ESCAPE_HOST_WINDOW_MS in game.keys.
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
  /** A running run's keys (and its room's) get their TTL again at most this often, from the ticker. */
  touchEveryMs = 300_000;
}
