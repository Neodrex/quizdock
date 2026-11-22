import type { EscapeHostState, EscapeHostTeam } from '@quiz-dock/contracts';
import { act, fireEvent, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawEn } from '../test-fixtures';
import type { HostCommands } from './host-actions';
import { SAMPLE_ANSWERS, boardOf, hostStateOf, hostTeamOf, outlineOf } from './host-fixtures';
import { RunGrid, sortTeams, useTeamSelection } from './run-grid';

const NOW = 1_000_000_000;

const red = hostTeamOf({
  stageIndex: 1,
  stageTitle: 'The Security Room',
  locksSolved: 1,
  locksTotal: 2,
  solved: ['security-override'],
  stageClearedAt: [252_000],
  wrong: 4,
  hintsUsed: 2,
  hintPenaltyS: 60,
  members: [
    ...hostTeamOf().members,
    { playerId: 'p3', nickname: 'Cy', avatar: null, connected: false, roles: [] },
  ],
  memberCount: 3,
  connectedCount: 2,
  deadlineAt: NOW + 1_500_000,
  remainingMs: 1_500_000,
});
const blue = hostTeamOf({
  id: 't2',
  name: 'Team Blue',
  deadlineAt: NOW + 1_800_000,
  remainingMs: 1_800_000,
  stuck: true,
  timeOnStageMs: 6 * 60_000 + 5_000,
});
const green = hostTeamOf({
  id: 't3',
  name: 'Team Green',
  stageIndex: 2,
  stageTitle: 'The Vault Door',
  escaped: true,
  stageClearedAt: [200_000, 900_000, 1_872_000],
  locksSolved: 1,
  locksTotal: 1,
  deadlineAt: null,
  remainingMs: 528_000,
});

const running = (
  teams: EscapeHostTeam[] = [red, blue, green],
  over: Partial<EscapeHostState> = {},
) => hostStateOf({ board: boardOf({ teams }), teams, ...over });

const commands = (): HostCommands => ({
  pending: {},
  hint: vi.fn(async () => 1),
  adjustTime: vi.fn(async () => ({})),
  unlock: vi.fn(async () => ({})),
  pause: vi.fn(async () => ({})),
  end: vi.fn(async () => ({})),
});

function draw(host = running(), selected: string | null = null) {
  const onSelect = vi.fn();
  const utils = drawEn(
    <RunGrid
      outline={outlineOf()}
      host={host}
      selected={selected}
      onSelect={onSelect}
      commands={commands()}
    />,
  );
  return { onSelect, ...utils };
}

/** The laptop (rows) or tablet (cards) layout, by the `lg` media query. */
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

const row = (name: string) =>
  screen.getByRole('button', { name: `Show ${name}` }).closest('tr') as HTMLElement;

