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
        ack?.(acks.get(e)?.(payload) ?? { ok: true });
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

import { loadEscapeRecord, saveEscapeRecord } from './escape-record';
import { FINALE_GRACE_MS, type EscapeSessionSeam, useEscapeSession } from './use-escape-session';

const PIN = '482913';
const GAME = '0123456789abcdef0123456789abcdef';

const state = (over: Partial<EscapePlayerState> = {}): EscapePlayerState => ({
  gameId: GAME,
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
  view: { state: GameState.Lobby, totalQuestions: 0 },
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
    rerender(seam({ attachSeq: 2, view: { state: GameState.Lobby, totalQuestions: 0 } }));
    await flush();
    expect(sent('escape:sync')).toHaveLength(2);
  });

  it('an unasked escape:state turns it on and keeps the record', async () => {
    const { result } = mount();
    await flush();
    fire('escape:state', state());
    expect(result.current.active).toBe(true);
    expect(result.current.ui.state?.gameId).toBe(GAME);
    expect(loadEscapeRecord(PIN)).toEqual({
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
    rerender(seam({ view: { state: GameState.Lobby, totalQuestions: 5 } }));
    expect(result.current.active).toBe(false);
    fire('escape:state', state());
    expect(result.current.active).toBe(true);
    rerender(seam({ view: { state: GameState.Answering, totalQuestions: 0 } }));
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

  it('follows only the phone’s events, and lets every one go on unmount', async () => {
    const { unmount } = mount();
    await flush();
    expect([...listeners.keys()].sort()).toEqual([
      'escape:finale',
      'escape:state',
      'escape:team-update',
      'game:ended',
    ]);
    for (const banned of [
      'escape:outline',
      'escape:host',
      'escape:host-team',
      'escape:board',
      'escape:announce',
    ]) {
      expect(listeners.has(banned)).toBe(false);
    }
    unmount();
    expect([...listeners.keys()]).toEqual([]);
  });
});
