/**
 * What one tick does to one team (M3 plan §3, H3, T3, K2): timed hints, time-up
 * and stuck. Pure: the engine stores the record and sends the events.
 */

import { isTimedOut, stageOpenedAt } from './escape-clock';
import type { RunClock, TeamRecord } from './escape-live.types';
import { nextHint, useHint } from './escape-rules';
import type { EscapeTemplate, Hint, TeamState } from './escape.types';

export type TickEvent = `hint:${string}` | 'time-up' | 'stuck' | 'unstuck';

/**
 * The timed hints due now, in order: only the next hint can be released, so a
 * timed hint behind an untimed one waits for it.
 */
export function dueHints(tpl: EscapeTemplate, team: TeamState, elapsed: number): Hint[] {
  const onStage = elapsed - stageOpenedAt(team);
  const due: Hint[] = [];
  let scratch = team;
  for (;;) {
    if (scratch.escapedAt !== null) return due;
    const hint = nextHint(tpl, scratch);
    if (!hint || hint.releaseAfterS === null || onStage < hint.releaseAfterS * 1000) return due;
    due.push(hint);
    scratch = useHint(tpl, scratch, hint.id, { free: true });
  }
}

/**
 * One tick for one team, while the run runs (nothing while paused or ended).
 * Time-up uses the team's deadline (limit plus the host's adjustments); added
 * time clears it. Timed hints are free (owner decision 3). A team is stuck when
 * it is playing and made no progress for `stuckMs`.
 */
export function tickTeam(
  tpl: EscapeTemplate,
  rec: TeamRecord,
  clock: RunClock,
  elapsed: number,
  stuckMs: number,
): { rec: TeamRecord; events: TickEvent[] } {
  if (clock.pausedAt || clock.endedElapsedMs !== null) return { rec, events: [] };
  const events: TickEvent[] = [];
  let { team, timedOut, stuck } = rec;

  const late = isTimedOut(clock, team, elapsed);
  if (late && !timedOut) events.push('time-up');
  timedOut = late;

  if (!timedOut) {
    for (const hint of dueHints(tpl, team, elapsed)) {
      team = useHint(tpl, team, hint.id, { free: true });
      events.push(`hint:${hint.id}`);
    }
  }

  const playing = team.escapedAt === null && !timedOut;
  const nowStuck = playing && elapsed - rec.lastProgressAt >= stuckMs;
  if (nowStuck !== stuck) events.push(nowStuck ? 'stuck' : 'unstuck');
  stuck = nowStuck;

  if (team === rec.team && timedOut === rec.timedOut && stuck === rec.stuck) {
    return { rec, events };
  }
  return { rec: { ...rec, team, timedOut, stuck }, events };
}

/**
 * Every team escaped or past its deadline (the deadline decides, not a
 * `timedOut` flag the next tick may still clear). The engine then ends the run and
 * shows the finale (owner decision 4: time up starts the finale).
 */
export function allDone(clock: RunClock, recs: TeamRecord[], elapsed: number): boolean {
  return (
    recs.length > 0 &&
    recs.every((r) => r.team.escapedAt !== null || isTimedOut(clock, r.team, elapsed))
  );
}
