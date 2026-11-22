import type { EscapeFinale, EscapePlayerState } from '@quiz-dock/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disconnectGame } from '../game/game-client';
import { loadEscapeRecord, saveEscapeRecord } from '../game/escape/escape-record';
import { SYNC_RETRY_MS } from '../game/escape/use-escape-session';
import { renderApp } from '../test/harness';

/**
 * A phone's recovery, with the real hooks and pages: only `socket.io-client` is faked.
 * Drops, reloads (a new page on the stored session), and rooms that ended meanwhile.
 * The phone never replays what it missed: the state it gets back is the truth.
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
const GAME = '0123456789abcdef0123456789abcdef';
const ME = 'p-me';

const sock = () => sockets.at(-1) as FakeSocket;
const fire = (event: string, payload?: unknown) =>
  act(() =>
    sock()
      .listeners.get(event)
      ?.forEach((cb) => cb(payload)),
  );
// The session's own requests (the clock's pings left out).
const events = () =>
  sock()
    .emitted.map((e) => e.event)
    .filter((e) => e !== 'ping');
const attachAndSync = (from = 0) =>
  events()
    .slice(from)
    .filter((e) => e === 'player:reconnect' || e === 'escape:sync');

const stage = (index: number, roles = ['lookout']): EscapePlayerState => ({
  gameId: GAME,
  phase: 'running',
  clock: { serverNow: Date.now(), paused: false, elapsedMs: 60_000, limitMs: 3_600_000 },
  title: 'Vault Heist',
  intro: '',
  roles: [
    { id: 'lookout', name: 'Guetteur', description: 'Surveille les gardes.' },
    { id: 'safe', name: 'Perceur', description: 'Ouvre le coffre.' },
  ],
  formation: { mode: 'auto', maxSize: 4, teams: [] },
  team: {
    id: 't1',
    name: 'Renards',
    members: [{ playerId: ME, nickname: 'Ana', avatar: null, connected: true, roles }],
    stageIndex: index,
    stageCount: 3,
    escaped: false,
    timedOut: false,
    hintPenaltyS: 0,
    remainingMs: 600_000,
    deadlineAt: Date.now() + 600_000,
  },
  view: {
    stageIndex: index,
    stageCount: 3,
    title: index === 0 ? 'La porte du coffre' : 'La salle des archives',
    intro: '',
    roles,
    clues: [],
    locks: [{ id: `pad${index}`, label: 'Clavier', kind: 'code', solved: false }],
    hints: [],
    escaped: false,
  },
  nextHint: null,
});

const finale: EscapeFinale = {
  gameId: GAME,
  title: 'Résultats du casse',
  finale: 'Bien joué.',
  ranking: [
    {
      teamId: 't1',
      name: 'Renards',
      place: 1,
      scoreMs: 1_200_000,
      escaped: true,
      stagesCleared: 3,
      stageClearedAt: [],
      hintsUsed: 0,
      paidHints: 0,
      hintPenaltyS: 0,
      adjustMs: 0,
      hostUnlocks: 0,
      members: ['Ana'],
    },
  ],
  awards: { fastest: 't1', fewestHints: null, teamwork: null, photoFinish: null },
};

const escapeRoom = { state: 'ESCAPE', questionIndex: -1, totalQuestions: 0 };

function storeSession(token = 'tok') {
  localStorage.setItem(
    'live.session',
    JSON.stringify({ pin: PIN, sessionToken: token, playerId: ME, nickname: 'Ana' }),
  );
}

/** A page load on the stored session: reconnect, then the room's state and the sync. */
async function load() {
  const page = renderApp(`/join/${PIN}`);
  await waitFor(() => expect(events()).toContain('player:reconnect'));
  return page;
}

/** As a reload: the old page and its socket go, a new page starts from storage. */
async function reload(page: { unmount: () => void }) {
  page.unmount();
  disconnectGame();
  return load();
}

const codeInput = () => screen.getByRole('textbox', { name: 'Réponse pour Clavier' });

