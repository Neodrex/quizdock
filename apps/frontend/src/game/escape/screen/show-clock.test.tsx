import type { EscapeBoard } from '@quiz-dock/contracts';
import { screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionLevel } from '../../motion/level';
import { drawEn, en } from '../test-fixtures';
import { boardOf, summaryOf } from './screen-fixtures';
import { ShowClock } from './show-clock';

const motion = vi.hoisted(() => ({ level: 'full' as MotionLevel }));
vi.mock('../../motion/level', () => ({ useMotionLevel: () => motion.level }));

const NOW = 1_000_000_000;
const MIN = 60_000;

/** Two teams; the run ends at the later deadline, `left` ms after NOW. */
const running = (left: number, over: Partial<EscapeBoard> = {}) =>
  boardOf({
    clock: { serverNow: NOW, paused: false, elapsedMs: 0, limitMs: 45 * MIN },
    teams: [
      summaryOf({ remainingMs: left - MIN, deadlineAt: NOW + left - MIN }),
      summaryOf({ id: 't2', name: 'Team Blue', remainingMs: left, deadlineAt: NOW + left }),
    ],
    ...over,
  });

const el = (board: EscapeBoard, now = NOW) => (
  <I18nextProvider i18n={en}>
    <ShowClock board={board} now={now} />
  </I18nextProvider>
);
const digits = () => screen.getByTestId('show-clock-digits');

beforeEach(() => {
  motion.level = 'full';
});

