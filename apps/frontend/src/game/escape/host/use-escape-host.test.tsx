import type { EscapeFinale } from '@quiz-dock/contracts';
import { GameState } from '@quiz-dock/contracts';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A fake socket that holds several listeners per event, as socket.io does.
const { fakeSocket, listeners, emitted, acks } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  // The server's answer per event; ok by default. 'no-ack': never answers; 'hold': answered later.
  const acks = new Map<string, (payload: unknown, ack: (r: unknown) => void) => unknown>();
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
        const res = acks.get(e)?.(payload, (r) => ack?.(r)) ?? { ok: true };
        if (res !== 'no-ack' && res !== 'hold') ack?.(res);
      },
    },
  };
});

vi.mock('../../game-client', async (orig) => ({
  ...(await orig<typeof import('../../game-client')>()),
  ensureGameSocket: () => Promise.resolve(fakeSocket),
}));

import { SYNC_RETRY_MS, useEscapeSync } from '../escape-sync';
import { GAME } from '../test-fixtures';
import { boardOf, hostStateOf, hostTeamOf, outlineOf } from './host-fixtures';
import { loadHostRecord, saveHostRecord } from './host-record';
import { type EscapeHostSeam, LOBBY_WAIT_MS, useEscapeHost } from './use-escape-host';
import { useNow } from '../use-now';
import { ACME_LOOK } from '../session/look-fixtures';

const PIN = '482913';

const finale: EscapeFinale = {
  gameId: GAME,
  title: 'Vault Heist',
  finale: 'Well done.',
  ranking: [],
  awards: { fastest: null, fewestHints: null, teamwork: null, photoFinish: null },
};

const seam = (over: Partial<EscapeHostSeam> = {}): EscapeHostSeam => ({
  view: { status: 'ready', state: GameState.Lobby, totalQuestions: 0 },
  attachSeq: 0,
  ...over,
});
const withState = (state: GameState, attachSeq = 1) =>
  seam({ view: { status: 'ready', state, totalQuestions: 0 }, attachSeq });

const fire = (event: string, payload?: unknown) =>
  act(() => listeners.get(event)?.forEach((cb) => cb(payload)));
const flush = () => act(async () => {});
const sent = (event: string) => emitted.filter((e) => e.event === event);

function mount(initial = seam()) {
  return renderHook((s: EscapeHostSeam) => useEscapeHost(PIN, s), { initialProps: initial });
}

const HOST_EVENTS = [
  'escape:outline',
  'escape:host',
  'escape:host-team',
  'escape:board',
  'escape:team-update',
  'escape:announce',
  'escape:finale',
  // The room's look (M7 §1.9): the console's colours and brand.
  'escape:look',
];

