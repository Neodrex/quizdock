import type { EscapeScreenFinale } from '@quiz-dock/contracts';
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MotionLevel } from '../../motion/level';
import { drawEn } from '../test-fixtures';
import { REPLAY_MS } from './replay-timeline';
import { ScreenFinale } from './screen-finale';
import { screenFinaleOf } from './screen-fixtures';
import type { EscapeScreenUi } from './screen-reducer';

const motion = vi.hoisted(() => ({ level: 'full' as MotionLevel }));
vi.mock('../../motion/level', () => ({ useMotionLevel: () => motion.level }));

const base = screenFinaleOf();
type Ranked = EscapeScreenFinale['ranking'][number];
const team = (i: number, over: Partial<Ranked> = {}): Ranked => ({
  ...base.ranking[0],
  teamId: `t${i}`,
  name: `Team ${i}`,
  place: i,
  scoreMs: 1_900_000 + i * 4000,
  members: [`Nick${i}a`, `Nick${i}b`],
  ...over,
});
/** Five teams: Red and Blue first, 4 s apart; the extra time and host unlocks a host
 *  sees ride along as if a server leaked them, to prove the screen draws none. */
const five = screenFinaleOf({
  ranking: [
    { ...base.ranking[0] },
    team(2, { name: 'Team Blue', teamId: 't2', scoreMs: 1_936_000, hintPenaltyS: 0 }),
    team(3, { hintsUsed: 0, hintPenaltyS: 0 }),
    team(4, { escaped: false, timedOut: true, scoreMs: null, stagesCleared: 2 }),
    team(5, { members: ['Eve', 'Finn', 'Gus', 'Hal', 'Ivy', 'Jo'] }),
  ].map((r) => ({ ...r, adjustMs: 183_000, hostUnlocks: 4 }) as Ranked),
  awards: { fastest: 't1', fewestHints: 't3', teamwork: 't2', photoFinish: ['t1', 't2'] },
});

const draw = (
  finale: EscapeScreenFinale,
  replay: EscapeScreenUi['replay'] = 'done',
  closed = false,
  onReplayDone = () => undefined,
) =>
  drawEn(
    <ScreenFinale finale={finale} replay={replay} closed={closed} onReplayDone={onReplayDone} />,
  );

beforeEach(() => {
  motion.level = 'full';
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
});
afterEach(() => vi.useRealTimers());

