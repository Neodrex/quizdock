import { Injectable } from '@nestjs/common';
import { type EscapeFinale, escapeTemplateContentSchema } from '@quiz-dock/contracts';
import { z } from 'zod';
import type { GameId } from '../game/game.keys';
import { RedisService } from '../redis/redis.service';
import type { EscapeRun, EscapeSnapshot, TeamRecord } from './escape-live.types';
import { ESCAPE_TTL_S, escapeKeys } from './escape.keys';
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
  phase: z.enum(['forming', 'running', 'finished', 'finale']),
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
});
const finaleSchema = z.object({
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

export const storedShapesMatch: [
  Same<z.infer<typeof snapshotSchema>, EscapeSnapshot>,
  Same<z.infer<typeof runSchema>, EscapeRun>,
  Same<z.infer<typeof teamSchema>, TeamState>,
  Same<z.infer<typeof teamRecordSchema>, TeamRecord>,
  Same<z.infer<typeof finaleSchema>, EscapeFinale>,
] = [true, true, true, true, true];

const parseJson = <T>(schema: z.ZodType<T>, raw: string | null): T | null =>
  raw === null ? null : schema.parse(JSON.parse(raw));

/** What one `save` writes, all in one MULTI. */
export interface EscapeWrite {
  run?: EscapeRun;
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

  /** A run opens: its frozen template and its first run record. */
  async writeOpen(id: GameId, snapshot: EscapeSnapshot, run: EscapeRun): Promise<void> {
    const pipe = this.redis.multi();
    pipe.set(escapeKeys.template(id), JSON.stringify(snapshot), 'EX', ESCAPE_TTL_S);
    pipe.set(escapeKeys.run(id), JSON.stringify(run), 'EX', ESCAPE_TTL_S);
    await pipe.exec();
    this.remember(id, snapshot);
  }

  /** The frozen template (null when gone or expired). */
  async snapshot(id: GameId): Promise<EscapeSnapshot | null> {
    const cached = this.snapshots.get(id);
    if (cached) return cached;
    const snapshot = parseJson(snapshotSchema, await this.redis.get(escapeKeys.template(id)));
    return snapshot ? this.remember(id, snapshot) : null;
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
    if (!write.run && !teams.length && !members) return;
    const pipe = this.redis.multi();
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