describe('useEscapeHost', () => {
  afterEach(() => {
    vi.useRealTimers();
    emitted.length = 0;
    acks.clear();
    listeners.clear();
    fakeSocket.connected = true;
    localStorage.clear();
  });

  it('syncs only once attached, once per attachSeq bump', async () => {
    const { rerender } = mount();
    await flush();
    expect(sent('escape:sync')).toEqual([]);
    rerender(seam({ attachSeq: 1 }));
    await flush();
    rerender(seam({ attachSeq: 1 }));
    await flush();
    expect(sent('escape:sync')).toEqual([{ event: 'escape:sync', payload: { pin: PIN } }]);
    rerender(seam({ attachSeq: 2 }));
    await flush();
    expect(sent('escape:sync')).toHaveLength(2);
  });

  it('keeps the look of its first sync (M7 §1.9): the console mounts only after it', async () => {
    const { result, rerender } = mount();
    await flush();
    rerender(seam({ attachSeq: 1 }));
    await flush();
    // The sync's look comes first, before the console that shows it is on the page.
    fire('escape:look', ACME_LOOK);
    expect(result.current.look).toEqual(ACME_LOOK);
  });

  it('a later attach (a reconnect, no reload) adds a "Reconnected" line; the first does not', async () => {
    const { result, rerender } = mount();
    await flush();
    rerender(seam({ attachSeq: 1 }));
    await flush();
    expect(result.current.ui.feed).toEqual([]);
    rerender(seam({ attachSeq: 2 }));
    await flush();
    expect(result.current.ui.feed.map((l) => l.key)).toEqual(['host.feed.reconnected']);
  });

  it('retries a sync that got no answer', async () => {
    vi.useFakeTimers();
    acks.set('escape:sync', () => 'no-ack');
    mount(seam({ attachSeq: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sent('escape:sync')).toHaveLength(1);
    acks.delete('escape:sync');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000 + SYNC_RETRY_MS);
    });
    expect(sent('escape:sync')).toHaveLength(2);
  });

  it('a retry already scheduled waits while the sync is on hold', async () => {
    vi.useFakeTimers();
    acks.set('escape:sync', () => 'no-ack');
    const holdRef = { current: false };
    renderHook(() =>
      useEscapeSync(PIN, 'host', 1, 0, {
        quizOnRef: { current: false },
        heardRef: { current: 0 },
        socketRef: { current: null },
        setActive: () => {},
        holdRef,
      }),
    );
    await act(async () => {
      // Past the ack timeout (8 s), before the retry fires.
      await vi.advanceTimersByTimeAsync(8_000 + SYNC_RETRY_MS / 2);
    });
    expect(sent('escape:sync')).toHaveLength(1);
    // The retry is scheduled now; the hold starts before it fires.
    holdRef.current = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYNC_RETRY_MS + 1);
    });
    expect(sent('escape:sync')).toHaveLength(1);
  });

  it.each([
    ['an ok', { ok: true }],
    ['a refusal', { ok: false, error: { code: 'escape.not_found' } }],
  ])('%s answered after the hold began changes nothing', async (_, answer) => {
    let answerSync: (r: unknown) => void = () => {};
    acks.set('escape:sync', (_p, ack) => {
      answerSync = ack;
      return 'hold';
    });
    const holdRef = { current: false };
    const setActive = vi.fn();
    renderHook(() =>
      useEscapeSync(PIN, 'host', 1, 0, {
        quizOnRef: { current: false },
        heardRef: { current: 0 },
        socketRef: { current: null },
        setActive,
        holdRef,
      }),
    );
    await flush();
    expect(sent('escape:sync')).toHaveLength(1);
    // Back to the lobby, then escape:open: the old room's answer is moot.
    holdRef.current = true;
    await act(async () => answerSync(answer));
    expect(setActive).not.toHaveBeenCalled();
  });

  it('{ok:true} turns it on; escape.not_found keeps it off', async () => {
    const on = mount(seam({ attachSeq: 1 }));
    await flush();
    expect(on.result.current.active).toBe(true);
    on.unmount();
    acks.set('escape:sync', () => ({ ok: false, error: { code: 'escape.not_found' } }));
    const off = mount(seam({ attachSeq: 1 }));
    await flush();
    expect(off.result.current.active).toBe(false);
  });

  it('an unasked escape:host turns it on and saves the host record', async () => {
    const { result } = mount();
    await flush();
    fire('escape:outline', outlineOf());
    fire('escape:host', hostStateOf());
    expect(result.current.active).toBe(true);
    expect(result.current.ui.host?.gameId).toBe(GAME);
    expect(result.current.ui.outline?.templateId).toBe('tpl-vh');
    expect(loadHostRecord(PIN)).toMatchObject({ pin: PIN, gameId: GAME });
  });

  it('follows its events into the state', async () => {
    const { result } = mount();
    await flush();
    fire('escape:outline', outlineOf());
    fire('escape:host', hostStateOf());
    fire('escape:host-team', hostTeamOf({ wrong: 4 }));
    fire('escape:team-update', { teamId: 't1', kind: 'time-up' });
    fire('escape:finale', finale);
    expect(result.current.ui.host!.teams[0].wrong).toBe(4);
    expect(result.current.ui.feed.at(-1)?.key).toBe('host.feed.timeUp');
    expect(result.current.ui.finale).toBe(finale);
  });

  it('back in the lobby after a podium syncs again; a refusal hands back to the quiz', async () => {
    const { result, rerender } = mount(withState(GameState.Escape));
    await flush();
    expect(result.current.active).toBe(true);
    rerender(withState(GameState.Podium));
    await flush();
    expect(sent('escape:sync')).toHaveLength(1);
    acks.set('escape:sync', () => ({ ok: false, error: { code: 'escape.not_found' } }));
    rerender(withState(GameState.Lobby));
    await flush();
    expect(sent('escape:sync')).toHaveLength(2);
    expect(result.current.active).toBe(false);
  });

  it('the lobby after a finale syncs again too', async () => {
    const { rerender } = mount(withState(GameState.Escape));
    await flush();
    fire('escape:finale', finale);
    rerender(withState(GameState.Lobby));
    await flush();
    expect(sent('escape:sync')).toHaveLength(2);
  });

  it('a quiz in the room turns it off', async () => {
    const { result, rerender } = mount(withState(GameState.Lobby));
    await flush();
    expect(result.current.active).toBe(true);
    rerender(
      seam({ view: { status: 'ready', state: GameState.Lobby, totalQuestions: 5 }, attachSeq: 1 }),
    );
    expect(result.current.active).toBe(false);
  });

  it('each command emits its event with the PIN, busy until its answer', async () => {
    const { result } = mount(seam({ attachSeq: 1 }));
    await flush();
    const cases: [() => Promise<unknown>, string, object][] = [
      [
        () => result.current.teams({ mode: 'auto', count: 2 }),
        'escape:teams',
        { mode: 'auto', count: 2 },
      ],
      [() => result.current.move('p1', null), 'escape:move', { playerId: 'p1', teamId: null }],
      [() => result.current.start(), 'escape:start', {}],
      [() => result.current.pause(true), 'escape:pause', { paused: true }],
      [
        () => result.current.adjustTime(120, 't1'),
        'escape:adjust-time',
        { deltaS: 120, teamId: 't1' },
      ],
      [() => result.current.adjustTime(-60), 'escape:adjust-time', { deltaS: -60 }],
      [
        () => result.current.unlock('t1', 'lobby-door'),
        'escape:unlock',
        { teamId: 't1', lockId: 'lobby-door' },
      ],
      [() => result.current.end(), 'escape:end', {}],
      [() => result.current.finale(), 'escape:finale', {}],
    ];
    for (const [call, event, payload] of cases) {
      await act(async () => {
        await call();
      });
      expect(emitted.at(-1)).toEqual({ event, payload: { pin: PIN, ...payload } });
    }
    acks.set('escape:hint', () => ({ ok: true, released: 3 }));
    let released: number | undefined;
    await act(async () => {
      released = await result.current.hint();
    });
    expect(released).toBe(3);
    expect(emitted.at(-1)).toEqual({ event: 'escape:hint', payload: { pin: PIN } });
  });

  it('a team hint names the confirmed hint; escape.hint-changed reads the room again', async () => {
    const { result } = mount(seam({ attachSeq: 1 }));
    await flush();
    const syncs = sent('escape:sync').length;
    acks.set('escape:hint', () => ({ ok: false, error: { code: 'escape.hint-changed' } }));
    await act(async () => {
      await expect(result.current.hint('t1', 'lobby-h1')).rejects.toMatchObject({
        code: 'escape.hint-changed',
      });
    });
    expect(emitted.filter((e) => e.event === 'escape:hint').at(-1)).toEqual({
      event: 'escape:hint',
      payload: { pin: PIN, teamId: 't1', hintId: 'lobby-h1' },
    });
    await flush();
    expect(sent('escape:sync')).toHaveLength(syncs + 1);
    // Another refusal reads nothing again.
    acks.set('escape:hint', () => ({ ok: false, error: { code: 'escape.wrong_phase' } }));
    await act(async () => {
      await expect(result.current.hint('t1', 'lobby-h1')).rejects.toBeTruthy();
    });
    await flush();
    expect(sent('escape:sync')).toHaveLength(syncs + 1);
  });

  it('a second call while pending sends nothing; pending clears on the answer or an error', async () => {
    let answer: (r: unknown) => void = () => {};
    acks.set('escape:start', (_p, ack) => {
      answer = ack;
      return 'hold';
    });
    const { result } = mount(seam({ attachSeq: 1 }));
    await flush();
    let first!: Promise<unknown>;
    await act(async () => {
      first = result.current.start();
    });
    expect(result.current.ui.pending.start).toBe(true);
    await act(async () => {
      await expect(result.current.start()).resolves.toBeUndefined();
    });
    expect(sent('escape:start')).toHaveLength(1);
    await act(async () => {
      answer({ ok: false, error: { code: 'escape.wrong_phase' } });
      await expect(first).rejects.toMatchObject({ code: 'escape.wrong_phase' });
    });
    expect(result.current.ui.pending.start).toBe(false);
    acks.delete('escape:start');
    await act(async () => {
      await result.current.start();
    });
    expect(sent('escape:start')).toHaveLength(2);
    expect(result.current.ui.pending.start).toBe(false);
  });

  it('runAgain goes back to the lobby, then opens the same template once the lobby shows', async () => {
    const { result, rerender } = mount(withState(GameState.Podium));
    await flush();
    fire('escape:outline', outlineOf());
    const syncs = sent('escape:sync').length;
    let done!: Promise<unknown>;
    await act(async () => {
      done = result.current.runAgain();
    });
    expect(sent('host:back-to-lobby')).toEqual([
      { event: 'host:back-to-lobby', payload: { pin: PIN } },
    ]);
    expect(sent('escape:open')).toEqual([]);
    // The quiz lobby shows before escape:open: no sync meanwhile (it would be refused).
    rerender(withState(GameState.Lobby));
    await flush();
    expect(sent('escape:sync')).toHaveLength(syncs);
    fire('game:state', { state: GameState.Lobby, questionIndex: -1, totalQuestions: 0 });
    await act(async () => {
      await done;
    });
    expect(sent('escape:open')).toEqual([
      { event: 'escape:open', payload: { pin: PIN, templateId: 'tpl-vh' } },
    ]);
    // Then the new run's view.
    expect(sent('escape:sync')).toHaveLength(syncs + 1);
    expect(result.current.ui.pending.runAgain).toBe(false);
  });

  it('runAgain: host:back-to-lobby refused syncs again, and the lobby wait rejects quietly', async () => {
    vi.useFakeTimers();
    acks.set('host:back-to-lobby', () => ({ ok: false, error: { code: 'game.wrong_state' } }));
    const { result } = mount(withState(GameState.Podium));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fire('escape:outline', outlineOf());
    const syncs = sent('escape:sync').length;
    await act(async () => {
      await expect(result.current.runAgain()).rejects.toMatchObject({ code: 'game.wrong_state' });
    });
    expect(sent('escape:open')).toEqual([]);
    // The console reads the room again instead of staying on the old finale.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(sent('escape:sync')).toHaveLength(syncs + 1);
    expect(result.current.ui.pending.runAgain).toBe(false);
    // The lobby wait times out later with nobody listening: no unhandled rejection.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOBBY_WAIT_MS + 1);
    });
    expect(listeners.get('game:state')).toBeUndefined();
  });

  it('runAgain: escape:open refused syncs again', async () => {
    acks.set('escape:open', () => ({ ok: false, error: { code: 'escape_template.invalid' } }));
    const { result, rerender } = mount(withState(GameState.Podium));
    await flush();
    fire('escape:outline', outlineOf());
    const syncs = sent('escape:sync').length;
    let done!: Promise<unknown>;
    await act(async () => {
      done = result.current.runAgain();
    });
    rerender(withState(GameState.Lobby));
    fire('game:state', { state: GameState.Lobby, questionIndex: -1, totalQuestions: 0 });
    await act(async () => {
      await expect(done).rejects.toMatchObject({ code: 'escape_template.invalid' });
    });
    await flush();
    // The resync is refused in a quiz lobby, which hands the room back to the quiz console.
    expect(sent('escape:sync')).toHaveLength(syncs + 1);
    expect(result.current.ui.pending.runAgain).toBe(false);
  });

  it('host:attach refused with a record of this PIN reads the results back', async () => {
    saveHostRecord({ pin: PIN, gameId: GAME });
    acks.set('escape:results', () => ({ ok: true, finale }));
    const { result } = mount(seam({ view: { status: 'error', state: null, totalQuestions: 0 } }));
    await flush();
    expect(sent('escape:results')).toEqual([
      { event: 'escape:results', payload: { gameId: GAME } },
    ]);
    expect(result.current.active).toBe(true);
    expect(result.current.ui).toMatchObject({ finale, ended: 'final' });
  });

  it('a sync in the finale phase (no finale replayed) reads the results by the room, once', async () => {
    acks.set('escape:results', () => ({ ok: true, finale }));
    const { result } = mount(withState(GameState.Podium));
    await flush();
    fire('escape:outline', outlineOf());
    const ended = hostStateOf({ board: boardOf({ phase: 'finale' }) });
    fire('escape:host', ended);
    await flush();
    fire('escape:host', ended);
    await flush();
    expect(sent('escape:results')).toEqual([
      { event: 'escape:results', payload: { gameId: GAME } },
    ]);
    // The room is still open: the results come with their actions.
    expect(result.current.ui).toMatchObject({ finale, ended: 'none' });
  });

  it('a failed results read in the finale is tried again on the next attach', async () => {
    let fail = true;
    acks.set('escape:results', () =>
      fail ? { ok: false, error: { code: 'escape.not_found' } } : { ok: true, finale },
    );
    const { result, rerender } = mount(withState(GameState.Podium));
    await flush();
    fire('escape:outline', outlineOf());
    const ended = hostStateOf({ board: boardOf({ phase: 'finale' }) });
    fire('escape:host', ended);
    await flush();
    expect(sent('escape:results')).toHaveLength(1);
    expect(result.current.ui.finale).toBeNull();
    // A reconnect re-attaches: same phase and run, so only the attach can retry the read.
    fail = false;
    rerender(withState(GameState.Podium, 2));
    await flush();
    expect(sent('escape:results')).toHaveLength(2);
    expect(result.current.ui.finale).toBe(finale);
  });

  it('a finale that came with the sync is not read again', async () => {
    const { result } = mount(withState(GameState.Podium));
    await flush();
    fire('escape:finale', finale);
    fire('escape:host', hostStateOf({ board: boardOf({ phase: 'finale' }) }));
    await flush();
    expect(sent('escape:results')).toEqual([]);
    expect(result.current.ui.finale).toBe(finale);
  });

  it('a refused attach without a record reads nothing', async () => {
    mount(seam({ view: { status: 'error', state: null, totalQuestions: 0 } }));
    await flush();
    expect(sent('escape:results')).toEqual([]);
  });

  it('listens for the host events only, and removes every listener on unmount', async () => {
    // Attached: the look's listener waits for the session's socket.
    const { unmount } = mount(seam({ attachSeq: 1 }));
    await flush();
    expect([...listeners.keys()].sort()).toEqual([...HOST_EVENTS].sort());
    unmount();
    expect(listeners.size).toBe(0);
  });
});

describe('useNow', () => {
  afterEach(() => vi.useRealTimers());

  it('ticks once a second, and stops on unmount', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { result, unmount } = renderHook(() => useNow());
    const first = result.current;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current - first).toBeGreaterThanOrEqual(1000);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
