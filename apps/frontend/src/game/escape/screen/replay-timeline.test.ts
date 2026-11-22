import { describe, expect, it } from 'vitest';
import {
  frameAt,
  maxTOf,
  MIN_REPLAY_MS,
  REPLAY_MS,
  replayMsOf,
  runTimeAt,
  splitTableOf,
} from './replay-timeline';
import { screenFinaleOf } from './screen-fixtures';

// Red escaped at 31:12 (clears 4:12, 15:00, 31:12) with a 1:00 penalty; Blue timed out
// after stage 1 (5:00). The run's limit: 40 min.
const finale = screenFinaleOf();
const red = (t: number) => frameAt(finale, t).teams[0];
const blue = (t: number) => frameAt(finale, t).teams[1];

describe('replay timeline', () => {
  it('slides each team linearly between its clears', () => {
    expect(red(0).position).toBe(0);
    expect(red(126_000).position).toBeCloseTo(0.5);
    expect(red(252_000).position).toBe(1);
    expect(red(576_000).position).toBeCloseTo(1.5);
    expect(blue(150_000).position).toBeCloseTo(0.5);
  });

  it('positions never go back', () => {
    const maxT = maxTOf(finale);
    for (const i of [0, 1]) {
      let last = -1;
      for (let t = 0; t <= maxT; t += 7_000) {
        const p = frameAt(finale, t).teams[i].position;
        expect(p).toBeGreaterThanOrEqual(last);
        last = p;
      }
    }
  });

  it('maps the run onto REPLAY_MS, never under 8 s', () => {
    expect(replayMsOf(finale)).toBe(REPLAY_MS);
    expect(runTimeAt(finale, REPLAY_MS / 2)).toBe(maxTOf(finale) / 2);
    expect(runTimeAt(finale, REPLAY_MS * 2)).toBe(maxTOf(finale));
    const short = screenFinaleOf({
      limitMs: 60_000,
      ranking: [{ ...finale.ranking[0], stageClearedAt: [1000, 2000, 3000], timedOut: false }],
    });
    expect(replayMsOf(short)).toBe(MIN_REPLAY_MS);
  });

  it('ends at the limit when a team timed out, later when extra time was given', () => {
    expect(maxTOf(finale)).toBe(finale.limitMs);
    const late = screenFinaleOf({
      ranking: [
        { ...finale.ranking[0], stageClearedAt: [252_000, 900_000, 2_500_000] },
        finale.ranking[1],
      ],
    });
    expect(maxTOf(late)).toBe(2_500_000);
    expect(frameAt(late, 2_450_000).teams[0].finished).toBe(false);
    expect(frameAt(late, 2_500_000).teams[0].finished).toBe(true);
  });

  it('an escaped team finishes at its escape time, then shows its score with the penalty', () => {
    expect(red(1_871_000)).toMatchObject({ finished: false, timeMs: 1_871_000 });
    expect(red(1_872_000)).toMatchObject({ finished: true, position: 3, timeMs: 1_932_000 });
  });

  it('a timed-out team stops at the stage it reached, and its time runs out', () => {
    expect(blue(1_000_000)).toMatchObject({ position: 1, timeUp: false });
    expect(blue(finale.limitMs)).toMatchObject({ position: 1, timeUp: true });
  });

  it('the penalty may swap places; the last frame is the ranking', () => {
    // Blue escapes first (20:00) with a 15:00 penalty; Red later (25:00), no penalty.
    const swap = screenFinaleOf({
      ranking: [
        {
          ...finale.ranking[0],
          stageClearedAt: [300_000, 600_000, 1_500_000],
          hintPenaltyS: 0,
          scoreMs: 1_500_000,
        },
        {
          ...finale.ranking[0],
          teamId: 't2',
          name: 'Team Blue',
          place: 2,
          stageClearedAt: [200_000, 400_000, 1_200_000],
          hintPenaltyS: 900,
          scoreMs: 2_100_000,
        },
      ],
    });
    const at = (t: number) => frameAt(swap, t).teams.map((x) => x.place);
    expect(at(1_000_000)).toEqual([2, 1]);
    expect(at(1_300_000)).toEqual([2, 1]);
    expect(at(1_500_000)).toEqual([1, 2]);
    const last = frameAt(swap, maxTOf(swap));
    expect(last.teams.map((x) => x.place)).toEqual(swap.ranking.map((r) => r.place));
    expect(frameAt(finale, maxTOf(finale)).teams.map((x) => x.place)).toEqual([1, 2]);
  });

  it('nobody cleared anything: a still frame and the ranking', () => {
    const none = screenFinaleOf({
      ranking: finale.ranking.map((r) => ({
        ...r,
        escaped: false,
        timedOut: true,
        scoreMs: null,
        stagesCleared: 0,
        stageClearedAt: [],
      })),
    });
    expect(maxTOf(none)).toBe(0);
    expect(replayMsOf(none)).toBe(0);
    const f = frameAt(none, 0);
    expect(f.teams.map((x) => [x.position, x.place, x.timeUp])).toEqual([
      [0, 1, true],
      [0, 2, true],
    ]);
  });

  it('the split table: per stage, each team’s clear or null', () => {
    expect(splitTableOf(finale)).toEqual([
      [252_000, 300_000],
      [900_000, null],
      [1_872_000, null],
    ]);
  });
});
