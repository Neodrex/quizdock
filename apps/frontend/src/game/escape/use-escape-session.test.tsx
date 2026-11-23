import type { EscapeFinale, EscapePlayerState } from '@quiz-dock/contracts';
import { GameState } from '@quiz-dock/contracts';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake socket that holds several listeners per event, as socket.io does.
const { fakeSocket, listeners, emitted, acks } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  // The server's answer per event; ok by default.
  const acks = new Map<string, (payload: unknown) => unknown>();
  return {
    listeners,
    emitted,
    acks,
    fakeSocket: {
      connected: true,
      on: (e: string, cb: (p: unknown) => void) => {
        if (!listeners.has(e)) listeners.set(e, new Set());
        listeners.get(e)!.add(cb);
      },
      off: (e: string, cb: (p: unknown) => void) => {
        listeners.get(e)?.delete(cb);
        if (listeners.get(e)?.size === 0) listeners.delete(e);
      },
      emit: (e: string, payload: unknown, ack?: (r: unknown) => void) => {
        emitted.push({ event: e, payload });
        const res = acks.get(e)?.(payload) ?? { ok: true };
        // A server that never answers: the client's ack timeout runs out.
        if (res !== 'no-ack') ack?.(res);
      },
    },
  };
});

const loadPlayerSession = vi.fn();

vi.mock('../game-client', async (orig) => ({
  ...(await orig<typeof import('../game-client')>()),
  ensureGameSocket: () => Promise.resolve(fakeSocket),
  loadPlayerSession: () => loadPlayerSession(),
}));

// The real record, its reads counted.
vi.mock('./escape-record', async (orig) => {
  const real = await orig<typeof import('./escape-record')>();
  return { ...real, loadEscapeRecord: vi.fn(real.loadEscapeRecord) };
});

import { loadEscapeRecord, saveEscapeRecord } from './escape-record';
import {
  FINALE_GRACE_MS,
  SYNC_RETRY_MS,
  type EscapeSessionSeam,
  useEscapeSession,
} from './use-escape-session';

const PIN = '482913';
const GAME = '0123456789abcdef0123456789abcdef';

const state = (over: Partial<EscapePlayerState> = {}): EscapePlayerState => ({
  gameId: GAME,
  session: null,
  phase: 'running',
  clock: { serverNow: 0, paused: false, elapsedMs: 0, limitMs: 60_000 },
  title: 'Vault Heist',
  intro: '',
  roles: [],
  formation: { mode: 'auto', maxSize: null, teams: [] },
  team: {
    id: 't1',
    name: 'Owls',
    members: [],
    stageIndex: 0,
    stageCount: 1,
    escaped: false,
    escapedMs: null,
    timedOut: false,
    hintPenaltyS: 0,
    remainingMs: 60_000,
    deadlineAt: 60_000,
  },
  view: null,
  nextHint: null,
  ...over,
});

const finale: EscapeFinale = {
  gameId: GAME,
  title: 'Vault Heist',
  finale: 'Well done.',
  ranking: [],
  awards: { fastest: null, fewestHints: null, teamwork: null, photoFinish: null },
};

const seam = (over: Partial<EscapeSessionSeam> = {}): EscapeSessionSeam => ({
  view: { status: 'ready', state: GameState.Lobby, totalQuestions: 0 },
  attachSeq: 0,
  ...over,
});

const fire = (event: string, payload?: unknown) =>
  act(() => listeners.get(event)?.forEach((cb) => cb(payload)));
const flush = () => act(async () => {});
const sent = (event: string) => emitted.filter((e) => e.event === event);

function mount(initial = seam()) {
  return renderHook((s: EscapeSessionSeam) => useEscapeSession(PIN, s), { initialProps: initial });
}

