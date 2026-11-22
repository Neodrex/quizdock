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
});
