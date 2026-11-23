import type { EscapeHostState } from '@quiz-dock/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ensureGameSocket, type GameSocket } from '../../game-client';
import { type HostAck, type HostEvent, type HostPayload, hostCommand } from './host-client';

/** What the phone host bar reads of the host state: counts, never a team's details. */
export interface PhoneHostRoom {
  joined: number;
  cap: number;
  /** Someone is in a team: Start can go. */
  ready: boolean;
}

/** The counts the bar shows, from a host state (pure). */
export function phoneHostRoomOf(host: EscapeHostState): PhoneHostRoom {
  const players = host.unassigned.length + host.teams.reduce((n, t) => n + t.members.length, 0);
  return {
    joined: host.session?.joined ?? players,
    cap: host.session?.cap ?? players,
    ready: host.teams.some((t) => t.members.length > 0),
  };
}

/**
 * Group play's phone host (M7 Task 7.16): the phone is also the room's host console,
 * so the server sends it the host state on sync. The bar keeps only the seat count
 * and whether Start can go, and sends the M3 host commands on the phone's socket.
 * Off (`enabled` false): no listener, nothing sent.
 */
export function usePhoneHost(pin: string, enabled: boolean) {
  const [room, setRoom] = useState<PhoneHostRoom | null>(null);
  const socketRef = useRef<GameSocket | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let s: GameSocket | null = null;
    const onHost = (host: EscapeHostState) => setRoom(phoneHostRoomOf(host));
    void ensureGameSocket('guest', pin).then((sock) => {
      if (!live) return;
      s = sock;
      socketRef.current = sock;
      sock.on('escape:host', onHost);
    });
    return () => {
      live = false;
      s?.off('escape:host', onHost);
    };
  }, [pin, enabled]);

  const send = useCallback(
    async <E extends HostEvent>(event: E, payload: HostPayload<E>): Promise<HostAck<E>> => {
      const sock = socketRef.current ?? (await ensureGameSocket('guest', pin));
      return hostCommand(sock, event, payload);
    },
    [pin],
  );

  return { room, send };
}

export type PhoneHost = ReturnType<typeof usePhoneHost>;
