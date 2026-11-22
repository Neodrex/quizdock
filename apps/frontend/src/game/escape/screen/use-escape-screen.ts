import type { GameView } from '../../use-game-session';

/** What the hook needs of the quiz session (`useGameSession(pin, 'spectator')`). */
export interface EscapeScreenSeam {
  view: Pick<GameView, 'state' | 'totalQuestions'>;
  attachSeq: number;
}

/** The big screen's escape run (M6 §1.1). Stub until Task 6.6: never active. */
export function useEscapeScreen(pin: string, session: EscapeScreenSeam) {
  void pin;
  void session;
  return { active: false };
}

export type EscapeScreenSession = ReturnType<typeof useEscapeScreen>;
