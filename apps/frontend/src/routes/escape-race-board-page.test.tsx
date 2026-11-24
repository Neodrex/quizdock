import type { EscapeBoard, EscapeBoardSession } from '@quiz-dock/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectGame } from '../game/game-client';
import { boardOf, screenFinaleOf, summaryOf } from '../game/escape/screen/screen-fixtures';
import { mockApi, renderApp } from '../test/harness';

/**
 * The public race board (M7 Task 7.18) on the real hooks and page; only the transport
 * and the Web Audio side are faked. Below, the M6 screen recovery's fakes, reused:
 * (M6 Task 6.16), with the real hooks and pages: only
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

const sock = () => sockets.at(-1) as FakeSocket;
const fire = (event: string, payload?: unknown) =>
  act(() =>
    sock()
      .listeners.get(event)
      ?.forEach((cb) => cb(payload)),
  );
const emitted = (event: string) => sock().emitted.filter((e) => e.event === event);

const escapeRoom = { state: 'ESCAPE', questionIndex: -1, totalQuestions: 0 };
const lobbyRoom = { state: 'LOBBY', questionIndex: -1, totalQuestions: 0 };

const raceOf = (over: Partial<EscapeBoardSession> = {}): EscapeBoardSession => ({
  type: 'race',
  startsAt: null,
  totals: { teams: 42, players: 44, escaped: 0, playing: 42, latest: null },
  ...over,
});

/** The leaders of a 42-team race, place-ordered by the server (here: by locks). */
const leaders = (n: number): EscapeBoard => {
  const now = Date.now();
  return boardOf({
    session: raceOf(),
    clock: { serverNow: now, paused: false, elapsedMs: 0, limitMs: 45 * MIN },
    teams: Array.from({ length: n }, (_, i) =>
      summaryOf({
        id: `t${i + 1}`,
        name: `Team ${i + 1}`,
        // Board order is not the place order: Team 2 leads.
        locksSolved: i === 1 ? 2 : i === 0 ? 1 : 0,
        remainingMs: 20 * MIN,
        deadlineAt: now + 20 * MIN,
      }),
    ),
  });
};

async function load(path = `/race/${PIN}`) {
  mockApi([]);
  const page = renderApp(path);
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  await waitFor(() => expect(emitted('spectator:join')).toHaveLength(1));
  return page;
}
async function sync(board: EscapeBoard, room = escapeRoom) {
  await waitFor(() => expect(emitted('escape:sync')).toHaveLength(1));
  fire('game:state', room);
  fire('escape:board', board);
}