describe('ScreenFinale', () => {
  it('first the closing text and the replay, then the results', () => {
    const onDone = vi.fn();
    draw(five, 'pending', false, onDone);
    expect(screen.getByText('The vault is open.')).toBeInTheDocument();
    expect(screen.getByTestId('split-replay')).toBeInTheDocument();
    expect(screen.queryByTestId('podium')).toBeNull();
    act(() => void vi.advanceTimersByTime(REPLAY_MS + 100));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a reload with the replay done shows the podium at once', () => {
    draw(five);
    expect(screen.queryByTestId('split-replay')).toBeNull();
    expect(screen.getByText('The vault is open.')).toBeInTheDocument();
    const steps = within(screen.getByTestId('podium')).getAllByTestId('podium-step');
    expect(steps.map((s) => s.dataset.place)).toEqual(['1', '2', '3']);
  });

  it('two teams: #1 comes first in the page (read first), drawn on the right', () => {
    draw(screenFinaleOf());
    const steps = within(screen.getByTestId('podium')).getAllByTestId('podium-step');
    expect(steps.map((s) => s.dataset.place)).toEqual(['1', '2']);
    expect(steps[0].className).toContain('order-2');
    expect(steps[1].className).toContain('order-1');
  });

  it('three teams or fewer: a bigger podium, centred in the room left', () => {
    const { unmount } = draw(screenFinaleOf());
    const podium = screen.getByTestId('podium');
    expect(podium.style.fontSize).toBe('1.5em');
    expect(screen.getByTestId('finale-results').className).toContain('justify-center');
    unmount();
    draw(five);
    expect(screen.getByTestId('podium').style.fontSize).toBe('');
  });

  it('the podium: place, score, escape time, hints, penalty and members', () => {
    draw(five);
    const [red, blue] = screen.getAllByTestId('podium-step');
    expect(within(red).getByText('Place 1')).toHaveClass('sr-only');
    expect(red).toHaveTextContent('Team Red');
    expect(red).toHaveTextContent('32:12');
    expect(red).toHaveTextContent('Escaped in 31:12');
    expect(red).toHaveTextContent('2 hints');
    expect(red).toHaveTextContent('+1:00 penalty');
    expect(within(red).getByTestId('members')).toHaveTextContent('Ana, Ben');
    expect(blue).not.toHaveTextContent('penalty');
  });

  it('the others in a ranked list, members on one line cut with an ellipsis', () => {
    draw(five);
    const rows = screen.getAllByTestId('ranked-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Team 4');
    expect(rows[0]).toHaveTextContent('Time up');
    expect(rows[0]).toHaveTextContent('Stages: 2');
    const members = within(rows[1]).getByTestId('members');
    expect(members).toHaveTextContent('Eve, Finn, Gus, Hal, Ivy, Jo');
    expect(members).toHaveClass('truncate');
  });

  it('the awards earned, each with its team; the photo finish with the gap', () => {
    draw(five);
    const awards = (k: string) => document.querySelector(`[data-award="${k}"]`);
    expect(awards('fastest')).toHaveTextContent('Fastest: Team Red');
    expect(awards('fewestHints')).toHaveTextContent('Fewest hints: Team 3');
    expect(awards('teamwork')).toHaveTextContent('Best teamwork: Team Blue');
    expect(awards('photoFinish')).toHaveTextContent(
      'Photo finish: Team Red and Team Blue, 4 s apart',
    );
  });

  it('only the awards earned', () => {
    draw(
      screenFinaleOf({
        awards: { fastest: 't1', fewestHints: null, teamwork: null, photoFinish: null },
      }),
    );
    expect(document.querySelectorAll('[data-award]')).toHaveLength(1);
  });

  it('never draws extra time or host unlocks', () => {
    draw(five);
    const text = screen.getByTestId('screen-finale').textContent ?? '';
    expect(text).not.toContain(':03'); // 183_000 ms is 3:03
    expect(text).not.toMatch(/\b4 unlock|host/i);
  });

  it('closed: "Thanks for playing" under the results', () => {
    const { unmount } = draw(five);
    expect(screen.queryByText('Thanks for playing')).toBeNull();
    unmount();
    draw(five, 'done', true);
    expect(screen.getByText('Thanks for playing')).toBeInTheDocument();
  });

  it('tied places (1, 1, 3): each podium step keeps a spot of its own, both winners raised', () => {
    const tied = screenFinaleOf({
      ranking: [
        team(1, { name: 'Team Red', teamId: 't1', place: 1 }),
        team(2, { place: 1 }),
        team(3),
      ],
    });
    draw(tied);
    const steps = screen.getAllByTestId('podium-step');
    expect(steps.map((s) => s.dataset.place)).toEqual(['1', '1', '3']);
    const orders = steps.map((s) => s.className.match(/order-\d/)?.[0]);
    expect(new Set(orders).size).toBe(3);
    expect(steps[0].className).toContain('border-primary');
    expect(steps[1].className).toContain('border-primary');
    expect(steps[2].className).not.toContain('border-primary');
  });

  it('the winner stands highest even when a step below carries more lines (a penalty)', () => {
    // Raised by its own padding, a winner was drawn lower than a second place whose card
    // had one line more: the others step down instead, on steps stretched to one height.
    const lined = screenFinaleOf({
      ranking: [
        team(1, { teamId: 't1', name: 'Team Red', hintPenaltyS: 0 }),
        team(2, { hintPenaltyS: 30 }),
        team(3, { hintPenaltyS: 60 }),
      ],
    });
    draw(lined);
    expect(screen.getByTestId('podium').className).toContain('items-stretch');
    const [first, second, third] = screen.getAllByTestId('podium-step');
    expect(first.className).not.toMatch(/\bmt-/);
    expect(second.className).toContain('mt-[1.5em]');
    expect(third.className).toContain('mt-[1.5em]');
  });

  it('a photo finish under a second shows tenths, never "0 s"', () => {
    const close = screenFinaleOf({
      ranking: [team(1, { teamId: 't1', name: 'Team Red' }), team(2, { scoreMs: 1_904_300 })],
      awards: { fastest: null, fewestHints: null, teamwork: null, photoFinish: ['t1', 't2'] },
    });
    draw(close);
    expect(document.querySelector('[data-award="photoFinish"]')).toHaveTextContent(
      'Photo finish: Team Red and Team 2, 0.3 s apart',
    );
  });

  it('the penalty reads in the card’s colour (contrast): red is the icon’s only', () => {
    draw(five);
    const [red] = screen.getAllByTestId('podium-step');
    const penalty = within(red).getByText('+1:00 penalty');
    expect(penalty.className).not.toContain('text-destructive');
  });
});
