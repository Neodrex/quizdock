import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionLevel } from '../../motion/level';
import { drawEn } from '../test-fixtures';
import { REPLAY_MS } from './replay-timeline';
import { screenFinaleOf } from './screen-fixtures';
import { SplitReplay } from './split-replay';

const motion = vi.hoisted(() => ({ level: 'full' as MotionLevel }));
vi.mock('../../motion/level', () => ({ useMotionLevel: () => motion.level }));

const finale = screenFinaleOf();
/** `n` teams, t1…tn, ranked in reverse team order. */
const many = (n: number) =>
  screenFinaleOf({
    ranking: Array.from({ length: n }, (_, i) => ({
      ...finale.ranking[0],
      teamId: `t${n - i}`,
      name: `Team ${n - i}`,
      place: i + 1,
    })),
  });
const lane = (team: string) =>
  screen.getAllByTestId('replay-lane').find((l) => l.dataset.team === team)!;

beforeEach(() => {
  motion.level = 'full';
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
});
afterEach(() => vi.useRealTimers());

describe('SplitReplay', () => {
  it('plays once on animation frames, then calls onDone', () => {
    const onDone = vi.fn();
    drawEn(<SplitReplay finale={finale} onDone={onDone} />);
    expect(screen.getByTestId('replay-clock')).toHaveTextContent('0:00');
    act(() => void vi.advanceTimersByTime(REPLAY_MS / 2));
    expect(screen.getByTestId('replay-clock')).toHaveTextContent(/^(19|20):\d\d$/);
    expect(onDone).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(REPLAY_MS / 2 + 100));
    expect(onDone).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(REPLAY_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('ends on the ranking: penalty and score for the escaped team, "Time up" for the other', () => {
    drawEn(<SplitReplay finale={finale} onDone={() => undefined} />);
    act(() => void vi.advanceTimersByTime(REPLAY_MS + 100));
    const red = lane('t1');
    expect(red).toHaveAttribute('data-finished', 'true');
    expect(within(red).getByTestId('replay-penalty')).toHaveTextContent('+1:00');
    expect(within(red).getByText('Hint penalty: 1:00')).toHaveClass('sr-only');
    expect(red).toHaveTextContent('32:12');
    expect(within(red).getByText('Place 1')).toBeInTheDocument();
    const blue = lane('t2');
    expect(blue).toHaveAttribute('data-time-up', 'true');
    expect(blue).toHaveTextContent('Time up');
  });

  it('shows no Skip: nothing is clicked on a TV', () => {
    drawEn(<SplitReplay finale={finale} onDone={() => undefined} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each(['fade', 'none'] as const)('motion %s: the split table instead, then onDone', (lvl) => {
    motion.level = lvl;
    const onDone = vi.fn();
    drawEn(<SplitReplay finale={finale} onDone={onDone} />);
    expect(screen.queryByTestId('split-replay')).toBeNull();
    const table = screen.getByRole('table', { name: 'Split times by stage' });
    const rows = within(table).getAllByRole('row');
    // A row per team, a column per stage.
    expect(rows[0]).toHaveTextContent('Team');
    expect(rows[0]).toHaveTextContent('The Lobby');
    expect(within(rows[1]).getByRole('rowheader')).toHaveTextContent('Team Red');
    expect(rows[1]).toHaveTextContent('4:12');
    expect(rows[1]).toHaveTextContent('31:12');
    expect(within(rows[2]).getByRole('rowheader')).toHaveTextContent('Team Blue');
    expect(rows[2]).toHaveTextContent('5:00');
    expect(within(rows[2]).getAllByText('Not cleared')[0]).toHaveClass('sr-only');
    act(() => void vi.advanceTimersByTime(REPLAY_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('nobody cleared anything: a still frame, done at once', () => {
    const none = screenFinaleOf({
      ranking: finale.ranking.map((r) => ({ ...r, stageClearedAt: [], escaped: false })),
    });
    const onDone = vi.fn();
    drawEn(<SplitReplay finale={none} onDone={onDone} />);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a finale pushed again replays from the start, and calls onDone again', () => {
    const onDone = vi.fn();
    const { rerender } = drawEn(<SplitReplay finale={finale} onDone={onDone} />);
    act(() => void vi.advanceTimersByTime(REPLAY_MS + 100));
    expect(onDone).toHaveBeenCalledTimes(1);
    rerender(<SplitReplay finale={screenFinaleOf()} onDone={onDone} />);
    expect(screen.getByTestId('replay-clock')).toHaveTextContent('0:00');
    act(() => void vi.advanceTimersByTime(REPLAY_MS + 100));
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  it('lanes in team order, whatever the ranking', () => {
    drawEn(<SplitReplay finale={many(4)} onDone={() => undefined} />);
    expect(screen.getAllByTestId('replay-lane').map((l) => l.dataset.team)).toEqual([
      't1',
      't2',
      't3',
      't4',
    ]);
  });

  it('6 to 30 teams: up to 4 compact columns of 8 rows, every team shown', () => {
    const { unmount } = drawEn(<SplitReplay finale={many(13)} onDone={() => undefined} />);
    expect(screen.getByTestId('replay-lanes')).toHaveAttribute('data-columns', '2');
    expect(screen.getByTestId('replay-lanes').style.gridTemplateRows).toBe(
      'repeat(7, minmax(0, 1fr))',
    );
    expect(screen.getAllByTestId('replay-lane')).toHaveLength(13);
    unmount();
    drawEn(<SplitReplay finale={many(30)} onDone={() => undefined} />);
    expect(screen.getByTestId('replay-lanes')).toHaveAttribute('data-columns', '4');
    expect(screen.getAllByTestId('replay-lane')).toHaveLength(30);
    expect(screen.queryByTestId('replay-more')).toBeNull();
  });

  it('above 30: the top 12 and how many more', () => {
    drawEn(<SplitReplay finale={many(31)} onDone={() => undefined} />);
    expect(screen.getAllByTestId('replay-lane')).toHaveLength(12);
    expect(screen.getByTestId('replay-more')).toHaveTextContent('and 19 more teams');
  });

  it('the table follows the same rule', () => {
    motion.level = 'fade';
    const { unmount } = drawEn(<SplitReplay finale={many(13)} onDone={() => undefined} />);
    const tables = screen.getAllByTestId('split-table');
    expect(tables).toHaveLength(2);
    const teams = tables.map((tb) => within(tb).getAllByRole('rowheader').length);
    expect(teams).toEqual([7, 6]);
    unmount();
    drawEn(<SplitReplay finale={many(31)} onDone={() => undefined} />);
    const top = screen.getAllByTestId('split-table');
    expect(top.flatMap((tb) => within(tb).getAllByRole('rowheader'))).toHaveLength(12);
    expect(screen.getByTestId('replay-more')).toHaveTextContent('and 19 more teams');
  });

  it('the penalty reads in the card’s colour: red is the icon’s only', () => {
    drawEn(<SplitReplay finale={finale} onDone={() => undefined} />);
    act(() => void vi.advanceTimersByTime(REPLAY_MS + 100));
    const penalty = screen.getByTestId('replay-penalty');
    expect(penalty.className).not.toContain('text-destructive');
    expect(penalty.querySelector('svg')?.getAttribute('class')).toContain('text-destructive');
  });

  it('dense lanes (3–4 columns) keep the penalty in sight', () => {
    drawEn(<SplitReplay finale={many(30)} onDone={() => undefined} />);
    act(() => void vi.advanceTimersByTime(REPLAY_MS + 100));
    expect(screen.getByTestId('replay-lanes')).toHaveAttribute('data-columns', '4');
    const penalty = screen.getAllByTestId('replay-penalty')[0];
    const seen = within(penalty).getByText('+1:00');
    expect(seen.closest('.sr-only')).toBeNull();
  });
});
