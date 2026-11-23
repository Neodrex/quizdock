import type {
  EscapeAnnounce,
  EscapeBoard,
  EscapeFinale,
  EscapeHostOutline,
  EscapeHostState,
  EscapeHostTeam,
  EscapeTeams,
  EscapeTeamUpdate,
  GameStatePayload,
} from '@quiz-dock/contracts';
import { GameState } from '@quiz-dock/contracts';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { serverNow } from '../../clock';
import { emitWithAckOrError, ensureGameSocket, type GameSocket } from '../../game-client';
import type { GameView } from '../../use-game-session';
import { useEscapeMode, useEscapeSync } from '../escape-sync';
import { type HostEvent, type HostPayload, hostCommand } from './host-client';
import { loadHostRecord, saveHostRecord } from './host-record';
import {
  type CommandKey,
  type EscapeHostAction,
  escapeHostReducer,
  initialEscapeHostUi,
} from './host-reducer';
import { useEscapeLook } from '../session/use-escape-look';

/** How long "run it again" waits for the room's lobby before giving up. */
export const LOBBY_WAIT_MS = 5000;

/** What the hook needs of the console's quiz session (`useGameSession(pin, 'host')`). */
export interface EscapeHostSeam {
  view: Pick<GameView, 'state' | 'totalQuestions' | 'status'>;
  attachSeq: number;
}

type Listener = (p: never) => void;

/** The next `game:state` LOBBY on `sock`, or a rejection after `ms`. */
function lobbyOn(sock: GameSocket, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const on = sock.on as unknown as (e: string, h: (p: GameStatePayload) => void) => void;
    const off = sock.off as unknown as (e: string, h: (p: GameStatePayload) => void) => void;
    const done = (p: GameStatePayload) => {
      if (p.state !== GameState.Lobby) return;
      clearTimeout(timer);
      off.call(sock, 'game:state', done);
      resolve();
    };
    const timer = setTimeout(() => {
      off.call(sock, 'game:state', done);
      reject(new Error('lobby'));
    }, ms);
    on.call(sock, 'game:state', done);
  });
}

/**
 * The host console's escape run (M5 §1.1), on the quiz session's socket: syncs once
 * the host is attached (each `attachSeq` bump) and again when the room comes back to
 * its lobby after a run, follows the host's events, sends its commands (one at a
 * time per command), and reads the results back from the host record once the room
 * has closed.
 */
