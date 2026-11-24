import { Injectable } from '@nestjs/common';
import { ANSWER_COUNT_EVERY_MS } from '../game/game.keys';
import { RACE_BOARD_EVERY_MS } from './escape-session';

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
  /**
   * A hosted event's host console (state, team details, updates, its board), at
   * most this often: a race board's period (M9 Batch 2 fix round).
   */
  hostEveryMs = RACE_BOARD_EVERY_MS;
  /** A running run's keys (and its room's) get their TTL again at most this often, from the ticker. */
  touchEveryMs = 300_000;
  /** A scheduled race starts at least this far ahead of its create (M7 §1.7). */
  raceMinLeadMs = 60_000;
  /** While a scheduled race waits, its room's keys get their TTL again this often. */
  raceTouchEveryMs = 300_000;
  /** A scheduled start that failed (not refused) is tried again this much later, within its grace. */
  raceRetryMs = 5_000;
  /** A Site race room the Site could not be told about tries `opened` again this often (M9 Task 9.6). */
  siteRetryMs = 30_000;
}
