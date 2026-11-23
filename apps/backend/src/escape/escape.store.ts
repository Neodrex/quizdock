import { Injectable } from '@nestjs/common';
import {
  BUILTIN_THEMES,
  ESCAPE_SESSION_TYPES,
  type EscapeFinale,
  GameState,
  escapeTemplateContentSchema,
} from '@quiz-dock/contracts';
import { z } from 'zod';
import { gameKeys, type GameId } from '../game/game.keys';
import { RedisService } from '../redis/redis.service';
import type { EscapeRun, EscapeSession, EscapeSnapshot, TeamRecord } from './escape-live.types';
import { ESCAPE_TTL_S, escapeKeys, escapeRoomKeys } from './escape.keys';
import type { Same, TeamState } from './escape.types';

/** Parsed snapshots kept in memory, as GameService keeps quiz snapshots. */
const SNAPSHOT_CACHE_MAX = 50;

const ms = z.number();
const ids = z.array(z.string());

/*
 * Every record read back from Redis is parsed again, never cast: a key written
 * by an older build (or by hand) fails loudly here instead of deep in the rules.
 * The `Same` checks keep each schema equal to the type the engine uses.
 */
const snapshotSchema = z.object({
  templateId: z.string(),
  version: z.number().int(),
  template: escapeTemplateContentSchema.extend({ id: z.string() }),
  takenAt: ms,
});
const runSchema = z.object({
  phase: z.enum(['forming', 'running', 'finale']),
  formation: z.enum(['auto', 'self']),
  maxSize: z.number().int().min(0),
  teamIds: ids,
  clock: z.object({
    startedAt: ms,
    pausedAt: ms,
    pausedMs: ms,
    endedElapsedMs: ms.nullable(),
    limitMs: ms,
  }),
});
const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  members: ids,
  roles: z.record(z.string(), ids),
  stageIndex: z.number().int(),
  solved: ids,
  parts: z.record(z.string(), ids),
  wrong: z.number().int(),
  hintsUsed: ids,
  paidHints: ids,
  hintPenaltyS: z.number(),
  adjustMs: ms,
  stageClearedAt: z.array(ms),
  escapedAt: ms.nullable(),
  hostUnlocks: ids,
  solvesBy: z.record(z.string(), z.number().int()),
});
const teamRecordSchema = z.object({
  team: teamSchema,
  lastProgressAt: ms,
  stuck: z.boolean(),
  timedOut: z.boolean(),
  code: z.string().optional(),
});
const finaleSchema = z.object({
  gameId: z.string(),
  title: z.string(),
  finale: z.string(),
  ranking: z.array(
    z.object({
      teamId: z.string(),
      name: z.string(),
      place: z.number().int(),
      scoreMs: ms.nullable(),
      escaped: z.boolean(),
      stagesCleared: z.number().int(),
      stageClearedAt: z.array(ms),
      hintsUsed: z.number().int(),
      paidHints: z.number().int(),
      hintPenaltyS: z.number(),
      adjustMs: ms,
      hostUnlocks: z.number().int(),
      members: ids,
    }),
  ),
  awards: z.object({
    fastest: z.string().nullable(),
    fewestHints: z.string().nullable(),
    teamwork: z.string().nullable(),
    photoFinish: z.tuple([z.string(), z.string()]).nullable(),
  }),
});

