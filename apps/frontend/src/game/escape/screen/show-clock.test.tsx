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

  it.each([
    ['full', true],
    ['fade', false],
    ['none', false],
  ] as const)('motion %s pulses once a second in the final minutes: %s', (level, pulse) => {
    motion.level = level;
    drawEn(<ShowClock board={running(4 * MIN)} now={NOW} />);
    expect(digits().className.includes('animate-[pulse_1s')).toBe(pulse);
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
