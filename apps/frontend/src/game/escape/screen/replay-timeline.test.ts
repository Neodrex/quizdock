import { describe, expect, it } from 'vitest';
import {
  frameAt,
  maxTOf,
  MIN_REPLAY_MS,
  REPLAY_MS,
  replayMsOf,
  replayTeamsOf,
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

  describe("ends at the run's real end when the finale carries it", () => {
    const red = finale.ranking[0];
    const blue = finale.ranking[1];
    it('every team escaped: at the last escape', () => {
      const all = screenFinaleOf({
        endedMs: 1_872_100,
        ranking: [
          red,
          { ...blue, escaped: true, timedOut: false, stageClearedAt: [300_000, 600_000, 900_000] },
        ],
      });
      expect(maxTOf(all)).toBe(1_872_000);
    });

    it('a team timed out after the host took time: at the deadline it hit, not the limit', () => {
      const cut = screenFinaleOf({
        endedMs: 600_000,
        ranking: [{ ...red, stageClearedAt: [100_000, 200_000, 400_000] }, blue],
      });
      expect(maxTOf(cut)).toBe(600_000);
      expect(replayMsOf(cut)).toBe(REPLAY_MS);
      expect(frameAt(cut, 590_000).teams[1].timeUp).toBe(false);
      expect(frameAt(cut, 600_000).teams[1]).toMatchObject({ position: 1, timeUp: true });
    });

    it('extra time: later than the limit still fits', () => {
      const late = screenFinaleOf({
        endedMs: 2_700_000,
        ranking: [{ ...red, stageClearedAt: [252_000, 900_000, 2_650_000] }, blue],
      });
      expect(maxTOf(late)).toBe(2_700_000);
      expect(frameAt(late, 2_650_000).teams[0].finished).toBe(true);
    });
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

  it('the split table: per team, each stage’s clear or null', () => {
    expect(splitTableOf(finale)).toEqual([
      [252_000, 900_000, 1_872_000],
      [300_000, null, null],
    ]);
  });

  it('lanes in team order, not the ranking: the order gives nothing away', () => {
    const [r1, r2] = finale.ranking;
    const flipped = screenFinaleOf({
      ranking: [
        { ...r2, teamId: 't10', place: 1 },
        { ...r1, teamId: 't2', place: 2 },
      ],
    });
    expect(frameAt(flipped, 0).teams.map((x) => x.teamId)).toEqual(['t2', 't10']);
    expect(frameAt(flipped, maxTOf(flipped)).teams.map((x) => x.place)).toEqual([2, 1]);
    expect(splitTableOf(flipped).map((row) => row[0])).toEqual([
      r1.stageClearedAt[0],
      r2.stageClearedAt[0],
    ]);
  });

  it('teams level share a place, while playing and at the end (1, 1, 3)', () => {
    const r = finale.ranking[0];
    const tied = screenFinaleOf({
      ranking: [
        { ...r, teamId: 't1', place: 1 },
        { ...r, teamId: 't2', name: 'Team Blue', place: 1 },
        {
          ...r,
          teamId: 't3',
          name: 'Team Green',
          place: 3,
          scoreMs: 2_000_000,
          stageClearedAt: [300_000, 950_000, 1_940_000],
        },
      ],
    });
    expect(frameAt(tied, 500_000).teams.map((x) => x.place)).toEqual([1, 1, 3]);
    expect(frameAt(tied, maxTOf(tied)).teams.map((x) => x.place)).toEqual([1, 1, 3]);
  });

  it('never scrolls: one column to 5, up to 4 of 8 rows to 30, then the top 12 counted', () => {
    const many = (n: number) =>
      screenFinaleOf({
        ranking: Array.from({ length: n }, (_, i) => ({
          ...finale.ranking[0],
          teamId: `t${n - i}`,
          name: `Team ${n - i}`,
          place: i + 1,
        })),
      });
    expect(replayTeamsOf(many(5))).toMatchObject({ columns: 1, more: 0 });
    expect(replayTeamsOf(many(6))).toMatchObject({ columns: 2, more: 0 });
    expect(replayTeamsOf(many(16))).toMatchObject({ columns: 2, more: 0 });
    expect(replayTeamsOf(many(17))).toMatchObject({ columns: 3, more: 0 });
    expect(replayTeamsOf(many(30))).toMatchObject({ columns: 4, more: 0 });
    expect(replayTeamsOf(many(30)).teams).toHaveLength(30);
    const big = replayTeamsOf(many(31));
    expect(big).toMatchObject({ columns: 2, more: 19 });
    // The top 12 by place (t31 … t20), shown in team order.
    expect(big.teams.map((r) => r.teamId)).toEqual(
      Array.from({ length: 12 }, (_, i) => `t${20 + i}`),
    );
  });
});
