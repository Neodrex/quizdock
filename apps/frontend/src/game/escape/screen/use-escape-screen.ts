import {
  type EscapeAnnounce,
  type EscapeBoard,
  type EscapeScreenFinale,
  GameState,
} from '@quiz-dock/contracts';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { GameSocket } from '../../game-client';
import type { GameView } from '../../use-game-session';
import { useEscapeMode, useEscapeSync } from '../escape-sync';
import { useEscapeLook } from '../session/use-escape-look';
import {
  clearScreenRecord,
  loadScreenRecord,
  markScreenReplayed,
  saveScreenRecord,
} from './screen-record';
import { initialScreenUi, screenReducer } from './screen-reducer';

/** What the hook needs of the quiz session (`useGameSession(pin, 'spectator')`). */
export interface EscapeScreenSeam {
  view: Pick<GameView, 'state' | 'totalQuestions' | 'status'>;
  attachSeq: number;
  /** The session's socket: the escape listeners go on it, beside the quiz's. */
  socket: GameSocket | null;
}

type Listener = (p: never) => void;

/**
 * The big screen's escape run (M6 §1.1, §1.6), on the projection's socket: syncs once
 * the spectator is in the room (each `attachSeq` bump) and again on a room switch,
 * follows the board, the announces and the screen finale, and keeps the finale's
 * record so a reload does not replay the race and a closed room still shows it.
 */
export function useEscapeScreen(pin: string, session: EscapeScreenSeam) {
  const [ui, dispatch] = useReducer(screenReducer, initialScreenUi);
  const { active, setActive, quizOnRef } = useEscapeMode(session.view);
  const socketRef = useRef<GameSocket | null>(null);
  // Bumped on each board: one that came makes a sync with no answer moot.
  const heardRef = useRef(0);
  // A sync went out: the next finale is its answer (a reload), which the record may
  // say was replayed already. Any later one is "Show the finale again".
  // Known race, harmless: a "Show the finale again" that lands between a sync and the
  // sync's own finale is taken for the answer (no replay), and the answer that follows
  // then replays; either way the room sees one replay. A sync while the run is on
  // leaves the flag up until the finale, whose record is then another run's or none.
  const syncedRef = useRef(false);
  const finaleRef = useRef(false);
  // The run the last board was for: a kept finale of another run is not this room's now.
  const runRef = useRef<string | null>(null);
  const [resync, setResync] = useState(0);

  const { socket } = session;
  // The room's brand and colours (M7 §1.9).
  const look = useEscapeLook(pin, 'guest', session.attachSeq, session.view.state);
  useEffect(() => {
    if (!socket) return;
    const onBoard = (board: EscapeBoard) => {
      heardRef.current += 1;
      if (!quizOnRef.current) setActive(true);
      if (runRef.current !== board.gameId) {
        runRef.current = board.gameId;
        const record = loadScreenRecord(pin);
        if (record && record.gameId !== board.gameId) clearScreenRecord(pin);
      }
      dispatch({ type: 'board', board });
    };
    const onAnnounce = (announce: EscapeAnnounce) =>
      dispatch({ type: 'announce', announce, now: Date.now() });
    const onFinale = (finale: EscapeScreenFinale) => {
      finaleRef.current = true;
      const record = syncedRef.current ? loadScreenRecord(pin) : null;
      syncedRef.current = false;
      // Kept as replayed from the start: a reload in the middle of the replay shows the
      // standings (§1.6, the replay runs once); this page still plays it unless the
      // record already said so.
      saveScreenRecord(pin, { gameId: finale.gameId, replayed: true, finale });
      dispatch({ type: 'screenFinale', finale, record });
    };
    const events: [string, Listener][] = [
      ['escape:board', onBoard as Listener],
      ['escape:announce', onAnnounce as Listener],
      ['escape:screen-finale', onFinale as Listener],
    ];
    const on = socket.on as unknown as (e: string, h: Listener) => void;
    for (const [e, h] of events) on.call(socket, e, h);
    return () => {
      const off = socket.off as unknown as (e: string, h: Listener) => void;
      for (const [e, h] of events) off.call(socket, e, h);
    };
  }, [pin, socket, setActive, quizOnRef]);

  useEscapeSync(pin, 'guest', session.attachSeq, resync, {
    quizOnRef,
    heardRef,
    socketRef,
    setActive,
    before: () => {
      syncedRef.current = true;
    },
  });

  // Room switch (§1.1): the lobby after a podium or a screen finale; sync again, and a
  // refusal hands the screen back to the quiz.
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

  // The room is gone (game:ended, or the join refused on a reload): this PIN's kept
  // finale stays up with "Thanks for playing"; with none, upstream's screen says why.
  const gone = state === GameState.Ended || session.view.status === 'error';
  const [closedWithRecord, setClosedWithRecord] = useState(false);
  useEffect(() => {
    if (!gone) return;
    const record = loadScreenRecord(pin);
    // Another run's finale (the storage could not drop it): not this run's standings.
    if (!record || (runRef.current !== null && record.gameId !== runRef.current)) return;
    if (!finaleRef.current) dispatch({ type: 'screenFinale', finale: record.finale, record });
    dispatch({ type: 'closed' });
    setClosedWithRecord(true);
  }, [gone, pin]);

  // The banner shown goes at its time, and the next one comes.
  const until = ui.current?.until;
  useEffect(() => {
    if (until === undefined) return;
    const id = setTimeout(
      () => dispatch({ type: 'next', now: Date.now() }),
      Math.max(0, until - Date.now()),
    );
    return () => clearTimeout(id);
  }, [until, ui.current?.id]);

  // The run resumed: the banners held during the pause come.
  const paused = ui.board?.clock.paused ?? false;
  useEffect(() => {
    if (!paused) dispatch({ type: 'next', now: Date.now() });
  }, [paused]);

  const gameId = ui.finale?.gameId;
  /** The split-time replay was played: a reload shows the standings straight away. */
  const replayDone = useCallback(() => {
    if (gameId) markScreenReplayed(pin, gameId);
    dispatch({ type: 'replay', replay: 'done' });
  }, [pin, gameId]);

  return { active: active || closedWithRecord, ui, replayDone, look };
}

export type EscapeScreenSession = ReturnType<typeof useEscapeScreen>;
