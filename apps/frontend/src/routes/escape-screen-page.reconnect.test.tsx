import type { EscapeBoard } from '@quiz-dock/contracts';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectGame } from '../game/game-client';
import { saveScreenRecord } from '../game/escape/screen/screen-record';
import { boardOf, GAME, screenFinaleOf, summaryOf } from '../game/escape/screen/screen-fixtures';
import { mockApi, renderApp } from '../test/harness';

/**
 * The big screen's recovery (M6 Task 6.16), with the real hooks and pages: only
 * `socket.io-client` and the Web Audio side are faked. Drops, reloads (a new page on
 * the same tab), the host leaving, a room closed meanwhile, and a quiz opened under
 * the screen. The screen never replays what it missed: the board it gets back is the
 * truth, and a finale it already replayed shows its standings at once.
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

const { sockets, acks, audio } = vi.hoisted(() => ({
  sockets: [] as unknown[],
  // The server's answer per event; `{ ok: true }` by default.
  acks: new Map<string, (payload: unknown) => unknown>(),
  // The page's audio: the unlock (lost with the page), and the tension bed's starts.
  audio: {
    unlocked: false,
    listeners: new Set<() => void>(),
    bed: [] as string[],
  },
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

vi.mock('../game/media/audio-unlock', async (orig) => {
  const { useSyncExternalStore } = await import('react');
  const set = (on: boolean) => {
    audio.unlocked = on;
    audio.listeners.forEach((l) => l());
  };
  return {
    ...(await orig<typeof import('../game/media/audio-unlock')>()),
    isAudioUnlocked: () => audio.unlocked,
    unlockAudio: () => {
      set(true);
      return Promise.resolve(true);
    },
    useAudioUnlocked: () =>
      useSyncExternalStore(
        (l) => {
          audio.listeners.add(l);
          return () => audio.listeners.delete(l);
        },
        () => audio.unlocked,
      ),
  };
});
vi.mock('../game/media/audio-mixer', async (orig) => {
  const ctx = {
    state: 'running',
    currentTime: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return {
    ...(await orig<typeof import('../game/media/audio-mixer')>()),
    getMixer: () => ({ ctx }),
    setRoomLevel: () => {},
  };
});
vi.mock('../game/escape/screen/tension-bed', () => ({
  startTensionBed: () => {
    audio.bed.push('start');
    return { setUrgent: () => {}, stop: () => audio.bed.push('stop') };
  },
}));

const PIN = '482913';
const MIN = 60_000;
const SOUNDS = {
  tick: true,
  gong: true,
  countdown: true,
  ding: true,
  tickUrl: null,
  gongUrl: null,
  dingUrl: null,
  countdownUrl: null,
  musicUrl: null,
  musicLevel: 0.5,
  sfxLevel: 0.8,
  musicMuted: false,
  sfxMuted: false,
  mediaLevel: 1,
  mediaMuted: false,
  muted: false,
};

const sock = () => sockets.at(-1) as FakeSocket;
const fire = (event: string, payload?: unknown) =>
  act(() =>
    sock()
      .listeners.get(event)
      ?.forEach((cb) => cb(payload)),
  );
const events = () =>
  sock()
    .emitted.map((e) => e.event)
    .filter((e) => e !== 'ping');
const joinAndSync = (from = 0) =>
  events()
    .slice(from)
    .filter((e) => e === 'spectator:join' || e === 'escape:sync');

const escapeRoom = { state: 'ESCAPE', questionIndex: -1, totalQuestions: 0 };
const lobbyRoom = { state: 'LOBBY', questionIndex: -1, totalQuestions: 0 };

/** Two teams racing, the run ending `left` ms from now (this device's clock is the server's). */
const running = (left = 20 * MIN, locks = 0): EscapeBoard => {
  const now = Date.now();
  return boardOf({
    clock: { serverNow: now, paused: false, elapsedMs: 0, limitMs: 45 * MIN },
    teams: [
      summaryOf({ locksSolved: locks, remainingMs: left, deadlineAt: now + left }),
      summaryOf({ id: 't2', name: 'Team Blue', remainingMs: left, deadlineAt: now + left }),
    ],
  });
};
const forming = () =>
  boardOf({
    phase: 'forming',
    teams: [summaryOf({ remainingMs: 45 * MIN, deadlineAt: null })],
    roster: [{ nickname: 'Zoé', teamId: null, connected: true }],
    unassigned: 1,
  });

