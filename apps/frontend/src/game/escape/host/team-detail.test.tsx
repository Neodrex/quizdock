import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawEn } from '../test-fixtures';
import type { HostCommands } from './host-actions';
import { SAMPLE_ANSWERS, hostTeamOf, outlineOf } from './host-fixtures';
import { TeamDetail, TeamDetailPanel } from './team-detail';

const commands = (): HostCommands => ({
  pending: {},
  hint: vi.fn(async () => 1),
  adjustTime: vi.fn(async () => ({})),
  unlock: vi.fn(async () => ({})),
  pause: vi.fn(async () => ({})),
  end: vi.fn(async () => ({})),
});

const lobby = hostTeamOf({
  solved: ['lobby-badge'],
  hostUnlocks: ['lobby-badge'],
  wrong: 3,
  hintIds: ['lobby-h1'],
  hintPenaltyS: 30,
  members: [
    ...hostTeamOf().members,
    { playerId: 'p3', nickname: 'Cy', avatar: null, connected: false, roles: [] },
  ],
});
const security = hostTeamOf({
  stageIndex: 1,
  stageTitle: 'The Security Room',
  partsDone: { 'security-switch': ['hacker'] },
});

function draw(team = lobby, over: Partial<Parameters<typeof TeamDetail>[0]> = {}) {
  const c = commands();
  drawEn(<TeamDetail outline={outlineOf()} team={team} commands={c} {...over} />);
  return c;
}

const lockRow = (label: string) => screen.getByText(label).closest('li') as HTMLElement;

