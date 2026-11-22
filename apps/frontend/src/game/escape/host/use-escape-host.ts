import type { useGameSession } from '../../use-game-session';

/**
 * The host console's escape session (M5 §1.1): on while the room runs an escape
 * game. A stub for the console seam; Task 5.7 adds its listeners and commands.
 */
export function useEscapeHost(
  pin: string,
  session: ReturnType<typeof useGameSession>,
): { active: boolean } {
  void pin;
  void session;
  return { active: false };
}
