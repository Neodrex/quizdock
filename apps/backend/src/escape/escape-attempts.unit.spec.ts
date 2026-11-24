import type { GameId } from '../game/game.keys';
import type { RedisService } from '../redis/redis.service';
import { EscapeAttempts } from './escape-attempts';
import { escapeKeys } from './escape.keys';
import { EscapeTimings } from './escape-timings';

const G = 'g1' as GameId;

describe('EscapeAttempts', () => {
  function makeLimiter(wrong = 0, pttl = 42_000) {
    const timings = new EscapeTimings();
    const key = escapeKeys.wrong(G, 'a');
    const store = new Map<string, number>(wrong ? [[key, wrong]] : []);
    const calls: unknown[][] = [];
    const redis = {
      get: jest.fn(async (k: string) => (store.has(k) ? String(store.get(k)) : null)),
      pttl: jest.fn(async () => pttl),
      multi: jest.fn(() => {
        const pipe = {
          set: (...args: unknown[]) => {
            calls.push(['set', ...args]);
            const k = args[0] as string;
            if (!store.has(k)) store.set(k, Number(args[1]));
            return pipe;
          },
          incr: (k: string) => {
            calls.push(['incr', k]);
            store.set(k, (store.get(k) ?? 0) + 1);
            return pipe;
          },
          exec: async () => [],
        };
        return pipe;
      }),
    } as unknown as RedisService;
    return { limiter: new EscapeAttempts(redis, timings), redis, store, calls, key, timings };
  }

  it('keys the counter under the game id and team', () => {
    expect(escapeKeys.wrong(G, 'a')).toBe('game:g1:escape:wrong:a');
  });

  it('opens the window with SET 0 EX window NX, then INCR, in one multi()', async () => {
    const { limiter, redis, store, calls, key, timings } = makeLimiter();
    await limiter.count(G, 'a');
    expect(redis.multi).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      ['set', key, '0', 'EX', timings.wrongWindowS, 'NX'],
      ['incr', key],
    ]);
    expect(store.get(key)).toBe(1);
    await limiter.count(G, 'a');
    expect(store.get(key)).toBe(2);
  });

  it('blocks with the PTTL once at wrongMax, and not below it', async () => {
    const below = makeLimiter(new EscapeTimings().wrongMax - 1);
    await expect(below.limiter.blocked(G, 'a')).resolves.toBe(0);
    const at = makeLimiter(new EscapeTimings().wrongMax, 42_000);
    await expect(at.limiter.blocked(G, 'a')).resolves.toBe(42_000);
  });

  it('reads its limit from EscapeTimings', async () => {
    const { limiter, timings } = makeLimiter(3);
    await expect(limiter.blocked(G, 'a')).resolves.toBe(0);
    timings.wrongMax = 3;
    await expect(limiter.blocked(G, 'a')).resolves.toBe(42_000);
  });

  it('is not blocked when the window expired between the reads', async () => {
    const { limiter } = makeLimiter(new EscapeTimings().wrongMax, -2);
    await expect(limiter.blocked(G, 'a')).resolves.toBe(0);
  });

  it('never counts by checking: a right answer is never counted', async () => {
    const { limiter, redis, store } = makeLimiter();
    await limiter.blocked(G, 'a');
    expect(redis.multi).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
});

describe('EscapeTimings', () => {
  it('has the plan defaults and a 15-minute host window', () => {
    expect({ ...new EscapeTimings() }).toEqual({
      tickMs: 1000,
      stuckMs: 300_000,
      roleGraceMs: 10_000,
      wrongMax: 6,
      wrongWindowS: 60,
      boardEveryMs: 100,
      hostEveryMs: 1000,
      touchEveryMs: 300_000,
      raceMinLeadMs: 60_000,
      raceTouchEveryMs: 300_000,
      raceRetryMs: 5_000,
      siteRetryMs: 30_000,
      siteResultsRetryMs: [5_000, 15_000, 40_000, 60_000],
    });
  });
});
