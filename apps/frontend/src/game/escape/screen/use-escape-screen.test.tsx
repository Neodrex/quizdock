import { GameState } from '@quiz-dock/contracts';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../game-client', async (orig) => ({
  ...(await orig<typeof import('../../game-client')>()),
  ensureGameSocket: () => Promise.resolve(fakeSocket),
}));

import { SYNC_RETRY_MS } from '../escape-sync';
import { BANNER_MS } from './screen-reducer';
import { loadScreenRecord, saveScreenRecord } from './screen-record';
import { announceOf, boardOf, GAME, screenFinaleOf } from './screen-fixtures';
import { type EscapeScreenSeam, useEscapeScreen } from './use-escape-screen';

const PIN = '482913';
const ACK_TIMEOUT_MS = 8_000;

const seam = (over: Partial<EscapeScreenSeam> = {}): EscapeScreenSeam => ({
  view: { status: 'ready', state: GameState.Lobby, totalQuestions: 0 },
  attachSeq: 0,
  socket: fakeSocket as never,
  ...over,
});
const at = (state: GameState, attachSeq = 1, totalQuestions = 0) =>
  seam({ attachSeq, view: { status: 'ready', state, totalQuestions } });

const fire = (event: string, payload?: unknown) =>
  act(() => listeners.get(event)?.forEach((cb) => cb(payload)));
const flush = () => act(async () => {});
const sent = (event: string) => emitted.filter((e) => e.event === event);

function mount(initial = seam()) {
  return renderHook((s: EscapeScreenSeam) => useEscapeScreen(PIN, s), { initialProps: initial });
}

