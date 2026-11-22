import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { drawEn, en } from '../test-fixtures';
import { FormationPanel, suggestedCount } from './formation-panel';
import { boardOf, hostStateOf, outlineOf } from './host-fixtures';

/** A forming lobby of `n` unassigned players. */
const lobby = (n: number, over: Parameters<typeof hostStateOf>[0] = {}) =>
  hostStateOf({
    board: boardOf({ phase: 'forming' }),
    teams: [],
    unassigned: Array.from({ length: n }, (_, i) => ({
      playerId: `p${i}`,
      nickname: `P${i}`,
      connected: true,
    })),
    ...over,
  });

const parallel = outlineOf({ mode: 'parallel', roles: [] });

describe('suggestedCount', () => {
  it('aims at teams of five, at least one team', () => {
    expect(suggestedCount(0, 0)).toBe(1);
    expect(suggestedCount(12, 0)).toBe(3);
  });
  it('in roles mode, no team smaller than the role count', () => {
    // 3 roles, 10 players: ceil(10/5) = 2 teams of 5, fine.
    expect(suggestedCount(10, 3)).toBe(2);
    // 3 roles, 4 players: 1 team of 4, not 1 of 2 and 1 of 2.
    expect(suggestedCount(4, 3)).toBe(1);
    // 5 roles, 14 players: 2 teams (7 each), not 3 (4 or 5 each).
    expect(suggestedCount(14, 5)).toBe(2);
  });
});

describe('FormationPanel', () => {
  it('auto: a count (default from the room), an optional cap and names; Make teams sends them', async () => {
    const onTeams = vi.fn(async () => ({ ok: true }));
    drawEn(<FormationPanel outline={parallel} host={lobby(12)} onTeams={onTeams} busy={false} />);
    expect(screen.getByText('Players in the room: 12')).toBeInTheDocument();
    const count = screen.getByLabelText('Number of teams');
    expect(count).toHaveValue(3);
    fireEvent.click(screen.getByRole('button', { name: 'Make teams' }));
    await waitFor(() => expect(onTeams).toHaveBeenCalledWith({ mode: 'auto', count: 3 }));
    fireEvent.change(count, { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Max players per team (optional)'), {
      target: { value: '6' },
    });
    fireEvent.change(screen.getByLabelText('Team names (optional, one per line)'), {
      target: { value: ' Owls \n\nBats\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make teams' }));
    await waitFor(() =>
      expect(onTeams).toHaveBeenLastCalledWith({
        mode: 'auto',
        count: 2,
        maxSize: 6,
        names: ['Owls', 'Bats'],
      }),
    );
  });

  it('a count outside 1–100 cannot be sent', () => {
    const onTeams = vi.fn(async () => ({ ok: true }));
    drawEn(<FormationPanel outline={parallel} host={lobby(4)} onTeams={onTeams} busy={false} />);
    for (const v of ['0', '101', '']) {
      fireEvent.change(screen.getByLabelText('Number of teams'), { target: { value: v } });
      expect(screen.getByRole('button', { name: 'Make teams' })).toBeDisabled();
    }
    expect(onTeams).not.toHaveBeenCalled();
  });

  it('roles mode suggests teams of at least its role count', () => {
    drawEn(<FormationPanel outline={outlineOf()} host={lobby(4)} onTeams={vi.fn()} busy={false} />);
    expect(screen.getByLabelText('Number of teams')).toHaveValue(1);
    expect(
      screen.getByText('This room has 3 roles: aim for at least 3 players per team.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Max players per team (optional)'), {
      target: { value: '2' },
    });
    expect(
      screen.getByText('With fewer than 3 players per team, some players hold more than one role.'),
    ).toBeInTheDocument();
  });

  it('parallel mode says nothing about roles', () => {
    drawEn(<FormationPanel outline={parallel} host={lobby(4)} onTeams={vi.fn()} busy={false} />);
    expect(screen.queryByText(/roles/)).toBeNull();
  });

  it('self: sends the count and cap, then says the players pick on their phones', async () => {
    const onTeams = vi.fn(async () => ({ ok: true }));
    const { rerender } = drawEn(
      <FormationPanel outline={parallel} host={lobby(10)} onTeams={onTeams} busy={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Players pick' }));
    expect(screen.queryByLabelText('Team names (optional, one per line)')).toBeNull();
    fireEvent.change(screen.getByLabelText('Max players per team (optional)'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open team choice' }));
    await waitFor(() =>
      expect(onTeams).toHaveBeenCalledWith({ mode: 'self', count: 2, maxSize: 5 }),
    );
    const open = lobby(10, {
      formation: {
        mode: 'self',
        maxSize: 5,
        teams: [
          { id: 't1', name: 'Team 1', memberCount: 0 },
          { id: 't2', name: 'Team 2', memberCount: 0 },
        ],
      },
    });
    rerender(
      <I18nextProvider i18n={en}>
        <FormationPanel outline={parallel} host={open} onTeams={onTeams} busy={false} />
      </I18nextProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Players pick their team on their phone.');
  });

  it('is hidden once the run is on', () => {
    const running = lobby(4, { board: boardOf({ phase: 'running' }) });
    const { container } = drawEn(
      <FormationPanel outline={parallel} host={running} onTeams={vi.fn()} busy={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a refusal (escape.wrong_phase) inline', async () => {
    const onTeams = vi.fn(async () => {
      throw Object.assign(new Error('Not possible at this point of the game.'), {
        code: 'escape.wrong_phase',
      });
    });
    drawEn(<FormationPanel outline={parallel} host={lobby(4)} onTeams={onTeams} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make teams' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not possible at this point of the game.',
    );
  });

  it('tap targets: the mode buttons, fields and Make teams', () => {
    drawEn(<FormationPanel outline={parallel} host={lobby(4)} onTeams={vi.fn()} busy={false} />);
    expect(screen.getByRole('group', { name: 'How teams form' }).className).toMatch(
      /\[&>button\]:min-h-11/,
    );
    expect(screen.getByLabelText('Number of teams').className).toMatch(/min-h-11/);
    expect(screen.getByRole('button', { name: 'Make teams' }).className).toMatch(/min-h-12/);
  });
});
