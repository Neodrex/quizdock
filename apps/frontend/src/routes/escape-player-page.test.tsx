import type { EscapeFinale } from '@quiz-dock/contracts';
import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { type EscapeUi, initialEscapeUi } from '../game/escape/escape-reducer';
import { drawEn, GAME, ME, state, team, view } from '../game/escape/test-fixtures';
import type { EscapeSession } from '../game/escape/use-escape-session';
import { EscapedView, EscapePlayer, TimeUpView } from './escape-player-page';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

// The fixtures' server time: their deadline is ten minutes on.
vi.mock('../game/clock', async (orig) => ({
  ...(await orig<typeof import('../game/clock')>()),
  serverNow: () => 1_000_000_000,
}));

const finale: EscapeFinale = {
  gameId: GAME,
  title: 'Vault Heist',
  finale: 'Well played.',
  ranking: [],
  awards: { fastest: null, fewestHints: null, teamwork: null, photoFinish: null },
};

const session = (ui: Partial<EscapeUi>): EscapeSession => ({
  active: true,
  checkingRecord: false,
  ui: { ...initialEscapeUi, ...ui },
  dispatch: vi.fn(),
  submit: vi.fn(),
  askHint: vi.fn(),
  chooseTeam: vi.fn(),
  resultsFromRecord: vi.fn(),
});

const draw = (ui: Partial<EscapeUi>, hostAway = false) =>
  drawEn(
    <EscapePlayer
      pin="482913"
      escape={session(ui)}
      me={ME}
      connectionLost={false}
      hostAway={hostAway}
    />,
  );

describe('EscapePlayer by phase', () => {
  it('forming: the lobby', () => {
    draw({ state: state({ phase: 'forming', team: null, view: null }) });
    expect(screen.getByText('Waiting for the host to form teams')).toBeInTheDocument();
  });

  it('running: the stage with its timer, dots, role card, clues, locks and hints', () => {
    draw({ state: state({ nextHint: { id: 'h1', penaltyS: 30 } }) });
    expect(screen.getByRole('heading', { name: 'The vault door' })).toBeInTheDocument();
    expect(screen.getByText('Find the code.')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent('10:00');
    expect(screen.getByRole('list', { name: 'Stage 2 of 4' })).toBeInTheDocument();
    expect(screen.getByText('Red Foxes')).toBeInTheDocument();
    expect(screen.getByText('Your role')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My clues' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Answer for Keypad' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hint \(\+30 s\)/ })).toBeInTheDocument();
    // The announcer's regions are on the page from the start.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByTestId('escape-assertive')).toBeInTheDocument();
  });

  it('a cleared stage: the unlock moment over the new stage', () => {
    draw({
      state: state(),
      overlay: { kind: 'stage', unlockText: 'The door creaks open.', stageIndex: 0 },
    });
    expect(screen.getByTestId('unlock-moment')).toHaveTextContent('Stage 2 unlocked');
  });

  it('escaped, then time up', () => {
    const { unmount } = draw({
      state: state({
        team: team({ escaped: true, deadlineAt: null }),
        view: view({ escaped: true }),
      }),
    });
    expect(screen.getByRole('heading', { name: 'You escaped!' })).toBeInTheDocument();
    unmount();
    draw({ state: state({ team: team({ timedOut: true, deadlineAt: null }) }) });
    expect(screen.getByRole('heading', { name: "Time's up" })).toBeInTheDocument();
  });

  it('the finale, with the room closed once the game ended', () => {
    draw({ state: state({ phase: 'finale' }), finale, ended: 'final' });
    expect(screen.getByRole('heading', { name: 'Vault Heist' })).toBeInTheDocument();
    expect(screen.getByText('The room is closed')).toBeInTheDocument();
  });

  it.each<[string, Partial<EscapeUi>]>([
    ['the game ended before the finale', { state: state(), ended: 'waiting' }],
    ['a reload in the finale phase', { state: state({ phase: 'finale' }) }],
  ])('%s: Results coming…', (_, ui) => {
    draw(ui);
    expect(screen.getByText('Results coming…')).toBeInTheDocument();
  });

  it('ended with no finale: the plain ended screen', () => {
    draw({ state: state({ phase: 'forming', team: null }), ended: 'final' });
    expect(screen.getByText('The game is over')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Join another room' })).toBeInTheDocument();
  });

  it('the host away: a note, the stage stays', () => {
    draw({ state: state() }, true);
    expect(screen.getByText('The host is away. The game goes on.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'The vault door' })).toBeInTheDocument();
  });
});

describe('end-of-run screens', () => {
  it('escaped: the final unlock text, You escaped!, the time at the escape, the wait', () => {
    drawEn(
      <EscapedView
        state={state({ team: team({ escaped: true }) })}
        unlockText="Daylight!"
        timeMs={1_234_000}
      />,
    );
    expect(screen.getByRole('heading', { name: 'You escaped!' })).toBeInTheDocument();
    expect(screen.getByText('Daylight!')).toBeInTheDocument();
    expect(screen.getByText('Red Foxes escaped in 20:34')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the other teams')).toBeInTheDocument();
  });

  it("time up: Time's up and the stages cleared", () => {
    drawEn(<TimeUpView state={state({ team: team({ timedOut: true, stageIndex: 2 }) })} />);
    expect(screen.getByRole('heading', { name: "Time's up" })).toBeInTheDocument();
    expect(screen.getByText('Stages cleared: 2 of 4')).toBeInTheDocument();
  });
});
