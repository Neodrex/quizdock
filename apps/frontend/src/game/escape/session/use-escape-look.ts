import { type EscapeLook, GameState } from '@quiz-dock/contracts';
import { useEffect, useRef, useState } from 'react';
import { type GameSocket, ensureGameSocket } from '../../game-client';

/** Unbranded: the page's own look. */
export const NO_LOOK: EscapeLook = { theme: null, brand: null };

/**
 * The room's colours and brand (M7 §1.9), from `escape:look`: the server sends it to
 * every synced socket once per sync, static per room. Kept until the room switches:
 * back to the lobby after a finale (`game:state LOBBY` after PODIUM or ENDED) drops it, and the next
 * escape sync sends the new room's look, if any. Shared by the console, the phone and
 * the screens; the listener goes with the page. It takes the socket itself, as the
 * page's sync does (`role` as there): the look of the first sync comes right after
 * the socket is there, before the page renders again with it.
 */
export function useEscapeLook(
  pin: string,
  role: 'host' | 'guest',
  roomState: string | null | undefined,
): EscapeLook {
  const [look, setLook] = useState<EscapeLook>(NO_LOOK);

  useEffect(() => {
    let live = true;
    let s: GameSocket | null = null;
    const onLook = (l: EscapeLook) => setLook(l);
    void ensureGameSocket(role, pin).then((sock) => {
      if (!live || !sock) return;
      s = sock;
      sock.on('escape:look', onLook);
    });
    return () => {
      live = false;
      s?.off('escape:look', onLook);
    };
  }, [pin, role]);

  const prevRef = useRef(roomState);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = roomState;
    // Only the lobby after a finale is a new room: the host coming back
    // (HOST_DISCONNECTED, then LOBBY) is the same one.
    if (roomState === GameState.Lobby && (prev === GameState.Podium || prev === GameState.Ended)) {
      setLook(NO_LOOK);
    }
  }, [roomState]);

  return look;
}
