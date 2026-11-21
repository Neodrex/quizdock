import type {
  EscapePlayerState,
  EscapeSubmitAck,
  EscapeTemplateContent,
} from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { EscapeTimings } from '../../src/escape/escape-timings';
import type { EscapeTemplate } from '../../src/escape/escape.types';
import { type GameHarness, nextEvent, settle } from '../game-harness';

/**
 * Helpers of the escape integration tests (M3 plan §5), on top of the game
 * harness: one app per entry spec, real sockets. Outside `src/`, never shipped.
 */

/** What the entry spec shares with each domain's tests (test/escape/*.ts). */
export interface EscapeContext {
  h: GameHarness;
  /** The published Vault Heist sample, owned by the host. */
  templateId: string;
  /** The same template as the engine freezes it (for leaksIn). */
  vault: EscapeTemplate;
}

const seeded = new WeakMap<GameHarness, string[]>();

/** A template owned by the host, removed by `dropTemplates`. */
export async function seedTemplate(
  h: GameHarness,
  content: EscapeTemplateContent,
  status: 'draft' | 'published' = 'published',
): Promise<string> {
  const row = await h.prisma.escapeTemplate.create({
    data: {
      ownerId: h.hostUserId,
      title: content.title,
      status,
      content,
      version: status === 'published' ? 1 : 0,
    },
  });
  seeded.set(h, [...(seeded.get(h) ?? []), row.id]);
  return row.id;
}

export async function dropTemplates(h: GameHarness): Promise<void> {
  const ids = seeded.get(h) ?? [];
  await h.prisma.escapeTemplate.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
}

/** The test timings of §1.5. */
export function fastTimings(h: GameHarness): EscapeTimings {
  return Object.assign(h.app.get(EscapeTimings), {
    tickMs: 50,
    stuckMs: 300,
    roleGraceMs: 150,
    wrongMax: 3,
    wrongWindowS: 1,
    boardEveryMs: 50,
  });
}

/** Creates an escape room of `templateId` from `host` and returns its PIN. */
export async function createEscape(host: Socket, templateId: string): Promise<string> {
  const ack = (await host.emitWithAck('escape:create', { templateId })) as { pin?: string };
  if (!ack.pin) throw new Error(`escape:create refused: ${JSON.stringify(ack)}`);
  return ack.pin;
}

export interface SyncedPlayer {
  socket: Socket;
  playerId: string;
  sessionToken: string;
  nickname: string;
  /** Every escape:state this phone got, oldest first. */
  states: EscapePlayerState[];
  /** The last one. */
  last(): EscapePlayerState;
}

/** A player joined to `pin` who sent `escape:sync`; its states are kept from before the sync. */
export async function joinAndSync(
  h: GameHarness,
  pin: string,
  nickname: string,
): Promise<SyncedPlayer> {
  const { socket, playerId, sessionToken } = await h.join(pin, nickname);
  const states: EscapePlayerState[] = [];
  socket.on('escape:state', (s: EscapePlayerState) => states.push(s));
  const ack = await socket.emitWithAck('escape:sync', { pin });
  if (!ack.ok) throw new Error(`escape:sync refused: ${JSON.stringify(ack)}`);
  return {
    socket,
    playerId,
    sessionToken,
    nickname,
    states,
    last: () => {
      const s = states.at(-1);
      if (!s) throw new Error(`${nickname} got no escape:state`);
      return s;
    },
  };
}

/** The next `escape:state` of `socket` matching `pred`. */
export function stateWhere(
  socket: Socket,
  pred: (s: EscapePlayerState) => boolean,
  timeoutMs?: number,
): Promise<EscapePlayerState> {
  return nextEvent<EscapePlayerState>(socket, 'escape:state', { where: pred, timeoutMs });
}

/**
 * The first `escape:state` matching `pred` on any of `sockets`. One timer, and
 * every listener goes once one matches: no waiter is left behind (a race of
 * `stateWhere` would keep the losers' timers running past the test).
 */
export function firstStateWhere(
  sockets: Socket[],
  pred: (s: EscapePlayerState, i: number) => boolean,
  timeoutMs = 5_000,
): Promise<EscapePlayerState> {
  return new Promise((resolve, reject) => {
    const listeners = sockets.map((socket, i) => {
      const l = (s: EscapePlayerState) => {
        if (!pred(s, i)) return;
        done();
        resolve(s);
      };
      socket.on('escape:state', l);
      return () => socket.off('escape:state', l);
    });
    const timer = setTimeout(() => {
      done();
      reject(new Error(`no matching 'escape:state' within ${timeoutMs} ms`));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      for (const off of listeners) off();
    };
  });
}

/** Every event `socket` gets from now on, as `[event, payload]`. */
export function record(socket: Socket): [string, unknown][] {
  const seen: [string, unknown][] = [];
  socket.onAny((event: string, payload: unknown) => seen.push([event, payload]));
  return seen;
}

/** Retries `fn` until it stops throwing, for a window that must expire. */
export async function eventually<T>(fn: () => Promise<T>, timeoutMs = 3_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > until) throw err;
      await settle(50);
    }
  }
}

/** A started run: the host console, the phones by team, and a synced screen. */
export interface RunningRoom {
  host: Socket;
  pin: string;
  players: SyncedPlayer[];
  /** Phones by team id, in join order. */
  teams: Record<string, SyncedPlayer[]>;
  screen: Socket;
}

/**
 * A run of `templateId` (Vault Heist by default) with `players` phones dealt in
 * `teams` auto teams and started; every phone has its running state.
 * `beforeStart` runs once the teams exist, before the first tick.
 */
export async function runningRoom(
  ctx: EscapeContext,
  opts: {
    players: number;
    teams: number;
    templateId?: string;
    beforeStart?: (pin: string, room: Omit<RunningRoom, 'teams'>) => Promise<void>;
  },
): Promise<RunningRoom> {
  const host = ctx.h.connectHost();
  const pin = await createEscape(host, opts.templateId ?? ctx.templateId);
  await ok(host.emitWithAck('escape:sync', { pin }), 'host sync');
  const players: SyncedPlayer[] = [];
  for (let i = 0; i < opts.players; i++) players.push(await joinAndSync(ctx.h, pin, `P${i}`));
  const screen = ctx.h.connect();
  await screen.emitWithAck('spectator:join', { pin });
  await ok(screen.emitWithAck('escape:sync', { pin }), 'screen sync');
  await ok(host.emitWithAck('escape:teams', { pin, mode: 'auto', count: opts.teams }), 'teams');
  await opts.beforeStart?.(pin, { host, pin, players, screen });
  const running = players.map((p) => stateWhere(p.socket, (s) => s.phase === 'running'));
  await ok(host.emitWithAck('escape:start', { pin }), 'start');
  await Promise.all(running);
  const teams: Record<string, SyncedPlayer[]> = {};
  for (const p of players) (teams[p.last().team!.id] ??= []).push(p);
  return { host, pin, players, teams, screen };
}

async function ok(ack: Promise<unknown>, what: string): Promise<void> {
  const res = (await ack) as { ok?: boolean };
  if (!res.ok) throw new Error(`${what} refused: ${JSON.stringify(res)}`);
}

/** A player's submit, acked. */
export function submitAs(
  p: SyncedPlayer,
  pin: string,
  lockId: string,
  input: string | string[],
  roleId?: string,
): Promise<EscapeSubmitAck> {
  return p.socket.emitWithAck('escape:submit', { pin, lockId, input, roleId });
}
