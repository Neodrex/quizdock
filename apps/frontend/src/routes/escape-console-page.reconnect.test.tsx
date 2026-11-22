import type { EscapeHostState } from '@quiz-dock/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disconnectGame } from '../game/game-client';
import {
  boardOf,
  finaleOf,
  hostStateOf,
  hostTeamOf,
  outlineOf,
} from '../game/escape/host/host-fixtures';
import { saveHostRecord } from '../game/escape/host/host-record';
import { GAME } from '../game/escape/test-fixtures';
import { mockApi, renderApp } from '../test/harness';

/**
 * The host console's recovery (M5 Task 5.17), with the real hooks and pages: only
 * `socket.io-client` is faked. Drops, reloads (a new page on the same tab), rooms that
 * ended meanwhile, and a quiz opened under the console. The console never replays what
 * it missed: the state it gets back is the truth.
 */
interface FakeSocket {
  emitted: Array<{ event: string; payload: unknown }>;
  listeners: Map<string, Set<(p: unknown) => void>>;
  on: (e: string, cb: (p: unknown) => void) => void;
  once: () => void;
  off: (e: string, cb?: (p: unknown) => void) => void;
  emit: (e: string, payload: unknown, ack?: (r: unknown) => void) => void;
  disconnect: () => void;
  connected: boolean;
  io: { on: (e: string, cb: () => void) => void; off: () => void };
  ioHandlers: Map<string, () => void>;
}

const { sockets, acks } = vi.hoisted(() => ({
  sockets: [] as unknown[],
  // The server's answer per event; `{ ok: true }` by default, 'no-ack' for none at all.
  acks: new Map<string, (payload: unknown) => unknown>(),
}));

const makeSocket = (): FakeSocket => {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const ioHandlers = new Map<string, () => void>();
  return {
    emitted,
    listeners,
    ioHandlers,
    io: { on: (e, cb) => ioHandlers.set(e, cb), off: () => {} },
    connected: true,
    on: (e, cb) => {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(cb);
    },
    once: () => {},
    off: (e, cb) => {
      if (cb) listeners.get(e)?.delete(cb);
      else listeners.delete(e);
    },
    disconnect: () => {},
    emit: (e, payload, ack) => {
      emitted.push({ event: e, payload });
      if (typeof ack !== 'function') return;
      const res = acks.get(e)?.(payload) ?? { ok: true };
      if (res !== 'no-ack') ack(res);
    },
  };
};

vi.mock('socket.io-client', () => ({
  io: () => {
    const s = makeSocket();
    sockets.push(s);
    return s;
  },
}));

const PIN = '482913';

const sock = () => sockets.at(-1) as FakeSocket;
const fire = (event: string, payload?: unknown) =>
  act(() =>
    sock()
      .listeners.get(event)
      ?.forEach((cb) => cb(payload)),
  );
// The console's own requests (the clock's pings left out).
const events = () =>
  sock()
    .emitted.map((e) => e.event)
    .filter((e) => e !== 'ping');
const attachAndSync = (from = 0) =>
  events()
    .slice(from)
    .filter((e) => e === 'host:attach' || e === 'escape:sync');

const escapeRoom = { state: 'ESCAPE', questionIndex: -1, totalQuestions: 0 };
const lobbyRoom = { state: 'LOBBY', questionIndex: -1, totalQuestions: 0 };

const runningState = (over: Partial<EscapeHostState> = {}) =>
  hostStateOf({
    board: boardOf({ clock: { ...boardOf().clock, serverNow: Date.now() } }),
    ...over,
  });

/** A page load of the console: attach, then (accepted) the escape sync. */
async function load(path = '') {
  localStorage.setItem('live.localUser', 'Hôte');
  mockApi([]);
  const page = renderApp(`/session/${PIN}/console${path}`);
  await waitFor(() => expect(events()).toContain('host:attach'));
  return page;
}

/** As a reload: the old page and its socket go, a new page starts on the same tab. */
async function reload(page: { unmount: () => void }, path = '') {
  page.unmount();
  disconnectGame();
  return load(path);
}

/** The room as the sync sends it: its state, the host outline, then the host view. */
function sync(state: EscapeHostState, room = escapeRoom) {
  fire('game:state', room);
  fire('escape:outline', outlineOf());
  fire('escape:host', state);
}

const grid = () => screen.findByRole('heading', { name: 'Équipes en direct' });

