import { Logger, UseFilters } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import {
  escapeAdjustTimeSchema,
  escapeAskHintSchema,
  escapeChooseTeamSchema,
  escapeCreateSchema,
  escapeHintSchema,
  escapeMoveSchema,
  escapeOpenSchema,
  escapePauseSchema,
  escapePinSchema,
  escapeSubmitSchema,
  escapeTeamsSchema,
  escapeUnlockSchema,
  type EscapeAskHintAck,
  type EscapeSubmitAck,
} from '@quiz-dock/contracts';
import type { User } from '@prisma/client';
import type { z } from 'zod';
import { isHost } from '../auth/roles';
import { sameOriginHandshake } from '../game/game.gateway';
import { WsExceptionFilter } from '../game/ws-exception.filter';
import { EscapeEngine, type EscapeSocket } from './escape.engine';

type Ok = { ok: true };
const OK: Ok = { ok: true };

/** An inbound payload through its contract schema; anything else is `validation`. */
function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WsException('validation');
  return parsed.data;
}

/**
 * The escape events of the `/game` namespace (M3 plan §2). A second gateway on
 * the same namespace: it sees the same sockets and `socket.data` (identity from
 * GameGateway's auth middleware). Its options are GameGateway's, word for word:
 * only the gateway Nest creates first sets them on the server.
 */
@UseFilters(WsExceptionFilter)
@WebSocketGateway({ namespace: '/game', allowRequest: sameOriginHandshake })
export class EscapeGateway implements OnGatewayInit, OnGatewayDisconnect {
  private readonly log = new Logger(EscapeGateway.name);

  constructor(private readonly engine: EscapeEngine) {}

  afterInit(server: Parameters<EscapeEngine['bindServer']>[0]): void {
    this.engine.bindServer(server);
  }

  /** O1: the socket becomes the room's host control, as after `host:create`. */
  @SubscribeMessage('escape:create')
  async create(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<{ pin: string }> {
    const hostId = this.requireHostId(socket);
    const pin = await this.engine.create(hostId, parse(escapeCreateSchema, payload));
    socket.data.pin = pin;
    socket.data.isHostControl = true;
    await socket.join(pin);
    return { pin };
  }

  @SubscribeMessage('escape:open')
  async open(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    const dto = parse(escapeOpenSchema, payload);
    await this.engine.open(dto.pin, this.requireHostId(socket), dto);
    return OK;
  }

  @SubscribeMessage('escape:sync')
  async sync(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    await this.engine.sync(socket, parse(escapePinSchema, payload).pin);
    return OK;
  }

  @SubscribeMessage('escape:teams')
  async teams(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    const hostId = this.requireHostId(socket);
    const dto = parse(escapeTeamsSchema, payload);
    await this.engine.teams(dto.pin, hostId, dto);
    return OK;
  }

  @SubscribeMessage('escape:move')
  async move(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    const hostId = this.requireHostId(socket);
    const dto = parse(escapeMoveSchema, payload);
    await this.engine.move(dto.pin, hostId, dto);
    return OK;
  }

  @SubscribeMessage('escape:start')
  async start(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    const hostId = this.requireHostId(socket);
    await this.engine.start(parse(escapePinSchema, payload).pin, hostId);
    return OK;
  }

  @SubscribeMessage('escape:choose-team')
  async chooseTeam(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    const dto = parse(escapeChooseTeamSchema, payload);
    await this.engine.chooseTeam(socket, dto.pin, dto.teamId);
    return OK;
  }

  /** U1–U5: refusals are in the ack (`{ ok: false, reason }`), not errors. */
  @SubscribeMessage('escape:submit')
  async submit(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<EscapeSubmitAck> {
    return this.engine.submit(socket, parse(escapeSubmitSchema, payload));
  }

  /** H1: refusals are in the ack, as for submit. */
  @SubscribeMessage('escape:ask-hint')
  async askHint(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<EscapeAskHintAck> {
    return this.engine.askHint(socket, parse(escapeAskHintSchema, payload));
  }

  /** H2: the host releases the next hint to one team, or to every team still playing. */
  @SubscribeMessage('escape:hint')
  async hint(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok & { released: number }> {
    const hostId = this.requireHostId(socket);
    const dto = parse(escapeHintSchema, payload);
    return { ok: true, released: await this.engine.hostHint(dto.pin, hostId, dto.teamId) };
  }

  /** P1: one event with a flag pauses or resumes, as `host:pause`. */
  @SubscribeMessage('escape:pause')
  async pause(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    const hostId = this.requireHostId(socket);
    const dto = parse(escapePauseSchema, payload);
    await this.engine.pause(dto.pin, hostId, dto.paused);
    return OK;
  }

  /** T1: ±deltaS for one team or every team still in the run (deadline only). */
  @SubscribeMessage('escape:adjust-time')
  async adjustTime(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    const hostId = this.requireHostId(socket);
    const dto = parse(escapeAdjustTimeSchema, payload);
    await this.engine.adjustTime(dto.pin, hostId, dto);
    return OK;
  }

  /** K1: the host opens a lock of a team's current stage; nobody is credited. */
  @SubscribeMessage('escape:unlock')
  async unlock(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    const hostId = this.requireHostId(socket);
    const dto = parse(escapeUnlockSchema, payload);
    await this.engine.unlock(dto.pin, hostId, dto);
    return OK;
  }

  /** E1: the host ends the run now; the finale follows. */
  @SubscribeMessage('escape:end')
  async end(@ConnectedSocket() socket: EscapeSocket, @MessageBody() payload: unknown): Promise<Ok> {
    const hostId = this.requireHostId(socket);
    const dto = parse(escapePinSchema, payload);
    await this.engine.end(dto.pin, hostId);
    return OK;
  }

  /** E2: the finale to the whole room (ends a running run first; again from the finale). */
  @SubscribeMessage('escape:finale')
  async finale(
    @ConnectedSocket() socket: EscapeSocket,
    @MessageBody() payload: unknown,
  ): Promise<Ok> {
    const hostId = this.requireHostId(socket);
    const dto = parse(escapePinSchema, payload);
    await this.engine.showFinale(dto.pin, hostId);
    return OK;
  }

  /** R2: a player's socket left; a stale one (the player is back on another) changes nothing. */
  async handleDisconnect(socket: EscapeSocket): Promise<void> {
    const { pin, playerId } = socket.data;
    if (!pin || !playerId) return;
    await this.engine.playerGone(pin, playerId).catch((err: Error) => {
      this.log.warn(`playerGone ${pin}/${playerId}: ${err.message}`);
    });
  }

  /** As GameGateway.requireHost: signed in, with the `host` role. */
  private requireHost(socket: EscapeSocket): User {
    const host = socket.data.user;
    if (!host) throw new WsException('host.auth_required');
    if (!isHost(host.roles)) throw new WsException('auth.host_required');
    return host;
  }

  private requireHostId(socket: EscapeSocket): string {
    return this.requireHost(socket).id;
  }
}