describe('escape phone recovery', () => {
  afterEach(() => {
    disconnectGame();
    sockets.length = 0;
    acks.clear();
    localStorage.clear();
    vi.useRealTimers();
  });

  it('1. a drop mid-stage: banner, inputs off, draft kept; back, a fresh state shows the new stage', async () => {
    storeSession();
    await load();
    await waitFor(() => expect(events()).toContain('escape:sync'));
    fire('game:state', escapeRoom);
    fire('escape:state', stage(0));
    expect(await screen.findByRole('heading', { name: 'La porte du coffre' })).toBeInTheDocument();
    fireEvent.change(codeInput(), { target: { value: '12' } });
    expect(attachAndSync()).toEqual(['player:reconnect', 'escape:sync']);

    fire('disconnect', 'transport close');
    expect(await screen.findByText(/Connexion perdue/)).toBeInTheDocument();
    expect(codeInput()).toBeDisabled();
    expect(codeInput()).toHaveValue('12');

    const before = events().length;
    act(() => sock().ioHandlers.get('reconnect')?.());
    fire('connect');
    await waitFor(() => expect(attachAndSync(before)).toEqual(['player:reconnect', 'escape:sync']));
    expect(codeInput()).toHaveValue('12');
    // Meanwhile the team moved on: the state says so, with no unlock moment replayed.
    fire('escape:state', stage(1));
    expect(
      await screen.findByRole('heading', { name: 'La salle des archives' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('unlock-moment')).toBeNull();
  });

  it('2. a reload while running: the record is kept, the same stage shows, the timer runs on its deadline', async () => {
    storeSession();
    const page = await load();
    fire('game:state', escapeRoom);
    fire('escape:state', stage(0));
    await screen.findByRole('heading', { name: 'La porte du coffre' });
    expect(loadEscapeRecord(PIN)).toMatchObject({
      gameId: GAME,
      sessionToken: 'tok',
      teamId: 't1',
    });

    await reload(page);
    await waitFor(() => expect(attachAndSync()).toEqual(['player:reconnect', 'escape:sync']));
    fire('game:state', escapeRoom);
    fire('escape:state', stage(0));
    expect(await screen.findByRole('heading', { name: 'La porte du coffre' })).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/^(9:5\d|10:00)/);
    expect(screen.queryByPlaceholderText('Votre pseudo')).toBeNull();
  });

  it('3. a reload in the finale phase: the results by token, then the finale', async () => {
    storeSession();
    acks.set('escape:results', () => ({ ok: true, finale }));
    await load();
    fire('game:state', escapeRoom);
    fire('escape:state', { ...stage(2), phase: 'finale' });
    expect(await screen.findByRole('heading', { name: 'Résultats du casse' })).toBeInTheDocument();
    expect(sock().emitted.find((e) => e.event === 'escape:results')?.payload).toEqual({
      gameId: GAME,
      sessionToken: 'tok',
    });
    expect(screen.getByRole('listitem', { current: true })).toHaveTextContent('Renards');
  });

  it('4. a reload after the room ended: the reconnect is refused, the record gives the finale', async () => {
    storeSession('old');
    saveEscapeRecord({ pin: PIN, gameId: GAME, playerId: ME, sessionToken: 'old', teamId: 't1' });
    acks.set('player:reconnect', () => ({ ok: false, error: { code: 'session.not_found' } }));
    acks.set('escape:results', () => ({ ok: true, finale }));
    await load();
    expect(await screen.findByRole('heading', { name: 'Résultats du casse' })).toBeInTheDocument();
    expect(sock().emitted.find((e) => e.event === 'escape:results')?.payload).toEqual({
      gameId: GAME,
      sessionToken: 'old',
    });
    expect(screen.getByText('La salle est fermée')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { current: true })).toHaveTextContent('Renards');
    expect(screen.queryByPlaceholderText('Votre pseudo')).toBeNull();
  });

  it('4b. the same, but no results: the record is cleared and the nickname form shows', async () => {
    storeSession('old');
    saveEscapeRecord({ pin: PIN, gameId: GAME, playerId: ME, sessionToken: 'old', teamId: 't1' });
    acks.set('player:reconnect', () => ({ ok: false, error: { code: 'session.not_found' } }));
    acks.set('escape:results', () => ({ ok: false, error: { code: 'escape.not_found' } }));
    await load();
    expect(await screen.findByPlaceholderText('Votre pseudo')).toBeInTheDocument();
    expect(loadEscapeRecord(PIN)).toBeNull();
  });

  it('5. roles moved while away: the new role card, and it is said', async () => {
    storeSession();
    await load();
    fire('game:state', escapeRoom);
    fire('escape:state', stage(0, ['lookout']));
    expect(await screen.findByText('Guetteur')).toBeInTheDocument();
    fire('escape:team-update', { teamId: 't1', kind: 'roles' });
    fire('escape:state', stage(0, ['safe']));
    expect(await screen.findByText('Perceur')).toBeInTheDocument();
    expect(screen.queryByText('Guetteur')).toBeNull();
    expect(await screen.findByText('Votre rôle a changé : Perceur')).toBeInTheDocument();
  });

  it('6. a sync with no answer is sent again, until a state comes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    storeSession();
    acks.set('escape:sync', () => 'no-ack');
    await load();
    await waitFor(() => expect(events().filter((e) => e === 'escape:sync')).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(8_000 + SYNC_RETRY_MS));
    expect(events().filter((e) => e === 'escape:sync')).toHaveLength(2);
    fire('game:state', escapeRoom);
    fire('escape:state', stage(0));
    expect(await screen.findByRole('heading', { name: 'La porte du coffre' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3 * (8_000 + SYNC_RETRY_MS)));
    expect(events().filter((e) => e === 'escape:sync')).toHaveLength(2);
  });
});