/** A page load of the projection: the spectator joins, then (accepted) the escape sync. */
async function load() {
  mockApi([]);
  const page = renderApp(`/session/${PIN}/projection`);
  await waitFor(() => expect(events()).toContain('spectator:join'));
  return page;
}

/** As a reload: the old page, its socket and its audio unlock go; a new page starts. */
async function reload(page: { unmount: () => void }) {
  page.unmount();
  disconnectGame();
  audio.unlocked = false;
  return load();
}

/** The room as the sync gives it: its state, then the board. */
async function sync(board: EscapeBoard, room = escapeRoom) {
  await waitFor(() => expect(joinAndSync()).toEqual(['spectator:join', 'escape:sync']));
  fire('game:state', room);
  fire('room:sounds', SOUNDS);
  fire('escape:board', board);
}

const lane = (id: string) => document.querySelector<HTMLElement>(`[data-lane="${id}"]`);
const phase = () =>
  document.querySelector('[data-escape-phase]')?.getAttribute('data-escape-phase');

describe('escape big screen recovery', () => {
  beforeEach(() => {
    audio.unlocked = true;
    audio.bed.length = 0;
  });
  afterEach(() => {
    disconnectGame();
    sockets.length = 0;
    acks.clear();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('1. a drop while running: the banner, the race kept; back, a fresh board moves a lane', async () => {
    await load();
    await sync(running());
    await waitFor(() => expect(lane('t1')).toHaveTextContent('0/2'));

    fire('disconnect', 'transport close');
    expect(await screen.findByText(/Connexion perdue/)).toBeInTheDocument();
    expect(lane('t1')).toHaveTextContent('0/2');

    const before = events().length;
    act(() => sock().ioHandlers.get('reconnect')?.());
    fire('connect');
    await waitFor(() => expect(joinAndSync(before)).toEqual(['spectator:join', 'escape:sync']));
    expect(screen.queryByText(/Connexion perdue/)).toBeNull();
    // Meanwhile Team Red opened a lock: the new board says so.
    fire('escape:board', running(20 * MIN, 1));
    expect(lane('t1')).toHaveTextContent('1/2');
  });

  it('2. a reload while forming: the lobby comes back from the board', async () => {
    const page = await load();
    await sync(forming(), lobbyRoom);
    expect(await screen.findByText('Team Red')).toBeInTheDocument();
    expect(phase()).toBe('forming');

    await reload(page);
    await sync(forming(), lobbyRoom);
    expect(await screen.findByText('Team Red')).toBeInTheDocument();
    expect(screen.getByText('Zoé')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-pin')).toHaveTextContent(/482\s?913/);
  });

  it('3. a reload in the final minutes: the big countdown, and the music after the unlock click', async () => {
    const page = await load();
    await sync(running(4 * MIN));
    await waitFor(() => expect(screen.getByRole('timer')).toHaveAttribute('data-final', 'true'));
    expect(audio.bed).toEqual(['start']);

    await reload(page);
    await sync(running(4 * MIN));
    await waitFor(() => expect(screen.getByRole('timer')).toHaveAttribute('data-final', 'true'));
    // Audio cannot survive a reload: the screen asks again, and the music waits for it.
    const enable = await screen.findByRole('button', { name: /Activer le son/ });
    expect(audio.bed).toEqual(['start', 'stop']);
    fireEvent.click(enable);
    await waitFor(() => expect(audio.bed).toEqual(['start', 'stop', 'start']));
    expect(screen.queryByRole('button', { name: /Activer le son/ })).toBeNull();
  });

  it('4. a reload in the finale: the standings at once, no second replay', async () => {
    saveScreenRecord(PIN, { gameId: GAME, replayed: true, finale: screenFinaleOf() });
    await load();
    await sync(boardOf({ phase: 'finale' }), { ...escapeRoom, state: 'PODIUM' });
    fire('escape:screen-finale', screenFinaleOf());
    expect(await screen.findByTestId('podium')).toBeInTheDocument();
    expect(screen.queryByTestId('split-replay')).toBeNull();
  });

  it('4b. a reload while the replay plays: the finale comes back without replaying', async () => {
    const page = await load();
    await sync(running());
    fire('escape:board', boardOf({ phase: 'finale' }));
    fire('escape:screen-finale', screenFinaleOf());
    const clock = await screen.findByTestId('replay-clock');
    const start = clock.textContent;
    // Part of the race plays out, not all of it.
    await waitFor(() => expect(screen.getByTestId('replay-clock').textContent).not.toBe(start));
    expect(screen.queryByTestId('podium')).toBeNull();

    await reload(page);
    await sync(boardOf({ phase: 'finale' }), { ...escapeRoom, state: 'PODIUM' });
    fire('escape:screen-finale', screenFinaleOf());
    expect(await screen.findByTestId('podium')).toBeInTheDocument();
    expect(screen.queryByTestId('split-replay')).toBeNull();
  });

  it('5. "Show the finale again" on the console: a new screen finale replays', async () => {
    saveScreenRecord(PIN, { gameId: GAME, replayed: true, finale: screenFinaleOf() });
    await load();
    await sync(boardOf({ phase: 'finale' }), { ...escapeRoom, state: 'PODIUM' });
    fire('escape:screen-finale', screenFinaleOf());
    expect(await screen.findByTestId('podium')).toBeInTheDocument();
    // The host pushes the finale again from the console.
    fire('escape:screen-finale', screenFinaleOf());
    expect(await screen.findByTestId('split-replay')).toBeInTheDocument();
  });

  it('6. the host gone, then the run times out: the finale arrives and plays', async () => {
    await load();
    await sync(running());
    await waitFor(() => expect(lane('t1')).toBeInTheDocument());
    fire('game:state', { ...escapeRoom, state: 'HOST_DISCONNECTED' });
    expect(lane('t1')).toBeInTheDocument();
    expect(phase()).toBe('running');
    fire('escape:board', running(20 * MIN, 1));
    expect(lane('t1')).toHaveTextContent('1/2');

    fire('escape:board', boardOf({ phase: 'finale' }));
    fire('escape:screen-finale', screenFinaleOf());
    expect(await screen.findByTestId('split-replay')).toBeInTheDocument();
    expect(phase()).toBe('finale');
  });

  it('7. the room closed, then a reload: the join refused, the record shows the finale with thanks', async () => {
    saveScreenRecord(PIN, { gameId: GAME, replayed: true, finale: screenFinaleOf() });
    acks.set('spectator:join', () => ({ ok: false, error: { code: 'session.not_found' } }));
    await load();
    expect(await screen.findByTestId('podium')).toBeInTheDocument();
    expect(screen.getByText(/Merci d’avoir joué/)).toBeInTheDocument();
    expect(events()).not.toContain('escape:sync');
    // The room is gone: no sound to ask for.
    expect(screen.queryByRole('button', { name: /Activer le son/ })).toBeNull();
  });

  it("8. the room switches to a quiz: escape mode goes off, upstream's screen renders", async () => {
    await load();
    await sync(running());
    await waitFor(() => expect(phase()).toBe('running'));
    fire('game:state', { state: 'QUESTION_SHOW', questionIndex: 0, totalQuestions: 5 });
    await waitFor(() => expect(document.querySelector('[data-escape-phase]')).toBeNull());
    expect(document.querySelector('.qd-screen')).toHaveAttribute('data-state', 'QUESTION_SHOW');
  });
});
