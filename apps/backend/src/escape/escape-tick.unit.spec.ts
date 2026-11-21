import type { EscapeTemplate, Hint } from './escape.types';
import type { RunClock, TeamRecord } from './escape-live.types';
import { adjustTime, newTeam, nextHint, submit, useHint } from './escape-rules';
import { allDone, dueHints, tickTeam } from './escape-tick';
import { tpl } from './fixtures';

const hint = (id: string, releaseAfterS: number | null): Hint => ({
  id,
  text: `text of ${id}`,
  penaltyS: 30,
  releaseAfterS,
});

/** `tpl` with the given hints on every stage (ids suffixed by stage index). */
function withHints(...hints: Hint[]): EscapeTemplate {
  return {
    ...tpl,
    stages: tpl.stages.map((s, i) => ({
      ...s,
      hints: hints.map((h) => ({ ...h, id: `${h.id}-${i}` })),
    })),
  };
}

const clock = (limitMs = 60_000): RunClock => ({
  startedAt: 1_000,
  pausedAt: 0,
  pausedMs: 0,
  endedElapsedMs: null,
  limitMs,
});

const rec = (t: EscapeTemplate = tpl): TeamRecord => ({
  team: newTeam(t, 'a', 'A', ['p1', 'p2']),
  lastProgressAt: 0,
  stuck: false,
  timedOut: false,
});

const STUCK = 300_000;

describe('dueHints', () => {
  it('releases nothing when releaseAfterS is null', () => {
    const t = withHints(hint('h', null));
    expect(dueHints(t, rec(t).team, 10_000_000)).toEqual([]);
  });

  it('releases the next hint once its time on stage has passed, and not before', () => {
    const t = withHints(hint('h', 60));
    const team = rec(t).team;
    expect(dueHints(t, team, 59_999)).toEqual([]);
    expect(dueHints(t, team, 60_000).map((h) => h.id)).toEqual(['h-0']);
  });

  it('counts time on the current stage, from when the previous one was cleared', () => {
    const t = withHints(hint('h', 60));
    const team = { ...rec(t).team, stageIndex: 1, stageClearedAt: [100_000] };
    expect(dueHints(t, team, 159_999)).toEqual([]);
    expect(dueHints(t, team, 160_000).map((h) => h.id)).toEqual(['h-1']);
  });

  it('gives two due hints in order', () => {
    const t = withHints(hint('h1', 30), hint('h2', 60));
    expect(dueHints(t, rec(t).team, 90_000).map((h) => h.id)).toEqual(['h1-0', 'h2-0']);
  });

  it('keeps the order: a timed hint behind an untimed next hint is not released', () => {
    const t = withHints(hint('h1', null), hint('h2', 10));
    expect(dueHints(t, rec(t).team, 10_000_000)).toEqual([]);
  });

  it('releases nothing for an escaped team', () => {
    const t = withHints(hint('h', 10));
    const team = { ...rec(t).team, escapedAt: 5_000 };
    expect(dueHints(t, team, 10_000_000)).toEqual([]);
  });
});