describe('ShowClock', () => {
  it('shows the time left to the latest deadline, and moves with now', () => {
    const board = running(20 * MIN);
    const { rerender } = drawEn(<ShowClock board={board} now={NOW} />);
    expect(digits()).toHaveTextContent('20:00');
    rerender(el(board, NOW + 61_000));
    expect(digits()).toHaveTextContent('18:59');
    expect(screen.getByRole('timer')).toHaveAttribute('data-final', 'false');
    expect(digits().className).toContain('text-[4em]');
  });

  it('in the final minutes grows, takes the warning colour and says so', () => {
    drawEn(<ShowClock board={running(4 * MIN)} now={NOW} />);
    const timer = screen.getByRole('timer');
    expect(timer).toHaveAttribute('data-final', 'true');
    expect(digits().className).toContain('text-[8em]');
    expect(digits().className).toContain('text-destructive');
    expect(screen.getByText('Final minutes')).toBeInTheDocument();
  });

  it('is not in the final minutes at 4 min of a 20-min run (3 min there)', () => {
    const board = running(4 * MIN);
    drawEn(
      <ShowClock board={{ ...board, clock: { ...board.clock, limitMs: 20 * MIN } }} now={NOW} />,
    );
    expect(screen.getByRole('timer')).toHaveAttribute('data-final', 'false');
    expect(screen.queryByText('Final minutes')).toBeNull();
  });

  const finalAt = (left: number, limitMs: number) => {
    const board = running(left);
    drawEn(<ShowClock board={{ ...board, clock: { ...board.clock, limitMs } }} now={NOW} />);
    return screen.getByRole('timer').getAttribute('data-final');
  };

  it.each([
    ['exactly 5:00 left of a 45-min run', 5 * MIN, 45 * MIN, 'true'],
    ['5:01 left of a 45-min run', 5 * MIN + 1000, 45 * MIN, 'false'],
    ['5:00 left of a 30:00 run (5-min threshold)', 5 * MIN, 30 * MIN, 'true'],
    ['5:01 left of a 30:00 run', 5 * MIN + 1000, 30 * MIN, 'false'],
    ['5:00 left of a 29:59 run (3-min threshold)', 5 * MIN, 30 * MIN - 1000, 'false'],
    ['exactly 3:00 left of a 29:59 run', 3 * MIN, 30 * MIN - 1000, 'true'],
    ['3:01 left of a 29:59 run', 3 * MIN + 1000, 30 * MIN - 1000, 'false'],
  ])('final minutes at %s: %s', (_, left, limit, final) => {
    expect(finalAt(left, limit)).toBe(final);
  });

  it('switches to whole seconds at 10 000 ms, not at 10 001', () => {
    const { unmount } = drawEn(<ShowClock board={running(10_000)} now={NOW} />);
    expect(digits()).toHaveTextContent(/^10$/);
    unmount();
    drawEn(<ShowClock board={running(10_001)} now={NOW} />);
    expect(digits()).toHaveTextContent(/^0:11$/);
  });

  it.each([
    ['full', true],
    ['fade', false],
    ['none', false],
  ] as const)('motion %s pulses once a second in the final minutes: %s', (level, pulse) => {
    motion.level = level;
    drawEn(<ShowClock board={running(4 * MIN)} now={NOW} />);
    expect(digits().dataset.pulse === 'scale').toBe(pulse);
  });

  it('shows whole seconds only over the last 10 s', () => {
    drawEn(<ShowClock board={running(9_000)} now={NOW} />);
    expect(digits()).toHaveTextContent(/^9$/);
  });

  it('paused: a "Paused" badge and frozen digits', () => {
    const board = running(20 * MIN);
    const paused = { ...board, clock: { ...board.clock, paused: true } };
    const { rerender } = drawEn(<ShowClock board={paused} now={NOW} />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(digits()).toHaveTextContent('20:00');
    rerender(el(paused, NOW + 5 * MIN));
    expect(digits()).toHaveTextContent('20:00');
  });

  it('every team done: "Every team is out", and the clock stops', () => {
    const board = running(20 * MIN);
    const done = {
      ...board,
      teams: [
        { ...board.teams[0], escaped: true, escapedAtMs: 10 * MIN },
        { ...board.teams[1], timedOut: true },
      ],
    };
    const { rerender } = drawEn(<ShowClock board={done} now={NOW} />);
    expect(screen.getByText('Every team is out')).toBeInTheDocument();
    const before = digits().textContent;
    rerender(el(done, NOW + 5 * MIN));
    expect(digits().textContent).toBe(before);
    expect(screen.getByRole('timer')).toHaveAttribute('data-final', 'false');
  });

  it('a race whose listed leaders are out while others play: the clock runs on, not "Every team is out"', () => {
    const board = running(20 * MIN);
    const race = {
      ...board,
      teams: board.teams.map((tm) => ({ ...tm, escaped: true, escapedAtMs: 10 * MIN })),
      session: {
        type: 'race' as const,
        startsAt: null,
        totals: {
          teams: 40,
          players: 40,
          escaped: 30,
          playing: 10,
          latest: { remainingMs: 20 * MIN, deadlineAt: NOW + 20 * MIN },
        },
      },
    };
    const { rerender } = drawEn(<ShowClock board={race} now={NOW} />);
    expect(screen.queryByText('Every team is out')).toBeNull();
    expect(digits()).toHaveTextContent('20:00');
    rerender(el(race, NOW + 5 * MIN));
    expect(digits()).toHaveTextContent('15:00');
  });

  it('labels the time for a screen reader once a minute', () => {
    const board = running(20 * MIN + 30_000);
    const { rerender } = drawEn(<ShowClock board={board} now={NOW} />);
    expect(screen.getByRole('timer')).toHaveAccessibleName('Time left: 20 minutes 30 seconds');
    rerender(el(board, NOW + 2_000));
    expect(screen.getByRole('timer')).toHaveAccessibleName('Time left: 20 minutes 30 seconds');
    rerender(el(board, NOW + 31_000));
    expect(screen.getByRole('timer')).toHaveAccessibleName('Time left: 19 minutes 59 seconds');
  });

  it('draws nothing before the run', () => {
    const { container } = drawEn(<ShowClock board={boardOf({ phase: 'forming' })} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });
});
