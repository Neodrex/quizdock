import { Injectable } from '@nestjs/common';
import type { GameId } from '../game/game.keys';
import { RedisService } from '../redis/redis.service';
import { escapeKeys } from './escape.keys';
import { EscapeTimings } from './escape-timings';
import { CODE_ATTEMPTS_MAX, CODE_ATTEMPTS_WINDOW_S } from './race-codes';

/**
 * Wrong answers per team (M3 plan U2), as pin-attempts: only failures count,
 * and a blocked team waits for the end of the window, right answer or not.
 */
@Injectable()
export class EscapeAttempts {
  constructor(
    private readonly redis: RedisService,
    private readonly timings: EscapeTimings,
  ) {}

  /** Ms left in the window once the team is at `wrongMax`; 0 when it may answer. */
  async blocked(gameId: GameId, teamId: string): Promise<number> {
    const key = escapeKeys.wrong(gameId, teamId);
    const wrong = Number((await this.redis.get(key)) ?? 0);
    if (wrong < this.timings.wrongMax) return 0;
    // -2: the window closed between the two reads; -1 cannot happen (see count).
    return Math.max(0, await this.redis.pttl(key));
  }

  /** Counts one wrong answer. */
  async count(gameId: GameId, teamId: string): Promise<void> {
    const key = escapeKeys.wrong(gameId, teamId);
    // The first failure opens the window (SET … NX with its expiry); INCR keeps
    // that expiry, so a key never outlives its window.
    await this.redis.multi().set(key, '0', 'EX', this.timings.wrongWindowS, 'NX').incr(key).exec();
  }

  /** Whether a player typed `CODE_ATTEMPTS_MAX` wrong team codes in the window (M7 §1.7). */
  async codesBlocked(gameId: GameId, playerId: string): Promise<boolean> {
    const wrong = Number((await this.redis.get(escapeKeys.wrongCodes(gameId, playerId))) ?? 0);
    return wrong >= CODE_ATTEMPTS_MAX;
  }

  /** Counts one wrong team code, as `count`. */
  async countCode(gameId: GameId, playerId: string): Promise<void> {
    const key = escapeKeys.wrongCodes(gameId, playerId);
    await this.redis.multi().set(key, '0', 'EX', CODE_ATTEMPTS_WINDOW_S, 'NX').incr(key).exec();
  }
}