describe('/race/$pin, the public race board', () => {
  beforeEach(() => {
    audio.unlocked = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    disconnectGame();
    sockets.length = 0;
    acks.clear();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('needs no sign-in, joins as a follow copy: no pairing code, no sound to unlock', async () => {
    acks.set('spectator:join', () => ({ ok: true, pairingCode: 'NEVER' }));
    await load();
    expect(emitted('spectator:join')[0].payload).toEqual({
      pin: PIN,
      follow: true,
      screen: undefined,
    });
    await sync(boardOf({ phase: 'forming', session: raceOf() }), lobbyRoom);
    expect(await screen.findByTestId('race-lobby')).toBeInTheDocument();
    expect(screen.queryByText('NEVER')).toBeNull();
    expect(screen.queryByLabelText('Votre nom')).toBeNull();
    expect(screen.queryByRole('button', { name: /son|sound/i })).toBeNull();
  });

  it('a race the host stopped: the board drops it and waits, then shows the next one', async () => {
    await load();
    const board = boardOf({ phase: 'running', session: raceOf() });
    await sync(board);
    await waitFor(() => expect(screen.queryByTestId('race-board-notice')).toBeNull());
    fire('escape:closed', { gameId: board.gameId });
    fire('game:state', lobbyRoom);
    const notice = await screen.findByTestId('race-board-notice');
    expect(notice.querySelector('.motion-safe\\:animate-spin')).toBeNull();
    expect(notice.textContent).not.toBe('');
    fire('escape:board', boardOf({ gameId: 'a'.repeat(32), phase: 'forming', session: raceOf() }));
    expect(await screen.findByTestId('race-lobby')).toBeInTheDocument();
  });

  it('?sound=1 offers the sound', async () => {
    await load(`/race/${PIN}?sound=1`);
    await sync(boardOf({ phase: 'forming', session: raceOf() }), lobbyRoom);
    await screen.findByTestId('race-lobby');
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('lobby: the title, the countdown, the joined count, the PIN and the QR', async () => {
    await load();
    const startsAt = Date.now() + 5 * MIN;
    await sync(
      boardOf({ phase: 'forming', session: raceOf({ startsAt }), title: 'Lost Library' }),
      lobbyRoom,
    );
    expect(await screen.findByRole('heading', { name: 'Lost Library' })).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/^Départ dans [45]:\d\d$/);
    expect(screen.getByText('44 joueurs dans la salle')).toBeInTheDocument();
    expect(screen.getByTestId('lobby-pin')).toHaveTextContent(PIN);
    expect(screen.getByLabelText(/QR/)).toBeInTheDocument();
    // 500 strangers: no team cards, no names.
    expect(screen.queryByRole('list', { name: 'Équipes' })).toBeNull();
  });

  it('running: the leaders by place, the rest counted from the totals, the show clock', async () => {
    await load();
    await sync(leaders(30));
    await waitFor(() => expect(document.querySelectorAll('[data-lane]')).toHaveLength(30));
    const lanes = [...document.querySelectorAll<HTMLElement>('[data-lane]')].map(
      (l) => l.dataset.lane,
    );
    expect(lanes.slice(0, 2)).toEqual(['t2', 't1']);
    expect(document.querySelector('[data-more-teams]')).toHaveTextContent('et 12 autres équipes');
    expect(screen.getAllByRole('timer').length).toBeGreaterThan(0);
  });

  it('finale: the screen finale', async () => {
    await load();
    await sync(leaders(3));
    fire('escape:screen-finale', screenFinaleOf({ totalTeams: 42 }));
    await waitFor(() =>
      expect(document.querySelector('[data-escape-phase]')).toHaveAttribute(
        'data-escape-phase',
        'finale',
      ),
    );
  });

  it('a room that is not a race: "This board is for races", no board', async () => {
    await load();
    await sync(
      boardOf({
        phase: 'forming',
        session: {
          type: 'hosted',
          startsAt: null,
          totals: { teams: 1, players: 1, escaped: 0, playing: 1, latest: null },
        },
      }),
      lobbyRoom,
    );
    expect(await screen.findByText('Ce tableau est réservé aux courses')).toBeInTheDocument();
    expect(document.querySelector('[data-escape-phase]')).toBeNull();
    expect(screen.queryByTestId('lobby-pin')).toBeNull();
  });

  it('a room before session types is no race either', async () => {
    await load();
    await sync(boardOf({ phase: 'forming', session: null }), lobbyRoom);
    expect(await screen.findByText('Ce tableau est réservé aux courses')).toBeInTheDocument();
  });

  it('never scrolls: the frame fills the window and hides overflow (360 px and 1920 px)', async () => {
    for (const width of [360, 1920]) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      const page = await load();
      await sync(leaders(30));
      const frame = await waitFor(() => {
        const el = document.querySelector<HTMLElement>('[data-escape-phase]');
        expect(el).not.toBeNull();
        return el!;
      });
      expect(frame.className).toMatch(/\bh-dvh\b/);
      expect(frame.className).toMatch(/\boverflow-hidden\b/);
      page.unmount();
      disconnectGame();
      sockets.length = 0;
    }
    const page = await load();
    await sync(
      boardOf({
        phase: 'forming',
        session: {
          type: 'group',
          startsAt: null,
          totals: { teams: 0, players: 0, escaped: 0, playing: 0, latest: null },
        },
      }),
      lobbyRoom,
    );
    const notice = await screen.findByTestId('race-board-notice');
    expect(notice.className).toMatch(/\bh-dvh\b/);
    expect(notice.className).toMatch(/\boverflow-hidden\b/);
    page.unmount();
  });
});
