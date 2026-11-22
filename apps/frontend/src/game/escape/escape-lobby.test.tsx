import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EscapeLobby } from './escape-lobby';
import { ProgressDots } from './progress-dots';
import { RoleCard } from './role-card';
import { drawEn, ME, state, view } from './test-fixtures';

const forming = (over: Parameters<typeof state>[0] = {}) =>
  state({ phase: 'forming', team: null, view: null, ...over });

describe('EscapeLobby', () => {
  it('auto mode without a team waits for the host', () => {
    drawEn(<EscapeLobby state={forming()} me={ME} chooseTeam={vi.fn()} />);
    expect(screen.getByText('Waiting for the host to form teams')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('self mode lists the teams with their size; a full one is disabled', () => {
    const s = forming({
      formation: {
        mode: 'self',
        maxSize: 3,
        teams: [
          { id: 'a', name: 'Owls', memberCount: 1 },
          { id: 'b', name: 'Bats', memberCount: 3 },
        ],
      },
    });
    drawEn(<EscapeLobby state={s} me={ME} chooseTeam={vi.fn()} />);
    const owls = screen.getByRole('button', { name: /Owls/ });
    expect(owls).toHaveTextContent('1/3');
    expect(owls).toBeEnabled();
    const bats = screen.getByRole('button', { name: /Bats/ });
    expect(bats).toBeDisabled();
    expect(bats).toHaveTextContent('Full');
    // Tap targets of at least 48 px.
    expect(owls.className).toMatch(/min-h-12/);
  });

  it('a tap chooses the team; a refusal shows its text', async () => {
    const chooseTeam = vi.fn().mockRejectedValue(
      Object.assign(new Error('This team is full. Pick another one.'), {
        code: 'escape.team_full',
      }),
    );
    const s = forming({
      formation: {
        mode: 'self',
        maxSize: null,
        teams: [{ id: 'a', name: 'Owls', memberCount: 9 }],
      },
    });
    drawEn(<EscapeLobby state={s} me={ME} chooseTeam={chooseTeam} />);
    const owls = screen.getByRole('button', { name: /Owls/ });
    expect(owls).toHaveTextContent('9');
    fireEvent.click(owls);
    expect(chooseTeam).toHaveBeenCalledWith('a');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This team is full. Pick another one.',
    );
  });

  it('with a team: its name and the teammates, my line marked, the offline one marked', () => {
    drawEn(
      <EscapeLobby state={state({ phase: 'forming', view: null })} me={ME} chooseTeam={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'Red Foxes' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Your team' });
    const [ana, ben] = within(list).getAllByRole('listitem');
    expect(ana).toHaveTextContent('Ana');
    expect(ana).toHaveTextContent('(you)');
    expect(ben).toHaveTextContent('Ben');
    expect(ben).toHaveTextContent('Offline');
    expect(ana).not.toHaveTextContent('Offline');
  });

  it('a pending choice sends once', async () => {
    let resolve!: () => void;
    const chooseTeam = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const s = forming({
      formation: {
        mode: 'self',
        maxSize: null,
        teams: [{ id: 'a', name: 'Owls', memberCount: 0 }],
      },
    });
    drawEn(<EscapeLobby state={s} me={ME} chooseTeam={chooseTeam} />);
    const owls = screen.getByRole('button', { name: /Owls/ });
    fireEvent.click(owls);
    fireEvent.click(owls);
    expect(chooseTeam).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(owls).toBeEnabled());
  });
});

describe('RoleCard', () => {
  it('shows the name and description of each of my roles', () => {
    drawEn(<RoleCard state={state({ view: view({ roles: ['lookout', 'safe'] }) })} me={ME} />);
    expect(screen.getByText('Lookout')).toBeInTheDocument();
    expect(screen.getByText('Watches the guards.')).toBeInTheDocument();
    expect(screen.getByText('Safecracker')).toBeInTheDocument();
    expect(screen.getByText('Opens the safe.')).toBeInTheDocument();
  });

  it('roles mode with no role yet says it comes at the start', () => {
    const s = state({ phase: 'forming', team: null, view: null });
    drawEn(<RoleCard state={s} me={ME} />);
    expect(screen.getByText('Your role is given at the start')).toBeInTheDocument();
  });

  it('parallel mode (no roles) shows no card', () => {
    const { container } = drawEn(<RoleCard state={state({ roles: [] })} me={ME} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ProgressDots', () => {
  it('one dot per stage, the current one marked, with a label', () => {
    drawEn(<ProgressDots stageIndex={1} stageCount={4} />);
    const list = screen.getByRole('list', { name: 'Stage 2 of 4' });
    const dots = within(list).getAllByRole('listitem');
    expect(dots).toHaveLength(4);
    expect(dots[1]).toHaveAttribute('aria-current', 'step');
    expect(dots[0]).not.toHaveAttribute('aria-current');
  });
});
