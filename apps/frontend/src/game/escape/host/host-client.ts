import type { EscapeClientToServerEvents, ParticipantAccess } from '@quiz-dock/contracts';
import { connectHost, emitWithAckOrError, type GameSocket } from '../../game-client';

/** The console's commands: each answers `{ok:true, …}` or a refusal with its error code. */
export type HostEvent =
  | 'escape:open'
  | 'escape:sync'
  | 'escape:teams'
  | 'escape:move'
  | 'escape:start'
  | 'escape:pause'
  | 'escape:adjust-time'
  | 'escape:hint'
  | 'escape:unlock'
  | 'escape:end'
  | 'escape:finale';

type Handler<E extends HostEvent> = EscapeClientToServerEvents[E];
export type HostPayload<E extends HostEvent> = Parameters<Handler<E>>[0];
/** The accepted answer of `E` (`escape:hint` says how many hints it released). */
export type HostAck<E extends HostEvent> = Extract<
  Parameters<Parameters<Handler<E>>[1]>[0],
  { ok: true }
>;

/** Sends a host command; rejects on a refusal with its `code` (and its text), or on no answer. */
export function hostCommand<E extends HostEvent>(
  socket: GameSocket,
  event: E,
  payload: HostPayload<E>,
): Promise<HostAck<E>> {
  return emitWithAckOrError<HostAck<E>>(socket, event, payload);
}

export interface EscapeRoomOptions {
  pickOwnName?: boolean;
  participantAccess?: ParticipantAccess;
}

/**
 * Opens a room on a published escape template, on a fresh host socket (as
 * `createSession` does for a quiz), and gives its PIN. The length is the template's
 * (owner question 5): no `durationMin`.
 */
export async function createEscapeRoom(
  templateId: string,
  options: EscapeRoomOptions = {},
): Promise<{ pin: string }> {
  const s = await connectHost();
  const { pin } = await emitWithAckOrError<{ pin: string }>(s, 'escape:create', {
    templateId,
    ...options,
  });
  return { pin };
}
