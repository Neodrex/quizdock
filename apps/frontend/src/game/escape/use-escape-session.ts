import {
  type EscapeAskHintAck,
  type EscapeFinale,
  type EscapePlayerState,
  type EscapeSubmitAck,
  type EscapeTeamUpdate,
} from '@quiz-dock/contracts';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { SYNC_RETRY_MS, useEscapeMode, useEscapeSync } from './escape-sync';
import {
  ensureGameSocket,
  emitWithAckOrError,
  type GameSocket,
  loadPlayerSession,
} from '../game-client';
import type { GameView } from '../use-game-session';
import { clearEscapeRecord, loadEscapeRecord, saveEscapeRecord } from './escape-record';
import { useEscapeLook } from './session/use-escape-look';
import { type EscapeAction, escapeReducer, initialEscapeUi } from './escape-reducer';

/** How long a phone waits for the finale after `game:ended` before fetching it (§1.4). */
export const FINALE_GRACE_MS = 3000;

export { SYNC_RETRY_MS };

/** What the hook needs of the quiz session (`useGameSession`). */
export interface EscapeSessionSeam {
  view: Pick<GameView, 'state' | 'totalQuestions' | 'status'>;
  attachSeq: number;
}

type Listener = (p: never) => void;

/**
 * A phone's escape run, on the quiz session's socket: syncs once the player is in the
 * room (each `attachSeq` bump), follows the phone's own events, and turns escape mode
 * on and off (§1.1). It never listens for the host's or the board's events.
 */
