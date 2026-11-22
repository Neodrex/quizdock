import type { EscapeHostState } from '@quiz-dock/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawEn } from '../test-fixtures';
import { boardOf, hostStateOf, hostTeamOf, outlineOf } from './host-fixtures';
import { TOUCH_DELAY_MS, TeamBoard } from './team-board';

// The DndContext's props, to check its sensors; it still renders the real one.
const { dnd } = vi.hoisted(() => ({ dnd: { props: null as Record<string, unknown> | null } }));
vi.mock('@dnd-kit/core', async (orig) => {
  const m = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...m,
    DndContext: (props: Parameters<typeof m.DndContext>[0]) => {
      dnd.props = props as Record<string, unknown>;
      return createElement(m.DndContext, props);
    },
  };
});

const member = (playerId: string, nickname: string, roles: string[], connected = true) => ({
  playerId,
  nickname,
  avatar: null,
  connected,
  roles,
});

const red = hostTeamOf({
  members: [
    member('p1', 'Ana', ['hacker']),
    member('p2', 'Ben', ['safecracker'], false),
    member('p3', 'Cy', ['lookout']),
  ],
  memberCount: 3,
  connectedCount: 2,
});
const blue = hostTeamOf({ id: 't2', name: 'Team Blue', members: [], memberCount: 0 });

const forming = (over: Partial<EscapeHostState> = {}) =>
  hostStateOf({
    board: boardOf({ phase: 'forming' }),
    teams: [red, blue],
    unassigned: [{ playerId: 'p9', nickname: 'Zoe', connected: true }],
    ...over,
  });

function draw(host: EscapeHostState, outline = outlineOf()) {
  const onMove = vi.fn(async () => ({ ok: true }));
  const onStart = vi.fn(async () => ({ ok: true }));
  const utils = drawEn(
    <TeamBoard
      outline={outline}
      host={host}
      onMove={onMove}
      onStart={onStart}
      moving={false}
      starting={false}
    />,
  );
  return { onMove, onStart, ...utils };
}

const column = (name: string) => screen.getByRole('region', { name });

