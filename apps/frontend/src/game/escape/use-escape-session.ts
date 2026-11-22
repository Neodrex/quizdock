import {
  type EscapeAskHintAck,
  type EscapeFinale,
  type EscapePlayerState,
  type EscapeSubmitAck,
  type EscapeTeamUpdate,
  GameState,
} from '@quiz-dock/contracts';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  ensureGameSocket,
  emitWithAckOrError,
  type GameSocket,
  loadPlayerSession,
} from '../game-client';
import type { GameView } from '../use-game-session';
import { clearEscapeRecord, loadEscapeRecord, saveEscapeRecord } from './escape-record';
import { type EscapeAction, escapeReducer, initialEscapeUi } from './escape-reducer';

/** How long a phone waits for the finale after `game:ended` before fetching it (§1.4). */
export const FINALE_GRACE_MS = 3000;

/** The quiz states an escape room also goes through; any other means a quiz is on. */
const ESCAPE_ROOM_STATES: ReadonlySet<GameState> = new Set([
  GameState.Lobby,
  GameState.Escape,
  GameState.Podium,
  GameState.Ended,
  GameState.HostDisconnected,
]);

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
  const [active, setActive] = useState(false);
  const socketRef = useRef<GameSocket | null>(null);
  const stateRef = useRef<EscapePlayerState | null>(null);
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
      setActive(true);
      const session = loadPlayerSession();
      if (
        session?.pin === pin &&
        (prev?.gameId !== state.gameId || prev?.team?.id !== state.team?.id)
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

  // A quiz is on in this room: no escape run to follow.
  const { state: quizState, totalQuestions } = session.view;
  const quizOn = totalQuestions > 0 || (quizState !== null && !ESCAPE_ROOM_STATES.has(quizState));
  const quizOnRef = useRef(quizOn);
  quizOnRef.current = quizOn;

  // Sync once the player is in the room: before that the server would take the phone for a screen.
  const { attachSeq } = session;
  useEffect(() => {
    if (attachSeq === 0 || quizOnRef.current) return;
    // A join into a new session: the last run's record (and its token) is not this player's.
    const s = loadPlayerSession();
    const record = loadEscapeRecord(pin);
    if (record && s?.pin === pin && s.sessionToken !== record.sessionToken) clearEscapeRecord();
    let live = true;
    void ensureGameSocket('guest', pin).then((sock) => {
      if (!live) return;
      socketRef.current = sock;
      emitWithAckOrError(sock, 'escape:sync', { pin }).then(
        // A quiz shown meanwhile wins: that room is not (or no longer) an escape run.
        () => live && !quizOnRef.current && setActive(true),
        (e: { code?: string }) => {
          if (live && e.code === 'escape.not_found') setActive(false);
        },
      );
    });
    return () => {
      live = false;
    };
  }, [pin, attachSeq]);

  // The room went (back) to a quiz.
  useEffect(() => {
    if (totalQuestions > 0 || (quizState !== null && !ESCAPE_ROOM_STATES.has(quizState))) {
      setActive(false);
    }
  }, [quizState, totalQuestions]);

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
  const [lookupDone, setLookupDone] = useState(false);
  useEffect(() => {
    if (!noSession) {
      setLookupDone(false);
      return;
    }
    if (!loadEscapeRecord(pin)) {
      setLookupDone(true);
      return;
    }
    let live = true;
    void resultsFromRecord().then((finale) => {
      if (!live) return;
      // The room is gone: the finale is final.
      if (finale) dispatch({ type: 'gameEnded' });
      setLookupDone(true);
    });
    return () => {
      live = false;
    };
    // `resultsFromRecord` reads the record each time: no dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noSession, pin]);
  const checkingRecord = noSession && !lookupDone && loadEscapeRecord(pin) !== null;

  return {
    active,
    checkingRecord,
    ui,
    dispatch: dispatch as (a: EscapeAction) => void,
    submit,
    askHint,
    chooseTeam,
    resultsFromRecord,
  };
}

export type EscapeSession = ReturnType<typeof useEscapeSession>;
