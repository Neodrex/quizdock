import {
  deadlineAt,
  endClock,
  isTimedOut,
  pauseClock,
  remainingMs,
  resumeClock,
  runElapsed,
  stageOpenedAt,
  teamClock,
} from './escape-clock';
import type { RunClock } from './escape-live.types';
import { newTeam } from './escape-rules';
import type { TeamState } from './escape.types';
import { tpl } from './fixtures';

const clock = (over: Partial<RunClock> = {}): RunClock => ({
  startedAt: 1_000,
  pausedAt: 0,
  pausedMs: 0,
  endedElapsedMs: null,
  limitMs: 60_000,
  ...over,
});
const team = (over: Partial<TeamState> = {}): TeamState => ({
  ...newTeam(tpl, 'A', 'Alpha', ['p1']),
  ...over,
});

describe('runElapsed', () => {
  it('is 0 before the start', () => {
    expect(runElapsed(clock({ startedAt: 0 }), 50_000)).toBe(0);
  });
  it('runs with now', () => {
    expect(runElapsed(clock(), 11_000)).toBe(10_000);
  });
  it('freezes at pausedAt', () => {
    const c = pauseClock(clock(), 6_000);
    expect(runElapsed(c, 6_000)).toBe(5_000);
    expect(runElapsed(c, 90_000)).toBe(5_000);
  });
  it('excludes a closed pause', () => {
    const c = resumeClock(pauseClock(clock(), 6_000), 16_000);
    expect(c).toMatchObject({ pausedAt: 0, pausedMs: 10_000 });
    expect(runElapsed(c, 21_000)).toBe(10_000);
  });
  it('freezes at endedElapsedMs', () => {
    const c = endClock(clock(), 31_000);
    expect(c.endedElapsedMs).toBe(30_000);
    expect(runElapsed(c, 99_000)).toBe(30_000);
    expect(endClock(c, 50_000)).toBe(c);
  });
  it('ends at the paused time when ended during a pause', () => {
    expect(endClock(pauseClock(clock(), 6_000), 40_000).endedElapsedMs).toBe(5_000);
  });
});

describe('pause and resume', () => {
  it('are idempotent', () => {
    const p = pauseClock(clock(), 6_000);
    expect(pauseClock(p, 8_000)).toBe(p);
    const r = resumeClock(p, 16_000);
    expect(resumeClock(r, 20_000)).toBe(r);
    const running = clock();
    expect(resumeClock(running, 5_000)).toBe(running);
  });
  it('pause does nothing before the start', () => {
    const c = clock({ startedAt: 0 });
    expect(pauseClock(c, 5_000)).toBe(c);
  });
});

describe('teamClock', () => {
  it('subtracts adjustMs', () => {
    expect(teamClock(team({ adjustMs: 3_000 }), 10_000)).toBe(7_000);
    expect(teamClock(team({ adjustMs: -3_000 }), 10_000)).toBe(13_000);
  });
  it('freezes at escapedAt', () => {
    expect(teamClock(team({ escapedAt: 4_000 }), 10_000)).toBe(4_000);
  });
});

describe('remainingMs and isTimedOut', () => {
  it('extra time extends the deadline', () => {
    expect(remainingMs(clock(), team(), 50_000)).toBe(10_000);
    expect(remainingMs(clock(), team({ adjustMs: 5_000 }), 50_000)).toBe(15_000);
  });
  it('never goes below 0', () => {
    expect(remainingMs(clock(), team(), 90_000)).toBe(0);
  });
  it('times out at the limit, shifted by adjustMs', () => {
    expect(isTimedOut(clock(), team(), 59_999)).toBe(false);
    expect(isTimedOut(clock(), team(), 60_000)).toBe(true);
    expect(isTimedOut(clock(), team({ adjustMs: 1_000 }), 60_000)).toBe(false);
  });
  it('is false for an escaped team', () => {
    expect(isTimedOut(clock(), team({ escapedAt: 59_000 }), 90_000)).toBe(false);
  });
});

describe('deadlineAt', () => {
  it('is now + remaining while running', () => {
    expect(deadlineAt(clock(), team(), 11_000)).toBe(11_000 + 50_000);
    expect(deadlineAt(clock(), team({ adjustMs: 2_000 }), 11_000)).toBe(11_000 + 52_000);
  });
  it('is null before the start, paused, ended, escaped or timed out', () => {
    expect(deadlineAt(clock({ startedAt: 0 }), team(), 11_000)).toBeNull();
    expect(deadlineAt(pauseClock(clock(), 5_000), team(), 11_000)).toBeNull();
    expect(deadlineAt(endClock(clock(), 5_000), team(), 11_000)).toBeNull();
    expect(deadlineAt(clock(), team({ escapedAt: 3_000 }), 11_000)).toBeNull();
    expect(deadlineAt(clock(), team(), 61_000)).toBeNull();
  });
});

describe('stageOpenedAt', () => {
  it('is 0 on stage 0 and the previous clear after', () => {
    expect(stageOpenedAt(team())).toBe(0);
    expect(stageOpenedAt(team({ stageIndex: 1, stageClearedAt: [12_000] }))).toBe(12_000);
    expect(stageOpenedAt(team({ stageIndex: 2, stageClearedAt: [12_000, 30_000] }))).toBe(30_000);
  });
});
