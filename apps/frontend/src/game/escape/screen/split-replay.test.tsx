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
    expect(rows[0]).toHaveTextContent('Team Red');
    expect(rows[0]).toHaveTextContent('Team Blue');
    expect(within(rows[1]).getByRole('rowheader')).toHaveTextContent('The Lobby');
    expect(rows[1]).toHaveTextContent('4:12');
    expect(rows[1]).toHaveTextContent('5:00');
    expect(rows[3]).toHaveTextContent('31:12');
    expect(within(rows[3]).getByText('Not cleared')).toHaveClass('sr-only');
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
});