describe('useEscapeScreen', () => {
  afterEach(() => {
    fakeSocket.connected = true;
    listeners.clear();
    emitted.length = 0;
    acks.clear();
    sessionStorage.clear();
    vi.useRealTimers();
  });

  describe('sync', () => {
    it('waits for the spectator to join, then syncs once per attach', async () => {
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

    it('is sent again after SYNC_RETRY_MS when it times out', async () => {
      vi.useFakeTimers();
      acks.set('escape:sync', () => 'no-ack');
      mount(seam({ attachSeq: 1 }));
      await flush();
      expect(sent('escape:sync')).toHaveLength(1);
      await act(() => vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + SYNC_RETRY_MS));
      expect(sent('escape:sync')).toHaveLength(2);
    });

    it('a board that came meanwhile makes a timed-out sync moot', async () => {
      vi.useFakeTimers();
      acks.set('escape:sync', () => 'no-ack');
      mount(seam({ attachSeq: 1 }));
      await flush();
      fire('escape:board', boardOf());
      await act(() => vi.advanceTimersByTimeAsync(3 * (ACK_TIMEOUT_MS + SYNC_RETRY_MS)));
      expect(sent('escape:sync')).toHaveLength(1);
    });
  });

  describe('on and off', () => {
    it('a sync ack turns escape mode on', async () => {
      const { result } = mount(seam({ attachSeq: 1 }));
      await flush();
      expect(result.current.active).toBe(true);
    });

    it('an unasked board turns it on, and is taken in', async () => {
      acks.set('escape:sync', () => 'no-ack');
      const { result } = mount(seam({ attachSeq: 1 }));
      await flush();
      expect(result.current.active).toBe(false);
      fire('escape:board', boardOf({ title: 'Vault Heist' }));
      expect(result.current.active).toBe(true);
      expect(result.current.ui.board?.title).toBe('Vault Heist');
    });

    it('escape.not_found keeps it off', async () => {
      acks.set('escape:sync', () => ({ ok: false, error: { code: 'escape.not_found' } }));
      const { result } = mount(seam({ attachSeq: 1 }));
      await flush();
      expect(result.current.active).toBe(false);
    });

    it('a quiz shown turns it off', async () => {
      const { result, rerender } = mount(seam({ attachSeq: 1 }));
      await flush();
      expect(result.current.active).toBe(true);
      rerender(at(GameState.Answering, 1, 5));
      await flush();
      expect(result.current.active).toBe(false);
    });

    it('a room switch (the lobby after a podium) syncs again; a refusal hands back to the quiz', async () => {
      const { result, rerender } = mount(at(GameState.Podium));
      await flush();
      expect(sent('escape:sync')).toHaveLength(1);
      acks.set('escape:sync', () => ({ ok: false, error: { code: 'escape.not_found' } }));
      rerender(at(GameState.Lobby));
      await flush();
      expect(sent('escape:sync')).toHaveLength(2);
      expect(result.current.active).toBe(false);
    });

    it('the lobby after a screen finale syncs again too', async () => {
      const { rerender } = mount(at(GameState.Escape));
      await flush();
      fire('escape:screen-finale', screenFinaleOf());
      rerender(at(GameState.Lobby));
      await flush();
      expect(sent('escape:sync')).toHaveLength(2);
    });

    it('escape:closed drops the run: off and stopped, no finale kept, no sync; the next board turns it on', async () => {
      const { result, rerender } = mount(at(GameState.Escape));
      await flush();
      fire('escape:board', boardOf());
      expect(result.current.stopped).toBe(false);
      fire('escape:closed', { gameId: GAME });
      expect(result.current.active).toBe(false);
      expect(result.current.stopped).toBe(true);
      expect(result.current.ui).toMatchObject({ board: null, finale: null });
      rerender(at(GameState.Lobby));
      await flush();
      expect(sent('escape:sync')).toHaveLength(1);
      expect(loadScreenRecord(PIN)).toBeNull();
      fire('escape:board', boardOf({ gameId: 'a'.repeat(32), phase: 'forming' }));
      expect(result.current.active).toBe(true);
      expect(result.current.stopped).toBe(false);
    });

    it('a stop the server follows with the same escape room: the screen shows the new lobby, and a late escape:closed of the old run does not wipe it', async () => {
      const { result, rerender } = mount(at(GameState.Escape));
      await flush();
      fire('escape:board', boardOf({ phase: 'running' }));
      const next = 'a'.repeat(32);
      fire('escape:closed', { gameId: GAME });
      rerender(at(GameState.Lobby));
      await flush();
      fire('escape:board', boardOf({ gameId: next, phase: 'forming' }));
      expect(result.current).toMatchObject({ active: true, stopped: false });
      expect(result.current.ui.board).toMatchObject({ gameId: next, phase: 'forming' });
      fire('escape:closed', { gameId: GAME });
      expect(result.current).toMatchObject({ active: true, stopped: false });
      expect(result.current.ui.board?.gameId).toBe(next);
      expect(result.current.ui.finale).toBeNull();
      expect(sent('escape:sync')).toHaveLength(1);
    });

    it('the host leaving changes nothing', async () => {
      const { result, rerender } = mount(at(GameState.Escape));
      await flush();
      rerender(at(GameState.HostDisconnected));
      await flush();
      expect(result.current.active).toBe(true);
      expect(sent('escape:sync')).toHaveLength(1);
    });
  });

  describe('banners', () => {
    it('shows an announce, then lets it go after its time', async () => {
      vi.useFakeTimers();
      const { result } = mount(seam({ attachSeq: 1 }));
      await flush();
      fire('escape:announce', announceOf({ kind: 'stage-cleared' }));
      expect(result.current.ui.current?.kind).toBe('stage-cleared');
      await act(() => vi.advanceTimersByTimeAsync(BANNER_MS + 10));
      expect(result.current.ui.current).toBeNull();
    });

    it('holds the banners while paused, and shows them on resume', async () => {
      vi.useFakeTimers();
      const { result } = mount(seam({ attachSeq: 1 }));
      await flush();
      const clock = { serverNow: 1_000_000_000, paused: true, elapsedMs: 0, limitMs: 2_400_000 };
      fire('escape:board', boardOf({ clock }));
      fire('escape:announce', announceOf({ kind: 'hint' }));
      expect(result.current.ui.current).toBeNull();
      fire(
        'escape:board',
        boardOf({ clock: { ...clock, serverNow: clock.serverNow + 1, paused: false } }),
      );
      expect(result.current.ui.current?.kind).toBe('hint');
    });
  });

  describe('the finale and its record', () => {
    it('saves the screen finale in the record, replayed from its start (a reload mid-replay does not replay)', async () => {
      const finale = screenFinaleOf();
      const { result } = mount(at(GameState.Escape));
      await flush();
      fire('escape:screen-finale', finale);
      expect(result.current.ui.finale).toEqual(finale);
      expect(result.current.ui.replay).toBe('pending');
      expect(loadScreenRecord(PIN)).toMatchObject({ gameId: GAME, replayed: true, finale });
      act(() => result.current.replayDone());
      expect(result.current.ui.replay).toBe('done');
      expect(loadScreenRecord(PIN)?.replayed).toBe(true);
    });

    it('after a reload, the finale the sync brings is not replayed', async () => {
      const finale = screenFinaleOf();
      saveScreenRecord(PIN, { gameId: GAME, replayed: true, finale });
      const { result } = mount(at(GameState.Escape));
      await flush();
      fire('escape:screen-finale', finale);
      expect(result.current.ui.replay).toBe('done');
    });

    it('"Show the finale again" pushes one more: it replays', async () => {
      const finale = screenFinaleOf();
      saveScreenRecord(PIN, { gameId: GAME, replayed: true, finale });
      const { result } = mount(at(GameState.Escape));
      await flush();
      fire('escape:screen-finale', finale);
      fire('escape:screen-finale', finale);
      expect(result.current.ui.replay).toBe('pending');
      // Kept as replayed already: a reload during this replay shows the standings.
      expect(loadScreenRecord(PIN)?.replayed).toBe(true);
    });

    it('game:ended with a matching record keeps the finale and says the room closed', async () => {
      const finale = screenFinaleOf();
      const { result, rerender } = mount(at(GameState.Escape));
      await flush();
      fire('escape:screen-finale', finale);
      rerender(at(GameState.Ended));
      await flush();
      expect(result.current.active).toBe(true);
      expect(result.current.ui.finale).toEqual(finale);
      expect(result.current.ui.closed).toBe(true);
    });

    it('a refused join on reload shows the kept finale, closed', async () => {
      const finale = screenFinaleOf();
      saveScreenRecord(PIN, { gameId: GAME, replayed: true, finale });
      const { result } = mount(seam({ view: { status: 'error', state: null, totalQuestions: 0 } }));
      await flush();
      expect(result.current.active).toBe(true);
      expect(result.current.ui.finale).toEqual(finale);
      expect(result.current.ui.replay).toBe('done');
      expect(result.current.ui.closed).toBe(true);
    });

    it('a finale of the last run never shows for the next one, ended or refused', async () => {
      const finaleA = screenFinaleOf();
      const B = 'b'.repeat(32);
      const { result, rerender } = mount(at(GameState.Escape));
      await flush();
      fire('escape:screen-finale', finaleA);
      rerender(at(GameState.Lobby)); // host:back-to-lobby, run B opens
      await flush();
      fire(
        'escape:board',
        boardOf({
          gameId: B,
          clock: { serverNow: 2, paused: false, elapsedMs: 0, limitMs: 60_000 },
        }),
      );
      expect(loadScreenRecord(PIN)).toBeNull();
      rerender(at(GameState.Ended)); // the host ends the room mid-run
      await flush();
      expect(result.current.ui.finale).toBeNull();
      expect(result.current.ui.closed).toBe(false);
    });

    it('a kept finale of another run than the board shown is not used when the room is gone', async () => {
      saveScreenRecord(PIN, { gameId: GAME, replayed: true, finale: screenFinaleOf() });
      const { result, rerender } = mount(at(GameState.Escape));
      await flush();
      // The storage could not be cleared (private mode): the board still says run B.
      const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {});
      fire('escape:board', boardOf({ gameId: 'b'.repeat(32) }));
      rerender(seam({ attachSeq: 1, view: { status: 'error', state: null, totalQuestions: 0 } }));
      await flush();
      removeItem.mockRestore();
      expect(result.current.ui.finale).toBeNull();
      expect(result.current.ui.closed).toBe(false);
    });

    it('a refused join with no record stays off (upstream error)', async () => {
      const { result } = mount(seam({ view: { status: 'error', state: null, totalQuestions: 0 } }));
      await flush();
      expect(result.current.active).toBe(false);
      expect(result.current.ui.closed).toBe(false);
    });

    it('game:ended with no finale kept is not closed', async () => {
      const { result, rerender } = mount(at(GameState.Lobby));
      await flush();
      rerender(at(GameState.Ended));
      await flush();
      expect(result.current.ui.closed).toBe(false);
    });
  });

  it('listens for escape:board, escape:announce, escape:screen-finale, escape:closed and escape:look only, and lets them go', async () => {
    const { unmount } = mount(seam({ attachSeq: 1 }));
    await flush();
    expect([...listeners.keys()].sort()).toEqual([
      'escape:announce',
      'escape:board',
      'escape:closed',
      'escape:look',
      'escape:screen-finale',
    ]);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