export function useEscapeHost(pin: string, session: EscapeHostSeam) {
  const [ui, dispatch] = useReducer(escapeHostReducer, initialEscapeHostUi);
  const { active, setActive, quizOnRef } = useEscapeMode(session.view);
  // The room's brand and colours (M7 §1.9): here, not in the console, which mounts
  // only once the sync's answer is in (its look comes first).
  const look = useEscapeLook(pin, 'host', session.attachSeq, session.view.state);
  const socketRef = useRef<GameSocket | null>(null);
  // Bumped on each escape:host: one that came makes a sync with no answer moot.
  const heardRef = useRef(0);
  const gameRef = useRef<string | null>(null);
  const outlineRef = useRef<EscapeHostOutline | null>(null);
  const finaleRef = useRef(false);
  const pendingRef = useRef(new Set<CommandKey>());
  // Between host:back-to-lobby and escape:open, the lobby's re-sync would be refused.
  const holdRef = useRef(false);
  const [resync, setResync] = useState(0);

  useEffect(() => {
    let live = true;
    let s: GameSocket | null = null;
    const act = (a: EscapeHostAction) => live && dispatch(a);
    const onOutline = (outline: EscapeHostOutline) => {
      outlineRef.current = outline;
      act({ type: 'outline', outline });
    };
    const onHost = (state: EscapeHostState) => {
      heardRef.current += 1;
      setActive(true);
      if (gameRef.current !== state.gameId) {
        gameRef.current = state.gameId;
        finaleRef.current = false;
        saveHostRecord({ pin, gameId: state.gameId });
      }
      act({ type: 'host', state, now: serverNow() });
    };
    const onHostTeam = (team: EscapeHostTeam) => act({ type: 'hostTeam', team, now: serverNow() });
    const onBoard = (board: EscapeBoard) => act({ type: 'board', board });
    const onUpdate = (update: EscapeTeamUpdate) =>
      act({ type: 'teamUpdate', update, now: serverNow() });
    const onAnnounce = (announce: EscapeAnnounce) => act({ type: 'announce', announce });
    const onFinale = (finale: EscapeFinale) => {
      finaleRef.current = true;
      act({ type: 'finale', finale });
    };
    const events: [string, Listener][] = [
      ['escape:outline', onOutline as Listener],
      ['escape:host', onHost as Listener],
      ['escape:host-team', onHostTeam as Listener],
      ['escape:board', onBoard as Listener],
      ['escape:team-update', onUpdate as Listener],
      ['escape:announce', onAnnounce as Listener],
      ['escape:finale', onFinale as Listener],
    ];
    void ensureGameSocket('host', pin).then((sock) => {
      if (!live) return;
      s = sock;
      socketRef.current = sock;
      const on = sock.on as unknown as (e: string, h: Listener) => void;
      for (const [e, h] of events) on.call(sock, e, h);
    });
    return () => {
      live = false;
      if (!s) return;
      const off = s.off as unknown as (e: string, h: Listener) => void;
      for (const [e, h] of events) off.call(s, e, h);
    };
  }, [pin, setActive]);

  useEscapeSync(pin, 'host', session.attachSeq, resync, {
    quizOnRef,
    heardRef,
    socketRef,
    setActive,
    holdRef,
  });

  // Back in the room after a drop (not a reload: that page starts at 1, and the kept
  // feed says it): the feed marks where the missed events would have been.
  const attachRef = useRef(session.attachSeq);
  useEffect(() => {
    const prev = attachRef.current;
    attachRef.current = session.attachSeq;
    if (prev > 0 && session.attachSeq > prev) {
      dispatch({ type: 'feed', key: 'host.feed.reconnected', now: serverNow() });
    }
  }, [session.attachSeq]);

  // Room switch (§1.1): the lobby after a podium or a finale is host:back-to-lobby;
  // sync again, and a refusal hands the room back to the quiz console.
  const state = session.view.state;
  const prevStateRef = useRef(state);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (state !== GameState.Lobby || prev === GameState.Lobby) return;
    if (prev === GameState.Podium || finaleRef.current) {
      finaleRef.current = false;
      setResync((n) => n + 1);
    }
  }, [state]);

  const socket = async () => socketRef.current ?? ensureGameSocket('host', pin);

  /** Runs a command once at a time: a second call while one is pending sends nothing. */
  const command = useCallback(
    async <T>(key: CommandKey, send: () => Promise<T>): Promise<T | undefined> => {
      if (pendingRef.current.has(key)) return undefined;
      pendingRef.current.add(key);
      dispatch({ type: 'pending', key, on: true });
      try {
        return await send();
      } finally {
        pendingRef.current.delete(key);
        dispatch({ type: 'pending', key, on: false });
      }
    },
    [],
  );

  const send = <E extends HostEvent>(key: CommandKey, event: E, payload: HostPayload<E>) =>
    command(key, async () => hostCommand(await socket(), event, payload));

  const teams = (p: Omit<EscapeTeams, 'pin'>) => send('teams', 'escape:teams', { pin, ...p });
  const move = (playerId: string, teamId: string | null) =>
    send('move', 'escape:move', { pin, playerId, teamId });
  const start = () => send('start', 'escape:start', { pin });
  const pause = (paused: boolean) => send('pause', 'escape:pause', { pin, paused });
  const adjustTime = (deltaS: number, teamId?: string) =>
    send('time', 'escape:adjust-time', { pin, deltaS, ...(teamId ? { teamId } : {}) });
  /**
   * How many hints it released (0: none left); undefined when one was already on its
   * way. `hintId` (one team): the hint the host confirmed. When the team's next hint
   * changed meanwhile the server refuses (`escape.hint-changed`), and the console
   * reads the room again so the host sees the hint that is next now.
   */
  const hint = async (teamId?: string, hintId?: string) => {
    try {
      const ack = await send('hint', 'escape:hint', {
        pin,
        ...(teamId ? { teamId } : {}),
        ...(teamId && hintId ? { hintId } : {}),
      });
      return ack?.released;
    } catch (e) {
      if ((e as { code?: string }).code === 'escape.hint-changed') setResync((n) => n + 1);
      throw e;
    }
  };
  const unlock = (teamId: string, lockId: string) =>
    send('unlock', 'escape:unlock', { pin, teamId, lockId });
  const end = () => send('end', 'escape:end', { pin });
  const finale = () => send('finale', 'escape:finale', { pin });

  /** Back to the lobby, then the same template again; the players stay, unassigned. */
  const runAgain = () =>
    command('runAgain', async () => {
      const templateId = outlineRef.current?.templateId;
      if (!templateId) throw new Error('escape.not_found');
      const sock = await socket();
      holdRef.current = true;
      try {
        const lobby = lobbyOn(sock, LOBBY_WAIT_MS);
        // A refused back-to-lobby leaves the wait to time out with nobody awaiting it.
        lobby.catch(() => {});
        await emitWithAckOrError(sock, 'host:back-to-lobby', { pin });
        await lobby;
        await hostCommand(sock, 'escape:open', { pin, templateId });
      } finally {
        holdRef.current = false;
        // Read the room again either way: the new run, or (refused) what the room is now.
        setResync((n) => n + 1);
      }
      return { ok: true as const };
    });

  /** After the room closed: the results of this PIN's last run (host path), or null. */
  const resultsFromRecord = useCallback(async (): Promise<EscapeFinale | null> => {
    const record = loadHostRecord(pin);
    if (!record) return null;
    try {
      const sock = socketRef.current ?? (await ensureGameSocket('host', pin));
      const res = await emitWithAckOrError<{ finale: EscapeFinale }>(sock, 'escape:results', {
        gameId: record.gameId,
      });
      dispatch({ type: 'closed', finale: res.finale });
      setActive(true);
      return res.finale;
    } catch {
      return null;
    }
  }, [pin, setActive]);

  // Back in the finale phase (a reload, a reconnect): escape:finale is not replayed, so
  // read the results by the room, once per run. A failed read is tried again on the next
  // attach (the phase and run stay the same in the finale, so they cannot trigger it).
  const phase = ui.board?.phase;
  const gameId = ui.host?.gameId ?? null;
  const haveFinale = !!ui.finale && ui.finale.gameId === gameId;
  const readRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== 'finale' || !gameId || haveFinale || readRef.current === gameId) return;
    readRef.current = gameId;
    void (async () => {
      try {
        const sock = socketRef.current ?? (await ensureGameSocket('host', pin));
        const res = await emitWithAckOrError<{ finale: EscapeFinale }>(sock, 'escape:results', {
          gameId,
        });
        finaleRef.current = true;
        dispatch({ type: 'finale', finale: res.finale });
      } catch {
        // Not marked read: the next attach (or change of phase or run) tries again.
        readRef.current = null;
      }
    })();
  }, [phase, gameId, haveFinale, pin, session.attachSeq]);

  // host:attach refused (the room is gone): a record of this PIN still has the results.
  const refused = session.view.status === 'error';
  useEffect(() => {
    if (refused) void resultsFromRecord();
  }, [refused, resultsFromRecord]);

  return {
    active,
    ui,
    look,
    teams,
    move,
    start,
    pause,
    adjustTime,
    hint,
    unlock,
    end,
    finale,
    runAgain,
    resultsFromRecord,
  };
}

export type EscapeHost = ReturnType<typeof useEscapeHost>;