export function useEscapeSession(pin: string, session: EscapeSessionSeam) {
  const [ui, dispatch] = useReducer(escapeReducer, initialEscapeUi);
  const { active, setActive, quizOnRef } = useEscapeMode(session.view);
  const socketRef = useRef<GameSocket | null>(null);
  // The room's brand and colours (M7 §1.9).
  const look = useEscapeLook(pin, 'guest', session.attachSeq, session.view.state);
  const stateRef = useRef<EscapePlayerState | null>(null);
  // Bumped on each escape:state: a state that came makes a sync with no answer moot.
  const statesRef = useRef(0);
  // The run whose results were already asked for (the finale phase after a reload).
  const fetchedRef = useRef<string | null>(null);

  // My player id: this room's session, or the record when the session is another room's.
  const me = () => {
    const s = loadPlayerSession();
    return s && s.pin === pin ? s.playerId : (loadEscapeRecord(pin)?.playerId ?? null);
  };
  const tokenFor = useCallback(() => {
    const s = loadPlayerSession();
    return s && s.pin === pin ? s.sessionToken : loadEscapeRecord(pin)?.sessionToken;
  }, [pin]);

  useEffect(() => {
    let live = true;
    let s: GameSocket | null = null;
    const onState = (state: EscapePlayerState) => {
      const prev = stateRef.current;
      stateRef.current = state;
      statesRef.current += 1;
      setActive(true);
      const session = loadPlayerSession();
      // A new run or team, or a new token for the same team (a fresh join back into it).
      if (
        session?.pin === pin &&
        (prev?.gameId !== state.gameId ||
          prev?.team?.id !== state.team?.id ||
          session.sessionToken !== loadEscapeRecord(pin)?.sessionToken)
      ) {
        saveEscapeRecord({
          pin,
          gameId: state.gameId,
          playerId: session.playerId,
          sessionToken: session.sessionToken,
          teamId: state.team?.id ?? null,
        });
      }
      dispatch({ type: 'state', state });
    };
    const onUpdate = (update: EscapeTeamUpdate) =>
      dispatch({ type: 'teamUpdate', update, me: me() });
    const onFinale = (finale: EscapeFinale) => dispatch({ type: 'finale', finale });
    const onEnded = () => dispatch({ type: 'gameEnded' });
    const events: [string, Listener][] = [
      ['escape:state', onState as Listener],
      ['escape:team-update', onUpdate as Listener],
      ['escape:finale', onFinale as Listener],
      ['game:ended', onEnded as Listener],
    ];
    void ensureGameSocket('guest', pin).then((sock) => {
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
    // `me` reads storage each time: no dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  // Sync once the player is in the room: before that the server would take the phone for a screen.
  useEscapeSync(pin, 'guest', session.attachSeq, 0, {
    quizOnRef,
    heardRef: statesRef,
    socketRef,
    setActive,
    // A join into a new session: the last run's record (and its token) is not this player's.
    before: () => {
      const s = loadPlayerSession();
      const record = loadEscapeRecord(pin);
      if (record && s?.pin === pin && s.sessionToken !== record.sessionToken) clearEscapeRecord();
    },
  });

  const fetchResults = useCallback(
    async (gameId: string, sessionToken: string | undefined): Promise<EscapeFinale | null> => {
      const sock = socketRef.current ?? (await ensureGameSocket('guest', pin));
      try {
        const res = await emitWithAckOrError<{ finale: EscapeFinale }>(sock, 'escape:results', {
          gameId,
          ...(sessionToken ? { sessionToken } : {}),
        });
        return res.finale;
      } catch {
        return null;
      }
    },
    [pin],
  );

  // game:ended before the finale: wait a little for it, then ask for it.
  const gameId = ui.state?.gameId;
  useEffect(() => {
    if (ui.ended !== 'waiting' || !gameId) return;
    let live = true;
    const timer = setTimeout(() => {
      void fetchResults(gameId, tokenFor()).then((finale) => {
        if (!live) return;
        dispatch(finale ? { type: 'finale', finale } : { type: 'finaleTimeout' });
      });
    }, FINALE_GRACE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [ui.ended, gameId, fetchResults, tokenFor]);

  // A phone back in the finale phase got the state, not the finale: fetch it once.
  const phase = ui.state?.phase;
  const hasFinale = ui.finale !== null;
  useEffect(() => {
    if (phase !== 'finale' || hasFinale || !gameId || fetchedRef.current === gameId) return;
    fetchedRef.current = gameId;
    void fetchResults(gameId, tokenFor()).then((finale) => {
      if (finale) dispatch({ type: 'finale', finale });
    });
  }, [phase, hasFinale, gameId, fetchResults, tokenFor]);

  const socket = async () => socketRef.current ?? ensureGameSocket('guest', pin);

  /** Tries a lock. A rules refusal (`{ok:false, reason}`) resolves: it is an answer, not an error. */
  const submit = async (lockId: string, input: string | string[], roleId?: string) => {
    const ack = await emitWithAckOrError<EscapeSubmitAck>(await socket(), 'escape:submit', {
      pin,
      lockId,
      input,
      ...(roleId ? { roleId } : {}),
    });
    dispatch({ type: 'submitAck', lockId, ack });
    return ack;
  };

  const askHint = async (hintId: string) => {
    const ack = await emitWithAckOrError<EscapeAskHintAck>(await socket(), 'escape:ask-hint', {
      pin,
      hintId,
    });
    dispatch({ type: 'hintAck', ack });
    return ack;
  };

  /** Joins a team (self formation); rejects with the refusal's code (`escape.team_full`). */
  const chooseTeam = async (teamId: string) => {
    await emitWithAckOrError(await socket(), 'escape:choose-team', { pin, teamId });
  };

  /** A team race (M7): starts a team; rejects with the refusal's code. */
  const newTeam = async (name: string) =>
    emitWithAckOrError<{ teamId: string; code: string }>(await socket(), 'escape:new-team', {
      pin,
      name,
    });

  /** A team race: joins a team by its code (`escape.team_code_unknown`, `escape.team_full`). */
  const joinTeam = async (code: string) =>
    emitWithAckOrError<{ teamId: string }>(await socket(), 'escape:join-team', { pin, code });

  /** A team race, before the start (M8): leaves the team (`escape.wrong_phase` once running). */
  const leaveTeam = async () => {
    await emitWithAckOrError(await socket(), 'escape:leave-team', { pin });
  };

  /** After a reload into an ended room: the finale by the record's token, or null (record cleared). */
  const resultsFromRecord = async (): Promise<EscapeFinale | null> => {
    const record = loadEscapeRecord(pin);
    if (!record) return null;
    const finale = await fetchResults(record.gameId, record.sessionToken);
    if (finale) dispatch({ type: 'finale', finale });
    else clearEscapeRecord();
    return finale;
  };

  // No session here (a reload after the room ended, a refused reconnect): this PIN's
  // record may still hold results, looked up before the nickname form shows (§1.4).
  const noSession = session.view.status === 'no-session';
  // `unknown` until the effect looked: read once here, so a record shows no form first.
  const [lookup, setLookup] = useState<'unknown' | 'checking' | 'done'>(() =>
    loadEscapeRecord(pin) ? 'unknown' : 'done',
  );
  useEffect(() => {
    if (!noSession) {
      setLookup('unknown');
      return;
    }
    if (!loadEscapeRecord(pin)) {
      setLookup('done');
      return;
    }
    let live = true;
    setLookup('checking');
    void resultsFromRecord().then((finale) => {
      if (!live) return;
      // The room is gone: the finale is final.
      if (finale) dispatch({ type: 'gameEnded' });
      setLookup('done');
    });
    return () => {
      live = false;
    };
    // `resultsFromRecord` reads the record each time: no dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noSession, pin]);
  const checkingRecord = noSession && lookup !== 'done';

  return {
    active,
    checkingRecord,
    ui,
    look,
    dispatch: dispatch as (a: EscapeAction) => void,
    submit,
    askHint,
    chooseTeam,
    newTeam,
    joinTeam,
    leaveTeam,
    resultsFromRecord,
  };
}

export type EscapeSession = ReturnType<typeof useEscapeSession>;
