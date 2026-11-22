import type { EscapeScreenFinale } from '@quiz-dock/contracts';
import { type LanesLayout, lanesLayoutOf } from './screen-layout';

/**
 * The split-time replay (M6 §1.5), pure: the run replayed from the stage clears the
 * screen finale carries. Each team's marker slides from stage to stage between its
 * clears; an escaped team reaches the finish at its escape time and then shows its hint
 * penalty and score (which may swap places); a team that timed out stops at the stage
 * it reached. The last frame's places are the ranking. Lanes keep the team order
 * (owner question 5): the order of the lanes never gives the result away.
 */

/** The replay's length for a run of any length. */
export const REPLAY_MS = 20_000;
/** A very short run plays in real time, but never in under this. */
export const MIN_REPLAY_MS = 8_000;

type Ranked = EscapeScreenFinale['ranking'][number];

export interface TeamFrame {
  teamId: string;
  name: string;
  /** 0 (start) to the stage count (finish); a fraction while between two clears. */
  position: number;
  /** Escaped and past its escape time: the penalty and score show. */
  finished: boolean;
  /** Timed out and past its last moment: greyed, "Time up". */
  timeUp: boolean;
  /** The time the lane shows: the run time so far, then its score once finished. */
  timeMs: number;
  /** The live place, 1-based; teams level share one. */
  place: number;
  /** The hint penalty shown once finished. */
  penaltyS: number;
}

export interface Frame {
  /** The run time this frame shows. */
  t: number;
  /** In team order (fixed lanes); `place` says who leads. */
  teams: TeamFrame[];
}

/**
 * The run time the replay ends at: the last clear of any team, or the limit when a team
 * timed out. The host may have given extra time, so a clear can come after `limitMs`:
 * the later of both. Nobody cleared anything: 0 (a still frame).
 */
export function maxTOf(finale: EscapeScreenFinale): number {
  const clears = finale.ranking.flatMap((r) => r.stageClearedAt);
  if (!clears.length) return 0;
  const last = Math.max(...clears);
  return finale.ranking.some((r) => r.timedOut) ? Math.max(last, finale.limitMs) : last;
}

/** How long the replay plays (ms of the screen's time): 0 for a still frame. */
export function replayMsOf(finale: EscapeScreenFinale): number {
  const maxT = maxTOf(finale);
  if (maxT === 0) return 0;
  return Math.max(MIN_REPLAY_MS, Math.min(REPLAY_MS, maxT));
}

/** The run time shown `elapsed` ms into the replay. */
export function runTimeAt(finale: EscapeScreenFinale, elapsed: number): number {
  const replayMs = replayMsOf(finale);
  const maxT = maxTOf(finale);
  if (replayMs === 0) return maxT;
  return (Math.min(Math.max(elapsed, 0), replayMs) / replayMs) * maxT;
}

function positionAt(r: Ranked, t: number): number {
  const clears = r.stageClearedAt;
  for (let i = 0; i < clears.length; i++) {
    if (t < clears[i]) {
      const from = i === 0 ? 0 : clears[i - 1];
      const span = clears[i] - from;
      return i + (span > 0 ? (t - from) / span : 1);
    }
  }
  // Past its last clear: at the finish, or held where it stopped.
  return clears.length;
}

const finishOf = (r: Ranked) =>
  r.escaped && r.stageClearedAt.length ? r.stageClearedAt[r.stageClearedAt.length - 1] : null;

const collator = new Intl.Collator('en', { numeric: true });

/** The teams in team order: their ids are `t1`, `t2`… in the order the run made them. */
export function teamOrderOf(finale: EscapeScreenFinale): Ranked[] {
  return [...finale.ranking].sort((a, b) => collator.compare(a.teamId, b.teamId));
}

export interface ReplayTeams {
  /** The teams shown, in team order. */
  teams: Ranked[];
  /** As the race track (screen-layout.ts): one column up to 5 teams, then up to 4. */
  columns: LanesLayout['columns'];
  /** Above 30: the top 12 by place are shown, this many are not. */
  more: number;
}

/** Lanes on one screen without scrolling (M6 §1.8), laid out as the race track. */
export function replayTeamsOf(finale: EscapeScreenFinale): ReplayTeams {
  const n = finale.ranking.length;
  const { columns, shown } = lanesLayoutOf(n);
  if (shown >= n) return { teams: teamOrderOf(finale), columns, more: 0 };
  const top = new Set(
    [...finale.ranking]
      .sort((a, b) => a.place - b.place)
      .slice(0, shown)
      .map((r) => r.teamId),
  );
  return {
    teams: teamOrderOf(finale).filter((r) => top.has(r.teamId)),
    columns,
    more: n - shown,
  };
}

export function frameAt(finale: EscapeScreenFinale, t: number): Frame {
  const maxT = maxTOf(finale);
  const end = t >= maxT;
  const teams = teamOrderOf(finale).map((r) => {
    const finishAt = finishOf(r);
    const finished = finishAt !== null && t >= finishAt;
    const lastMoment = Math.max(finale.limitMs, ...r.stageClearedAt);
    return {
      r,
      frame: {
        teamId: r.teamId,
        name: r.name,
        position: end ? r.stageClearedAt.length : positionAt(r, t),
        finished: finished || (end && r.escaped),
        timeUp: r.timedOut && (end || t >= lastMoment),
        timeMs:
          (finished || (end && r.escaped)) && r.scoreMs !== null ? r.scoreMs : Math.min(t, maxT),
        place: 0,
        penaltyS: r.hintPenaltyS,
      } satisfies TeamFrame,
    };
  });
  // Finished teams by score, then the others by how far they are; level teams share a
  // place. The last frame's places are the ranking's (ties included).
  const ahead = (a: TeamFrame, b: TeamFrame) => {
    if (a.finished !== b.finished) return a.finished;
    if (a.finished) return a.timeMs < b.timeMs;
    return a.position > b.position;
  };
  for (const x of teams) {
    x.frame.place = end ? x.r.place : 1 + teams.filter((o) => ahead(o.frame, x.frame)).length;
  }
  return { t: Math.min(t, maxT), teams: teams.map((x) => x.frame) };
}

/**
 * The split times as a table: a row per team of `teams` (team order by default), each
 * stage's run time at its clear (null: not cleared). Teams are rows, stages columns: a
 * run has a few stages and maybe many teams, and rows stack where columns would not fit.
 */
export function splitTableOf(
  finale: EscapeScreenFinale,
  teams: Ranked[] = teamOrderOf(finale),
): (number | null)[][] {
  return teams.map((r) => finale.stages.map((_, i) => r.stageClearedAt[i] ?? null));
}