describe('useEscapeSession', () => {
  beforeEach(() => {
    loadPlayerSession.mockReturnValue({
      pin: PIN,
      sessionToken: 'tok',
      playerId: 'p1',
      nickname: 'Ana',
    });
  });
  afterEach(() => {
    fakeSocket.connected = true;
    listeners.clear();
    emitted.length = 0;
    acks.clear();
    localStorage.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('syncs only once attached, once per attach', async () => {
    const { rerender } = mount();
    await flush();
    expect(sent('escape:sync')).toHaveLength(0);
    rerender(seam({ attachSeq: 1 }));
    await flush();
    expect(sent('escape:sync')).toEqual([{ event: 'escape:sync', payload: { pin: PIN } }]);
    rerender(seam({ attachSeq: 2 })); // a reconnect
    await flush();
    expect(sent('escape:sync')).toHaveLength(2);
  });

  it('a sync ack turns escape mode on; escape.not_found keeps it off until the next attach', async () => {
    const { result, rerender } = mount(seam({ attachSeq: 1 }));
    await flush();
    expect(result.current.active).toBe(true);

    acks.set('escape:sync', () => ({ ok: false, error: { code: 'escape.not_found' } }));
    rerender(seam({ attachSeq: 2 }));
    await flush();
    expect(result.current.active).toBe(false);
    rerender(
      seam({ attachSeq: 2, view: { status: 'ready', state: GameState.Lobby, totalQuestions: 0 } }),
    );
    await flush();
    expect(sent('escape:sync')).toHaveLength(2);
  });

  describe('a sync that times out (no ack)', () => {
    const ACK_TIMEOUT_MS = 8_000;

    it('is sent again, until it is answered', async () => {
      vi.useFakeTimers();
      acks.set('escape:sync', () => 'no-ack');
      const { result } = mount(seam({ attachSeq: 1 }));
      await flush();
      expect(sent('escape:sync')).toHaveLength(1);
      await act(() => vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + SYNC_RETRY_MS));
      expect(sent('escape:sync')).toHaveLength(2);
      acks.delete('escape:sync');
      await act(() => vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + SYNC_RETRY_MS));
      expect(sent('escape:sync')).toHaveLength(3);
      expect(result.current.active).toBe(true);
      await act(() => vi.advanceTimersByTimeAsync(5 * (ACK_TIMEOUT_MS + SYNC_RETRY_MS)));
      expect(sent('escape:sync')).toHaveLength(3);
    });

    it('stops once a state arrives', async () => {
      vi.useFakeTimers();
      acks.set('escape:sync', () => 'no-ack');
      mount(seam({ attachSeq: 1 }));
      await flush();
      fire('escape:state', state());
      await act(() => vi.advanceTimersByTimeAsync(3 * (ACK_TIMEOUT_MS + SYNC_RETRY_MS)));
      expect(sent('escape:sync')).toHaveLength(1);
    });

    it('stops at the next attach, which syncs on its own', async () => {
      vi.useFakeTimers();
      acks.set('escape:sync', () => 'no-ack');
      const { rerender, unmount } = mount(seam({ attachSeq: 1 }));
      await flush();
      await act(() => vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS));
      rerender(seam({ attachSeq: 2 }));
      await flush();
      expect(sent('escape:sync')).toHaveLength(2);
      unmount();
      await act(() => vi.advanceTimersByTimeAsync(3 * (ACK_TIMEOUT_MS + SYNC_RETRY_MS)));
      expect(sent('escape:sync')).toHaveLength(2);
    });

    it('with the socket down at the timeout, waits for the next attach (never ahead of the reconnect)', async () => {
      vi.useFakeTimers();
      acks.set('escape:sync', () => 'no-ack');
      const { rerender } = mount(seam({ attachSeq: 1 }));
      await flush();
      expect(sent('escape:sync')).toHaveLength(1);
      fakeSocket.connected = false;
      await act(() => vi.advanceTimersByTimeAsync(3 * (ACK_TIMEOUT_MS + SYNC_RETRY_MS)));
      expect(sent('escape:sync')).toHaveLength(1);
      // The socket is back, but the player is not attached again yet.
      fakeSocket.connected = true;
      await act(() => vi.advanceTimersByTimeAsync(3 * (ACK_TIMEOUT_MS + SYNC_RETRY_MS)));
      expect(sent('escape:sync')).toHaveLength(1);
      acks.delete('escape:sync');
      rerender(seam({ attachSeq: 2 })); // player:reconnect accepted
      await flush();
      expect(sent('escape:sync')).toHaveLength(2);
    });

    it('a retry due while the socket is down is not sent', async () => {
      vi.useFakeTimers();
      acks.set('escape:sync', () => 'no-ack');
      mount(seam({ attachSeq: 1 }));
      await flush();
      await act(() => vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS));
      fakeSocket.connected = false; // dropped between the timeout and the retry
      await act(() => vi.advanceTimersByTimeAsync(3 * (ACK_TIMEOUT_MS + SYNC_RETRY_MS)));
      expect(sent('escape:sync')).toHaveLength(1);
    });

    it('a refusal is not retried', async () => {
      vi.useFakeTimers();
      acks.set('escape:sync', () => ({ ok: false, error: { code: 'escape.not_found' } }));
      mount(seam({ attachSeq: 1 }));
      await flush();
      await act(() => vi.advanceTimersByTimeAsync(3 * (ACK_TIMEOUT_MS + SYNC_RETRY_MS)));
      expect(sent('escape:sync')).toHaveLength(1);
    });
  });

  describe('the record lookup with no session', () => {
    const noSession = (attachSeq = 0) =>
      seam({ attachSeq, view: { status: 'no-session', state: null, totalQuestions: 0 } });

    it('checks the record first: the finale, final, and the check is over', async () => {
      saveEscapeRecord({
        pin: PIN,
        gameId: GAME,
        playerId: 'p1',
        sessionToken: 'old',
        teamId: 't1',
      });
      acks.set('escape:results', () => ({ ok: true, finale }));
      const { result } = mount(noSession());
      expect(result.current.checkingRecord).toBe(true);
      await flush();
      expect(result.current.checkingRecord).toBe(false);
      expect(result.current.ui.finale).toEqual(finale);
      expect(result.current.ui.ended).toBe('final');
    });

    it('without a record there is nothing to check', () => {
      const { result } = mount(noSession());
      expect(result.current.checkingRecord).toBe(false);
    });

    it('does not read the storage on each render while it checks', async () => {
      saveEscapeRecord({
        pin: PIN,
        gameId: GAME,
        playerId: 'p1',
        sessionToken: 'old',
        teamId: 't1',
      });
      acks.set('escape:results', () => 'no-ack'); // the check stays open
      const { result, rerender } = mount(noSession());
      await flush();
      expect(result.current.checkingRecord).toBe(true);
      vi.mocked(loadEscapeRecord).mockClear();
      for (let i = 0; i < 5; i++) rerender(noSession());
      expect(loadEscapeRecord).not.toHaveBeenCalled();
      expect(result.current.checkingRecord).toBe(true);
    });
  });

  it('rejoining the same team with a new token saves the record again', async () => {
    const { rerender } = mount(seam({ attachSeq: 1 }));
    await flush();
    fire('escape:state', state());
    expect(loadEscapeRecord(PIN)?.sessionToken).toBe('tok');
    // A fresh join (the record of the old token is cleared), back into the same team.
    loadPlayerSession.mockReturnValue({
      pin: PIN,
      sessionToken: 'tok2',
      playerId: 'p1',
      nickname: 'Ana',
    });
    rerender(seam({ attachSeq: 2 }));
    await flush();
    expect(loadEscapeRecord(PIN)).toBeNull();
    fire('escape:state', state());
    expect(loadEscapeRecord(PIN)).toMatchObject({ sessionToken: 'tok2', teamId: 't1' });
  });

  it('an unasked escape:state turns it on and keeps the record', async () => {
    const { result } = mount();
    await flush();
    fire('escape:state', state());
    expect(result.current.active).toBe(true);
    expect(result.current.ui.state?.gameId).toBe(GAME);
    expect(loadEscapeRecord(PIN)).toMatchObject({
      pin: PIN,
      gameId: GAME,
      playerId: 'p1',
      sessionToken: 'tok',
      teamId: 't1',
    });
  });

  it('a quiz in the room turns it off', async () => {
    const { result, rerender } = mount();
    await flush();
    fire('escape:state', state());
    rerender(seam({ view: { status: 'ready', state: GameState.Lobby, totalQuestions: 5 } }));
    expect(result.current.active).toBe(false);
    fire('escape:state', state());
    expect(result.current.active).toBe(true);
    rerender(seam({ view: { status: 'ready', state: GameState.Answering, totalQuestions: 0 } }));
    expect(result.current.active).toBe(false);
  });

  describe('game:ended before the finale', () => {
    it('waits, then fetches the results with the token and shows them', async () => {
      vi.useFakeTimers();
      acks.set('escape:results', () => ({ ok: true, finale }));
      const { result } = mount();
      await flush();
      fire('escape:state', state());
      fire('game:ended', { quizId: null, feedbackEnabled: false });
      expect(result.current.ui.ended).toBe('waiting');
      await act(() => vi.advanceTimersByTimeAsync(FINALE_GRACE_MS - 1));
      expect(sent('escape:results')).toHaveLength(0);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(sent('escape:results')).toEqual([
        { event: 'escape:results', payload: { gameId: GAME, sessionToken: 'tok' } },
      ]);
      expect(result.current.ui).toMatchObject({ ended: 'final', finale });
    });

    it('a refusal ends on the plain screen', async () => {
      vi.useFakeTimers();
      acks.set('escape:results', () => ({ ok: false, error: { code: 'escape.not_in_room' } }));
      const { result } = mount();
      await flush();
      fire('escape:state', state());
      fire('game:ended', {});
      await act(() => vi.advanceTimersByTimeAsync(FINALE_GRACE_MS));
      expect(result.current.ui).toMatchObject({ ended: 'final', finale: null });
    });

    it('the finale arriving in time needs no fetch', async () => {
      vi.useFakeTimers();
      const { result } = mount();
      await flush();
      fire('escape:state', state());
      fire('game:ended', {});
      fire('escape:finale', finale);
      await act(() => vi.advanceTimersByTimeAsync(FINALE_GRACE_MS * 2));
      expect(sent('escape:results')).toHaveLength(0);
      expect(result.current.ui.ended).toBe('final');
    });
  });

  it('a state in the finale phase with no finale fetches it once', async () => {
    acks.set('escape:results', () => ({ ok: true, finale }));
    const { result } = mount();
    await flush();
    fire('escape:state', state({ phase: 'finale' }));
    await flush();
    fire('escape:state', state({ phase: 'finale' }));
    await flush();
    expect(sent('escape:results')).toHaveLength(1);
    expect(result.current.ui.finale).toEqual(finale);
  });

  it('submit sends the try and resolves its ack, a rate limit included', async () => {
    const { result } = mount();
    await flush();
    await expect(act(() => result.current.submit('duo', '0417', 'lookout'))).resolves.toEqual({
      ok: true,
    });
    expect(sent('escape:submit')).toEqual([
      {
        event: 'escape:submit',
        payload: { pin: PIN, lockId: 'duo', input: '0417', roleId: 'lookout' },
      },
    ]);
    const limited = { ok: false, reason: 'rate-limited', retryAfterMs: 12_000 };
    acks.set('escape:submit', () => limited);
    await expect(act(() => result.current.submit('pad', '1'))).resolves.toEqual(limited);
    expect(sent('escape:submit')[1].payload).toEqual({ pin: PIN, lockId: 'pad', input: '1' });
  });

  it('askHint and chooseTeam send their requests', async () => {
    const { result } = mount();
    await flush();
    await act(() => result.current.askHint('h1'));
    expect(sent('escape:ask-hint')[0].payload).toEqual({ pin: PIN, hintId: 'h1' });
    acks.set('escape:choose-team', () => ({ ok: false, error: { code: 'escape.team_full' } }));
    await expect(result.current.chooseTeam('t2')).rejects.toMatchObject({
      code: 'escape.team_full',
    });
  });

  it('results from the record: the finale, or null and the record cleared', async () => {
    saveEscapeRecord({ pin: PIN, gameId: GAME, playerId: 'p1', sessionToken: 'old', teamId: 't1' });
    acks.set('escape:results', () => ({ ok: true, finale }));
    const { result } = mount();
    await flush();
    await expect(act(() => result.current.resultsFromRecord())).resolves.toEqual(finale);
    expect(sent('escape:results')[0].payload).toEqual({ gameId: GAME, sessionToken: 'old' });
    acks.set('escape:results', () => ({ ok: false, error: { code: 'escape.not_found' } }));
    await expect(act(() => result.current.resultsFromRecord())).resolves.toBeNull();
    expect(loadEscapeRecord(PIN)).toBeNull();
  });

  it('a join into a new session clears the last run’s record; a reconnect keeps it', async () => {
    saveEscapeRecord({ pin: PIN, gameId: GAME, playerId: 'p1', sessionToken: 'tok', teamId: 't1' });
    const { rerender } = mount();
    await flush();
    rerender(seam({ attachSeq: 1 })); // same token: a reconnect
    await flush();
    expect(loadEscapeRecord(PIN)).not.toBeNull();
    loadPlayerSession.mockReturnValue({
      pin: PIN,
      sessionToken: 'new',
      playerId: 'p9',
      nickname: 'Cy',
    });
    rerender(seam({ attachSeq: 2 })); // markJoined after a fresh join
    await flush();
    expect(loadEscapeRecord(PIN)).toBeNull();
  });

  it('knows me from the record when the player session is another room’s', async () => {
    saveEscapeRecord({ pin: PIN, gameId: GAME, playerId: 'p1', sessionToken: 'tok', teamId: 't1' });
    loadPlayerSession.mockReturnValue({
      pin: '111111',
      sessionToken: 'x',
      playerId: 'p2',
      nickname: 'Ben',
    });
    const { result } = mount();
    await flush();
    fire('escape:state', state());
    fire('escape:team-update', { teamId: 't1', kind: 'wrong', by: 'p1' });
    expect(result.current.ui.polite).toEqual([]);
  });

  it('follows only the phone’s events, and lets every one go on unmount', async () => {
    // Attached: the look's listener waits for the session's socket.
    const { unmount } = mount(seam({ attachSeq: 1 }));
    await flush();
    expect([...listeners.keys()].sort()).toEqual([
      'escape:finale',
      // The room's brand (M7): static, public, for every synced socket.
      'escape:look',
      'escape:state',
      'escape:team-update',
      'game:ended',
    ]);
    for (const banned of [
      'escape:outline',
      'escape:host',
      'escape:host-team',
      'escape:host-batch',
      'escape:board',
      'escape:announce',
    ]) {
      expect(listeners.has(banned)).toBe(false);
    }
    unmount();
    expect([...listeners.keys()]).toEqual([]);
  });
});
