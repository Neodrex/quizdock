import { GameState } from '@quiz-dock/contracts';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { emitWithAckOrError, ensureGameSocket, type GameSocket } from '../game-client';
import type { GameView } from '../use-game-session';

/**
 * Escape mode on and off, and the `escape:sync` that turns it on (M4 §1.1, M5 §1.1):
 * shared by the phone (`useEscapeSession`) and the host console (`useEscapeHost`).
 */

/** The wait before a sync that got no answer (an ack timeout) is sent again. */
export const SYNC_RETRY_MS = 2000;

/** The quiz states an escape room also goes through; any other means a quiz is on. */
const ESCAPE_ROOM_STATES: ReadonlySet<GameState> = new Set([
  GameState.Lobby,
  GameState.Escape,
  GameState.Podium,
  GameState.Ended,
  GameState.HostDisconnected,
]);

type QuizView = Pick<GameView, 'state' | 'totalQuestions'>;

/** The room shows a quiz: no escape run to follow. */
export function quizIsOn({ state, totalQuestions }: QuizView): boolean {
  return totalQuestions > 0 || (state !== null && !ESCAPE_ROOM_STATES.has(state));
}

/**
 * Whether escape mode is on, turned off whenever the room shows a quiz. `quizOnRef`
 * reads the latest view from callbacks (a quiz shown meanwhile wins over a late ack).
 */
export function useEscapeMode(view: QuizView) {
  const [active, setActive] = useState(false);
  const quizOn = quizIsOn(view);
  const quizOnRef = useRef(quizOn);
  quizOnRef.current = quizOn;
  // Each quiz state turns it off again: an escape view pushed meanwhile does not win.
  const { state, totalQuestions } = view;
  useEffect(() => {
    if (quizIsOn({ state, totalQuestions })) setActive(false);
  }, [state, totalQuestions]);
  return { active, setActive, quizOnRef };
}

export interface EscapeSyncOptions {
  quizOnRef: RefObject<boolean>;
  /** Bumped by each view the server pushes: one that came makes a sync with no answer moot. */
  heardRef: RefObject<number>;
  socketRef: { current: GameSocket | null };
  setActive: (on: boolean) => void;
  /** Called before each sync (the phone drops a stale record there). */
  before?: () => void;
  /** No sync while true (the console between back-to-lobby and escape:open). */
  holdRef?: RefObject<boolean>;
}

/**
 * Sends `escape:sync` once the socket is in the room: once per `attachSeq` bump, and
 * again on each `resync` bump. `{ok:true}` turns escape mode on, `escape.not_found`
 * off; no answer at all is retried after SYNC_RETRY_MS, unless a view came meanwhile.
 */
export function useEscapeSync(
  pin: string,
  role: 'host' | 'guest',
  attachSeq: number,
  resync: number,
  opts: EscapeSyncOptions,
): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  useEffect(() => {
    const o = optsRef.current;
    if (attachSeq === 0 || o.quizOnRef.current || o.holdRef?.current) return;
    o.before?.();
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const sync = () =>
      void ensureGameSocket(role, pin).then((sock) => {
        // A retry scheduled before the hold began: the hold's end bumps `resync`.
        if (!live || optsRef.current.holdRef?.current) return;
        const { socketRef, heardRef, quizOnRef, setActive } = optsRef.current;
        socketRef.current = sock;
        // Down: socket.io would buffer the sync and flush it ahead of the reattach,
        // when the server would not know the socket yet. The next attach syncs.
        if (!sock.connected) return;
        const seen = heardRef.current;
        // A hold begun while the sync was out: its answer is moot (the hold's end syncs).
        const held = () => !live || !!optsRef.current.holdRef?.current;
        emitWithAckOrError(sock, 'escape:sync', { pin }).then(
          // A quiz shown meanwhile wins: that room is not (or no longer) an escape run.
          () => !held() && !quizOnRef.current && setActive(true),
          (e: { code?: string }) => {
            if (held()) return;
            if (e.code === 'escape.not_found') setActive(false);
            // No answer at all (an ack timeout, no code): again, unless a view came meanwhile.
            else if (!e.code && heardRef.current === seen && !quizOnRef.current && sock.connected) {
              retry = setTimeout(sync, SYNC_RETRY_MS);
            }
          },
        );
      });
    sync();
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [pin, role, attachSeq, resync]);
}
