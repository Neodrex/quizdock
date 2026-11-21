import type { GameId } from '../game/game.keys';
import { RedisService } from '../redis/redis.service';
import { onTestRedis } from '../../test/test-targets';
import { EscapeAttempts } from './escape-attempts';
import { escapeKeys } from './escape.keys';
import { EscapeTimings } from './escape-timings';

/** Against the worker's test Redis (see the Jest global setup). */
describe('EscapeAttempts (Redis)', () => {
  let redis: RedisService;
  const gameId = `attempts-test-${Date.now()}` as GameId;
  const timings = Object.assign(new EscapeTimings(), { wrongMax: 3, wrongWindowS: 1 });

  beforeAll(() => {
    if (!onTestRedis()) {
      throw new Error('REDIS_URL must point at the test database (see test/jest.global-setup.ts)');
    }
    redis = new RedisService();
  });

  afterAll(async () => {
    await redis.del(escapeKeys.wrong(gameId, 'a'), escapeKeys.wrong(gameId, 'b'));
    await redis.quit();
  });

  it('blocks a team at wrongMax for the rest of its window, then lets it answer', async () => {
    const limiter = new EscapeAttempts(redis, timings);
    for (let i = 0; i < 2; i++) await limiter.count(gameId, 'a');
    await expect(limiter.blocked(gameId, 'a')).resolves.toBe(0);
    await limiter.count(gameId, 'a');
    const wait = await limiter.blocked(gameId, 'a');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(1000);
    await expect(limiter.blocked(gameId, 'b')).resolves.toBe(0);
    await new Promise((r) => setTimeout(r, wait + 50));
    await expect(limiter.blocked(gameId, 'a')).resolves.toBe(0);
    expect(await redis.exists(escapeKeys.wrong(gameId, 'a'))).toBe(0);
  });

  it('keeps the window the first failure opened', async () => {
    const limiter = new EscapeAttempts(redis, timings);
    await limiter.count(gameId, 'b');
    const first = await redis.pttl(escapeKeys.wrong(gameId, 'b'));
    await new Promise((r) => setTimeout(r, 200));
    await limiter.count(gameId, 'b');
    expect(await redis.get(escapeKeys.wrong(gameId, 'b'))).toBe('2');
    expect(await redis.pttl(escapeKeys.wrong(gameId, 'b'))).toBeLessThan(first);
  });
});