describe('TeamDetail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the current stage and each lock with its kind and state: open, open by the host, closed', () => {
    draw(hostTeamOf({ ...lobby, solved: ['lobby-door', 'lobby-badge'] }));
    expect(screen.getByText('Stage 1 of 3: The Lobby')).toBeInTheDocument();
    expect(lockRow('Staff door keypad')).toHaveTextContent('Code:');
    expect(lockRow('Staff door keypad')).toHaveTextContent('Open');
    expect(lockRow('Staff door keypad')).not.toHaveTextContent('Opened by the host');
    expect(lockRow('Which badge gets you past the guard?')).toHaveTextContent('Choice:');
    expect(lockRow('Which badge gets you past the guard?')).toHaveTextContent('Opened by the host');
  });

  it('a closed lock has an Open button (confirmed) for this team', async () => {
    const c = draw();
    const row = within(lockRow('Staff door keypad'));
    expect(row.getByText('Closed')).toBeInTheDocument();
    fireEvent.click(row.getByRole('button', { name: 'Open Staff door keypad for Team Red' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Open the lock' }),
    );
    await waitFor(() => expect(c.unlock).toHaveBeenCalledWith('t1', 'lobby-door'));
    // An open lock has none.
    expect(
      within(lockRow('Which badge gets you past the guard?')).queryByRole('button', {
        name: /^Open /,
      }),
    ).toBeNull();
  });

  it('combined locks show each role part, entered or waiting', () => {
    draw(security);
    const row = lockRow('Camera master switch');
    expect(row).toHaveTextContent('Combined:');
    expect(within(row).getByText('Hacker: entered')).toBeInTheDocument();
    expect(within(row).getByText('Safecracker: waiting')).toBeInTheDocument();
    expect(within(row).getByText('Lookout: waiting')).toBeInTheDocument();
  });

  it('members with roles and connection, and the wrong tries', () => {
    draw();
    const players = screen.getByRole('region', { name: 'Players' });
    expect(within(players).getByText('Ana').closest('li')).toHaveTextContent('Hacker, Lookout');
    expect(within(players).getByText('Cy').closest('li')).toHaveTextContent('Offline');
    expect(within(players).getByText('Ana').closest('li')).not.toHaveTextContent('Offline');
    expect(players).toHaveTextContent('Wrong tries: 3');
  });

  it('released hints in order with their source and cost; the penalty so far', () => {
    draw(hostTeamOf({ ...lobby, hintIds: ['lobby-h1', 'lobby-h2'], hintPenaltyS: 30 }), {
      hintSources: { 'lobby-h1': 'host', 'lobby-h2': 'timer' },
    });
    const hints = screen.getByRole('region', { name: 'Hints released' });
    const items = within(hints).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Look at the plaque.');
    expect(items[0]).toHaveTextContent('Given by you: +30 s');
    expect(items[1]).toHaveTextContent('The year is the code.');
    expect(items[1]).toHaveTextContent('Free (on time)');
    expect(hints).toHaveTextContent('Hint penalty so far: +0:30');
  });

  it('a hint heard of before a reload says only that it was released', () => {
    draw();
    expect(screen.getByRole('region', { name: 'Hints released' })).toHaveTextContent('Released');
  });

  it('the next hint, its text and cost, or "No hints left"', () => {
    draw();
    const hints = screen.getByRole('region', { name: 'Hints released' });
    expect(hints).toHaveTextContent('Next hint (adds 60 s to their score)');
    expect(hints).toHaveTextContent('The year is the code.');
    draw(hostTeamOf({ id: 't9', name: 'Team Done', hintIds: ['lobby-h1', 'lobby-h2'] }));
    expect(screen.getAllByText('No hints left')).toHaveLength(1);
  });

  it('the stage clues fold, each tagged by role', () => {
    draw();
    const clues = screen.getByText('Clues for this stage').closest('details')!;
    expect(clues.open).toBe(false);
    expect(within(clues).getByText('A brass plaque.').closest('li')).toHaveTextContent('Everyone');
    expect(within(clues).getByText('The guard wears blue.').closest('li')).toHaveTextContent(
      'Lookout',
    );
  });

  it('extra time says the score is unchanged', () => {
    draw(hostTeamOf({ adjustMs: 120_000 }));
    expect(screen.getByText('Extra time given: +2:00 (score unchanged)')).toBeInTheDocument();
  });

  it('an escaped team shows it, with no locks to open', () => {
    draw(hostTeamOf({ escaped: true, stageIndex: 2 }));
    expect(screen.getByText('Escaped: every stage is cleared.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
  });

  it('shows no answer value', () => {
    for (const team of [lobby, security]) {
      const { container, unmount } = drawEn(
        <TeamDetail outline={outlineOf()} team={team} commands={commands()} />,
      );
      const text = container.textContent!.toLowerCase();
      for (const a of SAMPLE_ANSWERS) expect(text).not.toContain(a);
      unmount();
    }
  });
});

describe('TeamDetailPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  function screenIs(laptop: boolean) {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: laptop && query.includes('1024px'),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
  }

  it('a side column on a laptop', () => {
    screenIs(true);
    drawEn(
      <TeamDetailPanel
        outline={outlineOf()}
        team={lobby}
        commands={commands()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('complementary', { name: 'Team Red' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a sheet on a tablet; Escape closes it and the focus goes back to the team card', async () => {
    screenIs(false);
    const card = document.createElement('button');
    card.setAttribute('data-team-card', 't1');
    document.body.append(card);
    const onClose = vi.fn();
    const { rerender } = drawEn(
      <TeamDetailPanel
        outline={outlineOf()}
        team={lobby}
        commands={commands()}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Team Red' })).toBeInTheDocument();
    const target = document.activeElement ?? document.body;
    fireEvent.keyDown(target, { key: 'Escape', code: 'Escape' });
    fireEvent.keyUp(target, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    rerender(
      <TeamDetailPanel outline={outlineOf()} team={null} commands={commands()} onClose={onClose} />,
    );
    await waitFor(() => expect(card).toHaveFocus());
    card.remove();
  });

  it('nothing picked: nothing shown', () => {
    const { container } = drawEn(
      <TeamDetailPanel outline={outlineOf()} team={null} commands={commands()} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