const sessionSchema = z.object({
  type: z.enum(ESCAPE_SESSION_TYPES),
  cap: z.number().int().min(1),
  race: z
    .object({
      format: z.enum(['solo', 'teams']),
      startsAt: ms.nullable(),
      started: z.boolean(),
    })
    .nullable(),
  licence: z
    .object({
      id: z.string(),
      organisationId: z.string(),
      participantCap: z.number().int(),
      expiresAt: ms,
      package: z.enum(['single', 'bundle', 'annual']),
      brand: z
        .object({
          name: z.string(),
          logoUrl: z.string().nullable(),
          accent: z.string(),
          background: z.string().nullable(),
          baseTheme: z.enum(BUILTIN_THEMES),
          intro: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
  licenceUsed: z.boolean(),
  phoneHostUserId: z.string().nullable(),
});

export const storedShapesMatch: [
  Same<z.infer<typeof snapshotSchema>, EscapeSnapshot>,
  Same<z.infer<typeof runSchema>, EscapeRun>,
  Same<z.infer<typeof teamSchema>, TeamState>,
  Same<z.infer<typeof teamRecordSchema>, TeamRecord>,
  Same<z.infer<typeof finaleSchema>, EscapeFinale>,
  Same<z.infer<typeof sessionSchema>, EscapeSession>,
] = [true, true, true, true, true, true];

const parseJson = <T>(schema: z.ZodType<T>, raw: string | null): T | null =>
  raw === null ? null : schema.parse(JSON.parse(raw));

/**
 * A game's state, set unless the room moved meanwhile: under HOST_DISCONNECTED it
 * becomes the state the host comes back to (prevState); an ENDED game keeps
 * ENDED; a game hash that is gone gets nothing. The state before, or nil.
 * KEYS[1] the game hash; ARGV the state, ENDED, HOST_DISCONNECTED.
 */
const SET_GAME_STATE_SCRIPT = `
local cur = redis.call('HGET', KEYS[1], 'state')
if not cur or cur == ARGV[2] then return cur end
if cur == ARGV[3] then
  redis.call('HSET', KEYS[1], 'prevState', ARGV[1])
else
  redis.call('HSET', KEYS[1], 'state', ARGV[1])
end
return cur
`;

/** What one `save` writes, all in one MULTI. */
export interface EscapeWrite {
  run?: EscapeRun;
  /** Drop every team and the whole members index first (new teams, or empty ones dropped at start). */
  replace?: boolean;
  /** Each record replaces the team of the same id. */
  teams?: TeamRecord[];
  /** The members index: playerId → teamId to set, playerIds to drop. */
  members?: { set?: Record<string, string>; del?: string[] };
}

/** An escape run's records in Redis, under its game id (M3 plan §1.4). */
@Injectable()
export class EscapeStore {
  private readonly snapshots = new Map<GameId, EscapeSnapshot>();

  constructor(private readonly redis: RedisService) {}

  /**
   * A run opens in room `pin` for its host: its frozen template and its first
   * run record. With `session`, the room's session and its cap key (M7 §1.5).
   */
  async writeOpen(
    id: GameId,
    pin: string,
    hostUserId: string,
    snapshot: EscapeSnapshot,
    run: EscapeRun,
    session?: EscapeSession,
  ): Promise<void> {
    const pipe = this.redis.multi();
    if (session) {
      pipe.set(escapeRoomKeys.session(pin), JSON.stringify(session), 'EX', ESCAPE_TTL_S);
      pipe.set(gameKeys.roomCap(pin), String(session.cap), 'EX', ESCAPE_TTL_S);
    }
    pipe.set(escapeKeys.room(id), pin, 'EX', ESCAPE_TTL_S);
    pipe.set(escapeKeys.host(id), hostUserId, 'EX', ESCAPE_TTL_S);
    pipe.set(escapeKeys.template(id), JSON.stringify(snapshot), 'EX', ESCAPE_TTL_S);
    pipe.set(escapeKeys.run(id), JSON.stringify(run), 'EX', ESCAPE_TTL_S);
    await pipe.exec();
    this.remember(id, snapshot);
  }

  /** The room's session (null: a quiz room, or gone). */
  async session(pin: string): Promise<EscapeSession | null> {
    return parseJson(sessionSchema, await this.redis.get(escapeRoomKeys.session(pin)));
  }

  /** Rewrites the room's session (its race and licence flags); the cap key is left as it is. */
  async writeSession(pin: string, session: EscapeSession): Promise<void> {
    await this.redis.set(escapeRoomKeys.session(pin), JSON.stringify(session), 'EX', ESCAPE_TTL_S);
  }

  /** The room's session and cap key get the TTL again. */
  async touchRoom(pin: string): Promise<void> {
    const pipe = this.redis.multi();
    pipe.expire(escapeRoomKeys.session(pin), ESCAPE_TTL_S);
    pipe.expire(gameKeys.roomCap(pin), ESCAPE_TTL_S);
    await pipe.exec();
  }

  /** The frozen template (null when gone or expired). */
  async snapshot(id: GameId): Promise<EscapeSnapshot | null> {
    const cached = this.snapshots.get(id);
    if (cached) return cached;
    const snapshot = parseJson(snapshotSchema, await this.redis.get(escapeKeys.template(id)));
    return snapshot ? this.remember(id, snapshot) : null;
  }

  /** The PIN of the room the run was opened in (null when gone or expired). */
  roomOf(id: GameId): Promise<string | null> {
    return this.redis.get(escapeKeys.room(id));
  }

  /** The user id of the run's host (null when gone or expired). */
  hostOf(id: GameId): Promise<string | null> {
    return this.redis.get(escapeKeys.host(id));
  }

  async run(id: GameId): Promise<EscapeRun | null> {
    return parseJson(runSchema, await this.redis.get(escapeKeys.run(id)));
  }

  saveRun(id: GameId, run: EscapeRun): Promise<void> {
    return this.save(id, { run });
  }

  /** Every team of the run, by team id. */
  async teams(id: GameId): Promise<Map<string, TeamRecord>> {
    const raw = await this.redis.hgetall(escapeKeys.teams(id));
    return new Map(
      Object.entries(raw).map(([teamId, json]) => [
        teamId,
        teamRecordSchema.parse(JSON.parse(json)),
      ]),
    );
  }

  async team(id: GameId, teamId: string): Promise<TeamRecord | null> {
    return parseJson(teamRecordSchema, await this.redis.hget(escapeKeys.teams(id), teamId));
  }

  /** The team a player is in, null when in none. */
  async teamOfPlayer(id: GameId, playerId: string): Promise<string | null> {
    return this.redis.hget(escapeKeys.members(id), playerId);
  }

  /** Writes the run, teams and members index together; each key written gets the TTL again. */
  async save(id: GameId, write: EscapeWrite): Promise<void> {
    const teams = write.teams ?? [];
    const set = write.members?.set ?? {};
    const del = write.members?.del ?? [];
    const members = Object.keys(set).length > 0 || del.length > 0;
    if (!write.run && !write.replace && !teams.length && !members) return;
    const pipe = this.redis.multi();
    if (write.replace) pipe.del(escapeKeys.teams(id), escapeKeys.members(id));
    if (write.run) pipe.set(escapeKeys.run(id), JSON.stringify(write.run), 'EX', ESCAPE_TTL_S);
    if (teams.length) {
      const key = escapeKeys.teams(id);
      pipe.hset(key, Object.fromEntries(teams.map((r) => [r.team.id, JSON.stringify(r)])));
      pipe.expire(key, ESCAPE_TTL_S);
    }
    if (members) {
      const key = escapeKeys.members(id);
      if (Object.keys(set).length) pipe.hset(key, set);
      if (del.length) pipe.hdel(key, ...del);
      pipe.expire(key, ESCAPE_TTL_S);
    }
    await pipe.exec();
  }

  /**
   * Sets the game's state in one step against the host's absence and the end of
   * the room (SET_GAME_STATE_SCRIPT). The state it found; `state` itself was
   * written only when that is neither ENDED nor HOST_DISCONNECTED (nor null).
   */
  async setGameState(id: GameId, state: GameState): Promise<GameState | null> {
    const prev = (await this.redis.eval(
      SET_GAME_STATE_SCRIPT,
      1,
      gameKeys.game(id),
      state,
      GameState.Ended,
      GameState.HostDisconnected,
    )) as string | null;
    return (prev as GameState | null) ?? null;
  }

  /**
   * Every key of the run gets the game TTL again, in one MULTI: a long run (or a
   * podium kept open) outlives the TTL its keys were last written with.
   */
  async touch(id: GameId): Promise<void> {
    const pipe = this.redis.multi();
    for (const key of [
      escapeKeys.room(id),
      escapeKeys.host(id),
      escapeKeys.template(id),
      escapeKeys.run(id),
      escapeKeys.teams(id),
      escapeKeys.members(id),
      escapeKeys.results(id),
    ]) {
      pipe.expire(key, ESCAPE_TTL_S);
    }
    await pipe.exec();
  }

  /** The final ranking and awards (null until the finale). */
  async results(id: GameId): Promise<EscapeFinale | null> {
    return parseJson(finaleSchema, await this.redis.get(escapeKeys.results(id)));
  }

  async saveResults(id: GameId, finale: EscapeFinale): Promise<void> {
    await this.redis.set(escapeKeys.results(id), JSON.stringify(finale), 'EX', ESCAPE_TTL_S);
  }

  /** Keeps a run's snapshot parsed, the least recently kept going first. */
  private remember(id: GameId, snapshot: EscapeSnapshot): EscapeSnapshot {
    this.snapshots.delete(id);
    this.snapshots.set(id, snapshot);
    if (this.snapshots.size > SNAPSHOT_CACHE_MAX) {
      this.snapshots.delete(this.snapshots.keys().next().value as GameId);
    }
    return snapshot;
  }
}
