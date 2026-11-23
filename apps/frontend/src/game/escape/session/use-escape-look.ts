import { type EscapeLook, GameState } from '@quiz-dock/contracts';
import { useEffect, useRef, useState } from 'react';
import type { GameSocket } from '../../game-client';

/** Unbranded: the page's own look. */
export const NO_LOOK: EscapeLook = { theme: null, brand: null };

/**
 * The room's colours and brand (M7 §1.9), from `escape:look`: the server sends it to
 * every synced socket once per sync, static per room. Kept until the room switches:
 * back to the lobby after a finale (`game:state LOBBY` after PODIUM or ENDED) drops it, and the next
 * escape sync sends the new room's look, if any. Shared by the console, the phone and
 * the screens; the listener goes with the page.
 */
export function useEscapeLook(
  socket: GameSocket | null,
  roomState: string | null | undefined,
): EscapeLook {
  const [look, setLook] = useState<EscapeLook>(NO_LOOK);

  useEffect(() => {
    if (!socket) return;
    const onLook = (l: EscapeLook) => setLook(l);
    socket.on('escape:look', onLook);
    return () => {
      socket.off('escape:look', onLook);
    };
  }, [socket]);

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