describe('RunGrid', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    screenIs(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  describe('a row per team on a laptop', () => {
    it('name and connected count, with an offline mark', () => {
      draw();
      const r = within(row('Team Red'));
      expect(r.getByLabelText('2 of 3 connected')).toHaveTextContent('2/3');
      expect(r.getByLabelText('2 of 3 connected').querySelector('svg')).not.toBeNull();
      expect(
        within(row('Team Blue')).getByLabelText('2 of 2 connected').querySelector('svg'),
      ).toBeNull();
    });

    it('one cell per stage: done with its split, current with its locks, or ahead', () => {
      draw();
      const cells = within(row('Team Red')).getAllByRole('cell');
      expect(cells[0]).toHaveTextContent('Done in 4:12');
      expect(cells[1]).toHaveTextContent('1/2 locks');
      expect(cells[2]).toHaveTextContent('Not yet');
      const green = within(row('Team Green')).getAllByRole('cell');
      // Splits: 3:20, then 11:40, then 16:12.
      expect(green.slice(0, 3).map((c) => c.textContent)).toEqual([
        expect.stringContaining('3:20'),
        expect.stringContaining('11:40'),
        expect.stringContaining('16:12'),
      ]);
    });

    it('wrong tries, hints with their penalty, and time left on the shared tick', () => {
      draw();
      const cells = within(row('Team Red')).getAllByRole('cell');
      expect(cells[3]).toHaveTextContent('4');
      expect(cells[4]).toHaveTextContent('2 · +1:00');
      expect(cells[5]).toHaveTextContent('25:00');
      act(() => vi.advanceTimersByTime(3_000));
      expect(within(row('Team Red')).getAllByRole('cell')[5]).toHaveTextContent('24:57');
    });

    it('status: playing, escaped (time), timed out, stuck', () => {
      const late = hostTeamOf({ id: 't4', name: 'Team Grey', timedOut: true, deadlineAt: null });
      draw(running([red, blue, green, late]));
      expect(row('Team Red')).toHaveTextContent('Playing');
      expect(row('Team Green')).toHaveTextContent('Escaped in 31:12');
      expect(row('Team Grey')).toHaveTextContent('Time up');
      expect(row('Team Blue')).toHaveTextContent('Stuck 6 min');
    });
  });

  it('cards on a tablet: the same facts, two columns at md', () => {
    screenIs(false);
    draw();
    expect(screen.queryByRole('table')).toBeNull();
    const card = screen.getByRole('article', { name: 'Team Red' });
    expect(card.closest('ul')?.className).toMatch(/md:grid-cols-2/);
    const c = within(card);
    expect(c.getByLabelText('2 of 3 connected')).toHaveTextContent('2/3');
    expect(card).toHaveTextContent('Done in 4:12');
    expect(card).toHaveTextContent('1/2 locks');
    expect(card).toHaveTextContent('2 · +1:00');
    expect(card).toHaveTextContent('25:00');
    expect(card).toHaveTextContent('Playing');
    expect(c.getByRole('button', { name: 'Show Team Red' }).className).toMatch(/min-h-11/);
  });

  it('paused: time left frozen from remainingMs, and a banner', () => {
    const frozen = { ...red, deadlineAt: null, remainingMs: 600_000 };
    const host = running([frozen], {
      board: boardOf({ clock: { ...boardOf().clock, paused: true }, teams: [frozen] }),
    });
    draw(host);
    expect(screen.getByRole('status')).toHaveTextContent('Paused');
    expect(within(row('Team Red')).getAllByRole('cell')[5]).toHaveTextContent('10:00');
    act(() => vi.advanceTimersByTime(5_000));
    expect(within(row('Team Red')).getAllByRole('cell')[5]).toHaveTextContent('10:00');
  });

  it('stuck: an amber badge with a quick hint, which does not pick the team', () => {
    const { onSelect } = draw();
    const r = within(row('Team Blue'));
    expect(r.getByText('Stuck 6 min').className).toMatch(/warning/);
    fireEvent.click(r.getByRole('button', { name: 'Give Team Blue a hint' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Give Team Blue the next hint?');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a row click picks the team', () => {
    const { onSelect } = draw(running(), 't2');
    expect(screen.getByRole('button', { name: 'Show Team Blue' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(row('Team Red')).getAllByRole('cell')[3]);
    expect(onSelect).toHaveBeenCalledWith('t1');
  });

  it('the pick is kept in ?team=, so a reload keeps it', () => {
    window.history.replaceState(null, '', '/session/123456/console?team=t2');
    const { result, unmount } = renderHook(() => useTeamSelection());
    expect(result.current[0]).toBe('t2');
    act(() => result.current[1]('t3'));
    expect(window.location.search).toBe('?team=t3');
    unmount();
    expect(renderHook(() => useTeamSelection()).result.current[0]).toBe('t3');
  });

  it('sorts by stage, then locks solved, then time left; "by name" is remembered', () => {
    const ahead = { ...blue, id: 't5', name: 'Team Amber', locksSolved: 1, stuck: false };
    expect(sortTeams([blue, red, green, ahead], 'progress', NOW).map((t) => t.name)).toEqual([
      'Team Green',
      'Team Red',
      'Team Amber',
      'Team Blue',
    ]);
    const slow = { ...ahead, id: 't6', name: 'Team Slow', deadlineAt: NOW + 60_000 };
    expect(sortTeams([slow, ahead], 'progress', NOW).map((t) => t.name)).toEqual([
      'Team Amber',
      'Team Slow',
    ]);
    const { unmount } = draw();
    const names = () => screen.getAllByRole('button', { name: /^Show / }).map((b) => b.textContent);
    expect(names()).toEqual(['Team Green', 'Team Red', 'Team Blue']);
    fireEvent.click(screen.getByRole('button', { name: 'By name' }));
    expect(names()).toEqual(['Team Blue', 'Team Green', 'Team Red']);
    unmount();
    draw();
    expect(names()).toEqual(['Team Blue', 'Team Green', 'Team Red']);
  });

  it('no storage (a private window): sorts by progress and still switches', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'By name' }));
    expect(screen.getAllByRole('button', { name: /^Show / })[0]).toHaveTextContent('Team Blue');
  });

  it('shows no answer value', () => {
    for (const laptop of [true, false]) {
      screenIs(laptop);
      const { container, unmount } = draw();
      const text = container.textContent!.toLowerCase();
      for (const a of SAMPLE_ANSWERS) expect(text).not.toContain(a);
      unmount();
    }
  });
});