describe('escape host console recovery', () => {
  afterEach(() => {
    disconnectGame();
    sockets.length = 0;
    acks.clear();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('1. a drop while running: banner, actions off, view kept; back, a fresh escape:host redraws the grid', async () => {
    await load();
    await waitFor(() => expect(attachAndSync()).toEqual(['host:attach', 'escape:sync']));
    sync(runningState());
    await grid();
    expect(screen.getAllByText('0/2 cadenas').length).toBeGreaterThan(0);

    fire('disconnect', 'transport close');
    expect(await screen.findByText(/Connexion perdue/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'Équipes en direct' })).toBeInTheDocument();

    const before = events().length;
    act(() => sock().ioHandlers.get('reconnect')?.());
    fire('connect');
    await waitFor(() => expect(attachAndSync(before)).toEqual(['host:attach', 'escape:sync']));
    // Meanwhile Team Red opened a lock: the new view says so, nothing is replayed.
    const moved = runningState({
      teams: [
        hostTeamOf({ locksSolved: 1, solved: ['lobby-door'] }),
        hostTeamOf({ id: 't2', name: 'Team Blue', members: [], memberCount: 0, connectedCount: 0 }),
      ],
    });
    fire('escape:host', moved);
    expect(await screen.findByText('1/2 cadenas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    const feed = screen.getByRole('list', { name: /Activité/ });
    expect(within(feed).getByText(/Reconnecté/)).toBeInTheDocument();
  });

  it('2. a reload while forming: the teams, the unassigned players and the formation mode come back', async () => {
    const forming = hostStateOf({
      board: boardOf({ phase: 'forming' }),
      formation: { mode: 'self', maxSize: null, teams: [] },
      unassigned: [{ playerId: 'p9', nickname: 'Zoé', connected: true }],
    });
    const page = await load();
    sync(forming, lobbyRoom);
    await screen.findByRole('heading', { name: 'Équipes de la salle' });

    await reload(page);
    await waitFor(() => expect(attachAndSync()).toEqual(['host:attach', 'escape:sync']));
    sync(forming, lobbyRoom);
    const board = await screen.findByRole('heading', { name: 'Équipes de la salle' });
    expect(board.closest('section')!).toHaveTextContent('Zoé');
    expect(screen.getByRole('heading', { name: 'Team Red' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Les joueurs choisissent' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('3. a reload while running: the picked team from ?team=, and the feed from sessionStorage', async () => {
    const page = await load('?team=t1');
    sync(runningState());
    await grid();
    fire('escape:team-update', { teamId: 't1', kind: 'time', deltaMs: 120_000 });
    const feed = () => screen.getByRole('list', { name: /Activité/ });
    await waitFor(() => expect(within(feed()).getAllByRole('listitem')).toHaveLength(1));
    const line = within(feed()).getByRole('listitem').textContent!;

    await reload(page, '?team=t1');
    sync(runningState());
    await grid();
    const detail = await screen
      .findByRole('dialog', { name: 'Team Red' })
      .catch(() => screen.findByRole('complementary', { name: 'Team Red' }));
    expect(detail).toBeInTheDocument();
    const items = within(feed()).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(
      expect.arrayContaining([line, expect.stringMatching(/Reconnecté/)]),
    );
  });

  it('3b. a reload while paused: the paused badge and an enabled Resume after the re-sync', async () => {
    const paused = () =>
      runningState({
        board: boardOf({ clock: { ...boardOf().clock, serverNow: Date.now(), paused: true } }),
      });
    const page = await load();
    sync(paused());
    await grid();
    expect(screen.getByText('En pause')).toBeInTheDocument();

    await reload(page);
    await waitFor(() => expect(attachAndSync()).toEqual(['host:attach', 'escape:sync']));
    sync(paused());
    await grid();
    expect(screen.getByText('En pause')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprendre' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('4. a reload in the finale: no finale replayed, so the results by the room', async () => {
    acks.set('escape:results', () => ({ ok: true, finale: finaleOf() }));
    await load();
    sync(hostStateOf({ board: boardOf({ phase: 'finale' }) }), { ...escapeRoom, state: 'PODIUM' });
    expect(await screen.findByRole('button', { name: 'Télécharger le CSV' })).toBeInTheDocument();
    expect(sock().emitted.find((e) => e.event === 'escape:results')?.payload).toEqual({
      gameId: GAME,
    });
    // The room is open: its actions are there.
    expect(screen.getByRole('button', { name: 'Remontrer le final' })).toBeInTheDocument();
  });

  it('5. a reload after the room closed: attach refused, the host record gives read-only results', async () => {
    saveHostRecord({ pin: PIN, gameId: GAME });
    acks.set('host:attach', () => ({ ok: false, error: { code: 'session.not_found' } }));
    acks.set('escape:results', () => ({ ok: true, finale: finaleOf() }));
    await load();
    expect(await screen.findByRole('button', { name: 'Télécharger le CSV' })).toBeInTheDocument();
    expect(sock().emitted.find((e) => e.event === 'escape:results')?.payload).toEqual({
      gameId: GAME,
    });
    expect(screen.getByText('Salon fermé')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remontrer le final' })).toBeNull();
    expect(events()).not.toContain('escape:sync');
  });

  it('6. a quiz opened under the console: escape mode goes off, the quiz console renders', async () => {
    await load();
    sync(runningState());
    await grid();
    fire('game:state', { state: 'QUESTION', questionIndex: 0, totalQuestions: 5 });
    await waitFor(() => expect(document.querySelector('[data-escape-phase]')).toBeNull());
    expect(document.querySelector('.qd-console')).toHaveAttribute('data-state', 'QUESTION');
    expect(screen.queryByRole('heading', { name: 'Équipes en direct' })).toBeNull();
  });
});
