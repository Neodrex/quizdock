import type { GameView } from '../game/use-game-session';
import type { EscapeScreenSession } from '../game/escape/screen/use-escape-screen';
import type { ScreenRole } from './screen-page';

/** The escape big screen (M6 Task 6.14). Stub until then: a heading. */
export function EscapeScreen({
  pin,
}: {
  pin: string;
  view: GameView;
  escape: EscapeScreenSession;
  role: ScreenRole;
  /** Whether a `follow` copy plays the sound. */
  sound: boolean;
}) {
  return <h1>Escape {pin}</h1>;
}
