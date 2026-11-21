/**
 * Run time: pauses excluded, frozen at the end. A team's deadline is the run's
 * limit plus the host's adjustments (deadlineMs); its score never includes them.
 */

import { deadlineMs } from './escape-rules';
import type { RunClock } from './escape-live.types';
import type { TeamState } from './escape.types';

export function runElapsed(c: RunClock, now: number): number {
  if (!c.startedAt) return 0;
  if (c.endedElapsedMs !== null) return c.endedElapsedMs;
  return Math.max(0, (c.pausedAt || now) - c.startedAt - c.pausedMs);
}
export const pauseClock = (c: RunClock, now: number): RunClock =>
  !c.startedAt || c.pausedAt ? c : { ...c, pausedAt: now };
export const resumeClock = (c: RunClock, now: number): RunClock =>
  !c.pausedAt ? c : { ...c, pausedMs: c.pausedMs + (now - c.pausedAt), pausedAt: 0 };
export const endClock = (c: RunClock, now: number): RunClock =>
  c.endedElapsedMs !== null ? c : { ...c, endedElapsedMs: runElapsed(c, now) };
/** The team's own clock: frozen at its escape, shifted by the host's adjustments (deadline only). */
export const teamClock = (t: TeamState, elapsed: number) => (t.escapedAt ?? elapsed) - t.adjustMs;
/** Time left before the team's deadline: deadlineMs(limitMs, t) − run time. */
export const remainingMs = (c: RunClock, t: TeamState, elapsed: number) =>
  Math.max(0, c.limitMs - teamClock(t, elapsed));
export const isTimedOut = (c: RunClock, t: TeamState, elapsed: number) =>
  t.escapedAt === null && elapsed >= deadlineMs(c.limitMs, t);
/** Epoch ms of the team's deadline, for phones to count down; null when no clock runs for it. */
export function deadlineAt(c: RunClock, t: TeamState, now: number): number | null {
  const e = runElapsed(c, now);
  if (
    !c.startedAt ||
    c.pausedAt ||
    c.endedElapsedMs !== null ||
    t.escapedAt !== null ||
    isTimedOut(c, t, e)
  )
    return null;
  return now + remainingMs(c, t, e);
}
export const stageOpenedAt = (t: TeamState) =>
  t.stageIndex === 0 ? 0 : (t.stageClearedAt[t.stageIndex - 1] ?? 0);
