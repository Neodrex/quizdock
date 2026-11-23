import type { EscapePlayerState } from '@quiz-dock/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { savePlayerSession } from '../../game-client';
import { EscapeLobby } from '../escape-lobby';
import { drawEn, en, ME, state, team } from '../test-fixtures';
import { codeInput } from './race-team-picker';

const NOW = 1_000_000_000;
vi.mock('../../clock', async (orig) => ({
  ...(await orig<typeof import('../../clock')>()),
  serverNow: () => Date.now(),
}));

const race = (format: 'solo' | 'teams', startsAt: number | null = null) => ({
  type: 'race' as const,
  raceFormat: format,
  startsAt,
  isPhoneHost: false,
});
const lobby = (over: Partial<EscapePlayerState> = {}) =>
  state({ phase: 'forming', team: null, view: null, session: race('teams'), ...over });

function draw(s: EscapePlayerState, newTeam = vi.fn(), joinTeam = vi.fn()) {
  drawEn(
    <EscapeLobby state={s} me={ME} chooseTeam={vi.fn()} newTeam={newTeam} joinTeam={joinTeam} />,
  );
  return { newTeam, joinTeam };
}
const refusal = (text: string, code: string) => Object.assign(new Error(text), { code });

describe('race on the phone', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('a team race: three choices, Play solo by default (nothing sent)', () => {
    const { newTeam, joinTeam } = draw(lobby());
    const group = screen.getByRole('radiogroup', { name: 'How do you race?' });
    expect(within(group).getByRole('radio', { name: 'Play solo' })).toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Start a team' })).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'Join a team' })).toBeInTheDocument();
    expect(screen.getByText('You race alone unless you start or join a team.')).toBeInTheDocument();
    for (const l of screen.getAllByRole('radio'))
      expect(l.closest('label')!.className).toMatch(/min-h-12/);
    expect(newTeam).not.toHaveBeenCalled();
    expect(joinTeam).not.toHaveBeenCalled();
  });

  it('start a team: a name, then the team with its code to share and its members', async () => {
    const newTeam = vi.fn().mockResolvedValue({ teamId: 't9', code: 'KQZM' });
    draw(lobby(), newTeam);
    fireEvent.click(screen.getByRole('radio', { name: 'Start a team' }));
    const create = screen.getByRole('button', { name: 'Create the team' });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Team name' }), {
      target: { value: '  Owls ' },
    });
    fireEvent.click(create);
    await waitFor(() => expect(newTeam).toHaveBeenCalledWith('Owls'));
  });

  it('in a team: the code in large letters, and the members by nickname', () => {
    draw(lobby({ team: team({ name: 'Owls', code: 'KQZM' }) }));
    expect(screen.getByText('Share this code')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Team code: K Q Z M' })).toHaveTextContent('KQZM');
    const list = screen.getByRole('list', { name: 'Your team' });
    expect(list).toHaveTextContent('Ana');
    expect(list).toHaveTextContent('Ben');
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('join a team: the code upper case, 4 letters', async () => {
    const joinTeam = vi.fn().mockResolvedValue({ teamId: 't2' });
    draw(lobby(), undefined, joinTeam);
    fireEvent.click(screen.getByRole('radio', { name: 'Join a team' }));
    const field = screen.getByRole('textbox', { name: 'Team code (4 letters)' });
    const go = screen.getByRole('button', { name: 'Join' });
    fireEvent.change(field, { target: { value: 'kq' } });
    expect(field).toHaveValue('KQ');
    expect(go).toBeDisabled();
    fireEvent.change(field, { target: { value: 'kq z-m9x' } });
    expect(field).toHaveValue('KQZM');
    fireEvent.click(go);
    await waitFor(() => expect(joinTeam).toHaveBeenCalledWith('KQZM'));
  });

  it.each([
    ['This team is full. Pick another one.', 'escape.team_full'],
    ['No team has this code.', 'escape.team_code_unknown'],
    ['Too many tries, wait a minute.', 'escape.too_many_codes'],
  ])('a refused code says so: %s', async (text, code) => {
    const joinTeam = vi.fn().mockRejectedValue(refusal(text, code));
    draw(lobby(), undefined, joinTeam);
    fireEvent.click(screen.getByRole('radio', { name: 'Join a team' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Team code (4 letters)' }), {
      target: { value: 'ABCD' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('after the start without a team: the same three choices; solo starts a team of one', async () => {
    savePlayerSession({ pin: '482913', sessionToken: 't', playerId: ME, nickname: 'Ana' });
    const newTeam = vi.fn().mockResolvedValue({ teamId: 't9', code: 'KQZM' });
    draw(lobby({ phase: 'running' }), newTeam);
    expect(
      screen.getByText('The race has started: pick how you race to join in.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Start a team' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Join a team' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Race solo now' }));
    await waitFor(() => expect(newTeam).toHaveBeenCalledWith('Ana'));
  });

  it('a solo race: no picker, "You race alone", and the countdown', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    draw(lobby({ session: race('solo', NOW + 299_000), team: team({ members: [] }) }));
    expect(screen.getByText('You race alone')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByRole('timer')).toHaveTextContent('Starts in 4:59');
    act(() => vi.advanceTimersByTime(299_000));
    expect(screen.getByRole('timer')).toHaveTextContent('Starting…');
  });

  it('no countdown without a scheduled start', () => {
    draw(lobby({ session: race('teams') }));
    expect(screen.queryByRole('timer')).toBeNull();
  });

  // ── Leaving a team (M8 Task 8.16) ──

  const owls = () => team({ name: 'Owls', code: 'ABCD' });

  it('in a team race lobby, a team member can leave after a confirm', async () => {
    const leaveTeam = vi.fn().mockResolvedValue(undefined);
    const s = lobby({ team: owls() });
    const { rerender } = drawEn(
      <EscapeLobby state={s} me={ME} chooseTeam={vi.fn()} leaveTeam={leaveTeam} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Leave the team' }));
    expect(leaveTeam).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/race solo/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(leaveTeam).toHaveBeenCalledTimes(1));
    // The server's next state has no team: back to the three choices.
    rerender(
      <I18nextProvider i18n={en}>
        <EscapeLobby
          state={lobby({ team: null })}
          me={ME}
          chooseTeam={vi.fn()}
          leaveTeam={leaveTeam}
        />
      </I18nextProvider>,
    );
    expect(screen.getByRole('radiogroup', { name: 'How do you race?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Leave the team' })).toBeNull();
  });

  it('cancelling the confirm leaves nothing; a refusal shows its text', async () => {
    const leaveTeam = vi
      .fn()
      .mockRejectedValue(refusal('The race has started', 'escape.wrong_phase'));
    drawEn(
      <EscapeLobby
        state={lobby({ team: owls() })}
        me={ME}
        chooseTeam={vi.fn()}
        leaveTeam={leaveTeam}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Leave the team' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(leaveTeam).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Leave the team' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('The race has started');
  });

  it('no Leave button once running, in a solo race, or outside a race', () => {
    const leaveTeam = vi.fn();
    const cases: EscapePlayerState[] = [
      lobby({ team: owls(), phase: 'running' }),
      lobby({ team: owls(), session: race('solo') }),
      state({ phase: 'forming', team: owls(), view: null }),
    ];
    for (const s of cases) {
      const { unmount } = drawEn(
        <EscapeLobby state={s} me={ME} chooseTeam={vi.fn()} leaveTeam={leaveTeam} />,
      );
      expect(screen.queryByRole('button', { name: 'Leave the team' })).toBeNull();
      unmount();
    }
  });

  it('codeInput keeps letters, upper case, four at most', () => {
    expect(codeInput(' ab-c d e')).toBe('ABCD');
  });
});