describe('TeamBoard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows each team and the unassigned players; a chip has its name, roles and offline mark', () => {
    draw(forming());
    const team = within(column('Team Red'));
    expect(team.getByText('Ana')).toBeInTheDocument();
    expect(team.getByText('Hacker')).toBeInTheDocument();
    const chipOf = (name: string) =>
      team.getByRole('button', { name: `Drag ${name}` }).closest('li');
    expect(chipOf('Ben')).toHaveTextContent('Offline');
    expect(chipOf('Ana')).not.toHaveTextContent('Offline');
    expect(within(column('Unassigned')).getByText('Zoe')).toBeInTheDocument();
    expect(within(column('Team Blue')).getByText('Nobody here yet')).toBeInTheDocument();
  });

  it('parallel mode shows no role names nor coverage line', () => {
    const plain = forming({
      teams: [{ ...red, members: red.members.map((m) => ({ ...m, roles: [] })) }],
    });
    draw(plain, outlineOf({ mode: 'parallel', roles: [] }));
    const team = within(column('Team Red'));
    expect(team.queryByText(/held|roles|Empty team/)).toBeNull();
    expect(team.getByText('2 of 3 connected')).toBeInTheDocument();
  });

  it('"Move to…" sends escape:move to a team, and Unassigned sends null', async () => {
    const { onMove } = draw(forming());
    fireEvent.click(screen.getByRole('button', { name: 'Move Ana to…' }));
    const menu = screen.getByRole('menu');
    // The chip's own team is not offered.
    expect(within(menu).queryByRole('menuitem', { name: 'Team Red' })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Team Blue' }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('p1', 't2'));
    fireEvent.click(screen.getByRole('button', { name: 'Move Ana to…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unassigned' }));
    await waitFor(() => expect(onMove).toHaveBeenLastCalledWith('p1', null));
  });

  it('a refused move shows its text', async () => {
    const { onMove } = draw(forming());
    onMove.mockRejectedValueOnce(new Error('This team is full. Pick another one.'));
    fireEvent.click(screen.getByRole('button', { name: 'Move Zoe to…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Team Blue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This team is full.');
  });

  it('drag and drop by keyboard (space, arrow, space) sends the same move', async () => {
    // jsdom lays nothing out: each column gets a box side by side.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const i = Number(this.closest('[data-board-column]')?.getAttribute('data-board-column'));
      const isColumn = this.hasAttribute('data-board-column');
      const left = Number.isNaN(i) ? 0 : i * 300;
      const box = isColumn
        ? { left, top: 0, width: 280, height: 400 }
        : { left: left + 10, top: 10, width: 200, height: 40 };
      return {
        ...box,
        x: box.left,
        y: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
        toJSON: () => box,
      } as DOMRect;
    });
    const { onMove } = draw(forming());
    const ana = screen.getByRole('button', { name: 'Drag Ana' });
    ana.focus();
    await act(async () => {
      fireEvent.keyDown(ana, { code: 'Space', key: ' ' });
      // The sensor listens from the next task on, and measures in effects.
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      fireEvent.keyDown(ana, { code: 'ArrowRight', key: 'ArrowRight' });
      // The sensor listens from the next task on, and measures in effects.
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      fireEvent.keyDown(ana, { code: 'Space', key: ' ' });
      // The sensor listens from the next task on, and measures in effects.
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('p1', 't2'));
  });

  it('only the grip is the drag handle, so a swipe over the board scrolls', () => {
    draw(forming());
    const grip = screen.getByRole('button', { name: 'Drag Ana' });
    expect(grip).toHaveClass('touch-none', 'min-h-11', 'min-w-11');
    expect(grip).toHaveAttribute('aria-roledescription', 'draggable');
    // The name sits outside the handle, and nothing else on the board blocks scrolling.
    const name = within(column('Team Red')).getByText('Ana');
    expect(grip).not.toContainElement(name);
    expect(document.querySelectorAll('.touch-none')).toHaveLength(
      screen.getAllByRole('button', { name: /^Drag / }).length,
    );
  });

  it('configures the pointer, touch (held 150 ms, so the page scrolls) and keyboard sensors', () => {
    draw(forming());
    const sensors = dnd.props?.sensors as { sensor: { name: string }; options: object }[];
    expect(sensors.map((s) => s.sensor.name)).toEqual([
      'PointerSensor',
      'TouchSensor',
      'KeyboardSensor',
    ]);
    expect(TOUCH_DELAY_MS).toBe(150);
    expect(sensors[1].options).toMatchObject({ activationConstraint: { delay: 150 } });
    expect(sensors[2].options).toHaveProperty('coordinateGetter');
  });

  it('coverage per team: all held, shared, empty', () => {
    const duo = hostTeamOf({
      id: 't3',
      name: 'Team Green',
      members: [member('p4', 'Dee', ['hacker', 'lookout']), member('p5', 'Eve', ['safecracker'])],
    });
    draw(forming({ teams: [red, blue, duo] }));
    expect(
      within(column('Team Red')).getByText('Hacker, Safecracker, Lookout: all held'),
    ).toBeInTheDocument();
    expect(
      within(column('Team Green')).getByText('3 roles for 2 players: each holds more than one'),
    ).toBeInTheDocument();
    const empty = within(column('Team Blue')).getByText('Empty team');
    expect(empty.className).toMatch(/text-warning-text/);
  });

  it('readiness is the connection state: "2 of 3 connected"', () => {
    draw(forming());
    expect(within(column('Team Red')).getByText('2 of 3 connected')).toBeInTheDocument();
  });

  it('Start needs a team with a member', () => {
    draw(forming({ teams: [blue] }));
    expect(screen.getByRole('button', { name: 'Start the game' })).toBeDisabled();
  });

  it('Start lists the warnings, and still starts', async () => {
    const { onStart } = draw(forming());
    fireEvent.click(screen.getByRole('button', { name: 'Start the game' }));
    const dialog = screen.getByRole('dialog', { name: 'Start anyway?' });
    expect(within(dialog).getByText('Empty teams: Team Blue')).toBeInTheDocument();
    expect(within(dialog).getByText('Offline players: Ben')).toBeInTheDocument();
    expect(within(dialog).getByText('Players without a team: 1')).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
  });

  it('Start with nothing to warn about starts at once', async () => {
    const ready = forming({
      teams: [{ ...red, members: red.members.map((m) => ({ ...m, connected: true })) }],
      unassigned: [],
    });
    const { onStart } = draw(ready);
    fireEvent.click(screen.getByRole('button', { name: 'Start the game' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('running: a late move is confirmed first (roles dealt again); no Start', async () => {
    const { onMove } = draw(forming({ board: boardOf({ phase: 'running' }) }));
    expect(screen.queryByRole('button', { name: 'Start the game' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move Ana to…' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Team Blue' }));
    const dialog = screen.getByRole('dialog', { name: 'Move Ana to Team Blue?' });
    expect(dialog).toHaveTextContent('The game is on: Ana’s roles are dealt again.');
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('p1', 't2'));
  });

  it('tap targets: chips, their menu and Start', () => {
    draw(forming());
    expect(screen.getByRole('button', { name: 'Drag Ana' }).className).toMatch(/min-h-11/);
    expect(screen.getByRole('button', { name: 'Move Ana to…' }).className).toMatch(/min-h-11/);
    expect(screen.getByRole('button', { name: 'Start the game' }).className).toMatch(/min-h-12/);
    fireEvent.click(screen.getByRole('button', { name: 'Move Ana to…' }));
    for (const item of screen.getAllByRole('menuitem')) expect(item.className).toMatch(/min-h-11/);
  });
});