describe('tickTeam', () => {
  it('uses due hints for free, in order, and reports them', () => {
    const t = withHints(hint('h1', 30), hint('h2', 60));
    const out = tickTeam(t, rec(t), clock(10_000_000), 90_000, STUCK);
    expect(out.events).toEqual(['hint:h1-0', 'hint:h2-0']);
    expect(out.rec.team.hintsUsed).toEqual(['h1-0', 'h2-0']);
    expect(out.rec.team.paidHints).toEqual([]);
    expect(out.rec.team.hintPenaltyS).toBe(0);
    expect(nextHint(t, out.rec.team)).toBeNull();
  });

  it('does not release a timed hint twice', () => {
    const t = withHints(hint('h', 10));
    const once = tickTeam(t, rec(t), clock(10_000_000), 20_000, STUCK);
    expect(tickTeam(t, once.rec, clock(10_000_000), 21_000, STUCK).events).toEqual([]);
  });

  it('fires time-up once, when the team clock reaches the limit', () => {
    const r = rec();
    expect(tickTeam(tpl, r, clock(60_000), 59_999, STUCK).events).toEqual([]);
    const up = tickTeam(tpl, r, clock(60_000), 60_000, STUCK);
    expect(up.events).toEqual(['time-up']);
    expect(up.rec.timedOut).toBe(true);
    expect(tickTeam(tpl, up.rec, clock(60_000), 61_000, STUCK).events).toEqual([]);
  });

  it('uses the deadline: time the host added delays time-up', () => {
    const r = { ...rec(), team: adjustTime(rec().team, 30_000) };
    expect(tickTeam(tpl, r, clock(60_000), 60_000, STUCK).events).toEqual([]);
    expect(tickTeam(tpl, r, clock(60_000), 90_000, STUCK).events).toEqual(['time-up']);
  });

  it('releases no hint once timed out', () => {
    const t = withHints(hint('h', 10));
    const out = tickTeam(t, rec(t), clock(60_000), 60_000, STUCK);
    expect(out.events).toEqual(['time-up']);
    expect(out.rec.team.hintsUsed).toEqual([]);
  });

  it('clears timedOut when time was added', () => {
    const up = tickTeam(tpl, rec(), clock(60_000), 60_000, STUCK).rec;
    const more = { ...up, team: adjustTime(up.team, 60_000) };
    const out = tickTeam(tpl, more, clock(60_000), 61_000, STUCK);
    expect(out.rec.timedOut).toBe(false);
    expect(out.events).toEqual([]);
  });

  it('never times out an escaped team', () => {
    const r = { ...rec(), team: { ...rec().team, escapedAt: 50_000 } };
    expect(tickTeam(tpl, r, clock(60_000), 120_000, STUCK).events).toEqual([]);
  });

  it('flips stuck at stuckMs without progress, and unstuck after progress', () => {
    const r = rec();
    const c = clock(10_000_000);
    expect(tickTeam(tpl, r, c, 299_999, STUCK).events).toEqual([]);
    const stuck = tickTeam(tpl, r, c, 300_000, STUCK);
    expect(stuck.events).toEqual(['stuck']);
    expect(stuck.rec.stuck).toBe(true);
    expect(tickTeam(tpl, stuck.rec, c, 400_000, STUCK).events).toEqual([]);
    const { team } = submit(
      tpl,
      stuck.rec.team,
      { playerId: 'p1', lockId: 'safe', input: '1234' },
      400_000,
    );
    const progressed = { ...stuck.rec, team, lastProgressAt: 400_000 };
    const out = tickTeam(tpl, progressed, c, 401_000, STUCK);
    expect(out.events).toEqual(['unstuck']);
    expect(out.rec.stuck).toBe(false);
  });

  it('a hint is not progress', () => {
    const t = withHints(hint('h', null));
    const r = { ...rec(t), team: useHint(t, rec(t).team, 'h-0') };
    expect(tickTeam(t, r, clock(10_000_000), 300_000, STUCK).events).toEqual(['stuck']);
  });

  it('clears stuck when the team stops playing', () => {
    const r = { ...rec(), stuck: true, team: { ...rec().team, escapedAt: 10_000 } };
    const out = tickTeam(tpl, r, clock(10_000_000), 400_000, STUCK);
    expect(out.events).toEqual(['unstuck']);
    expect(out.rec.stuck).toBe(false);
  });

  it('does nothing while paused or after the end', () => {
    const t = withHints(hint('h', 10));
    const paused = { ...clock(60_000), pausedAt: 5_000 };
    const ended = { ...clock(60_000), endedElapsedMs: 70_000 };
    for (const c of [paused, ended]) {
      const r = rec(t);
      const out = tickTeam(t, r, c, 400_000, STUCK);
      expect(out.events).toEqual([]);
      expect(out.rec).toBe(r);
    }
  });
});

describe('allDone', () => {
  const c = clock(60_000);
  const escaped = { ...rec(), team: { ...rec().team, escapedAt: 10_000 } };
  const timedOut = { ...rec(), timedOut: true, team: adjustTime(rec().team, -40_000) };

  it('is true only when every team has escaped or timed out', () => {
    expect(allDone(c, [escaped, timedOut], 30_000)).toBe(true);
    expect(allDone(c, [escaped, rec()], 30_000)).toBe(false);
  });

  it('counts a team past its deadline as done before the tick marks it', () => {
    expect(allDone(c, [escaped, rec()], 60_000)).toBe(true);
  });

  it('trusts the deadline over a stale timedOut flag', () => {
    const more = { ...timedOut, team: adjustTime(timedOut.team, 60_000) };
    expect(allDone(c, [escaped, more], 30_000)).toBe(false);
  });

  it('is false without teams', () => {
    expect(allDone(c, [], 30_000)).toBe(false);
  });
});
