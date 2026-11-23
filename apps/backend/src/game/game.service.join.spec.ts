import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { GAME_TTL_S, type GameId, gameKeys } from './game.keys';
import { GameService, oneLine, sanitizeNickname } from './game.service';

/**
 * RG-15 — le nom affiché d'un participant : celui de son compte tant que l'hôte
 * n'ouvre pas le choix, celui qu'il saisit sinon. Les homonymes sont distingués,
 * pas refusés (deux comptes peuvent porter le même nom).
 */
describe('GameService.joinSession (nom affiché)', () => {
  const PIN = '123456';
  const meta = (
    pickOwnName: boolean,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    roomId: 'r1',
    gameId: 'g1',
    quizId: 'q1',
    hostUserId: 'h1',
    state: 'LOBBY',
    currentIndex: '-1',
    totalQuestions: '1',
    fullCapture: '0',
    personalTracking: '1',
    pickOwnName: pickOwnName ? '1' : '0',
    title: 'Q',
    language: 'fr',
    createdAt: '1000',
    questionStartedAt: '0',
    questionEndsAt: '0',
    mode: 'manual',
    paused: '0',
    clockFrozen: '0',
    ...extra,
  });

  function makeService(
    pickOwnName: boolean,
    taken: string[] = [],
    extra: Record<string, string> = {},
  ) {
    const claimed = new Set(taken);
    const redis = {
      hgetall: jest.fn(async (key: string) =>
        // The room and its game, from one flat record (each reads its own fields).
        key === gameKeys.room(PIN) || key === gameKeys.game('g1' as GameId)
          ? meta(pickOwnName, extra)
          : {},
      ),
      exists: jest.fn().mockResolvedValue(0),
      // No room cap (room:<pin>:cap): no limit.
      get: jest.fn().mockResolvedValue(null),
      sadd: jest.fn(async (_key: string, member: string) => {
        if (claimed.has(member)) return 0;
        claimed.add(member);
        return 1;
      }),
      // The join itself (player, token, score) runs as one script.
      eval: jest.fn().mockResolvedValue(1),
    } as unknown as RedisService;
    return new GameService({} as PrismaService, redis);
  }

  const user = { id: 'u1', displayName: 'Alice Account' };

  it('takes the account name when the host did not open the choice', async () => {
    const res = await makeService(false).joinSession(PIN, 'Whatever', user);
    expect(res.nickname).toBe('Alice Account');
  });

  it('keeps the typed nickname when participants pick their own name', async () => {
    const res = await makeService(true).joinSession(PIN, 'Whatever', user);
    expect(res.nickname).toBe('Whatever');
  });

  it('keeps the typed nickname for a guest, whatever the option', async () => {
    const res = await makeService(false).joinSession(PIN, 'Whatever', null);
    expect(res.nickname).toBe('Whatever');
  });

  it('discriminates homonyms instead of refusing them', async () => {
    const res = await makeService(false, ['alice account']).joinSession(PIN, 'Whatever', user);
    expect(res.nickname).toBe('Alice Account (2)');
  });

  it('still refuses a typed nickname already taken', async () => {
    await expect(
      makeService(true, ['whatever']).joinSession(PIN, 'Whatever', user),
    ).rejects.toThrow(ConflictException);
  });

  describe('participant access (RG-15, #57)', () => {
    const authMode = process.env.AUTH_MODE;
    beforeEach(() => {
      process.env.AUTH_MODE = 'oidc';
    });
    afterEach(() => {
      if (authMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = authMode;
    });

    it('refuses a guest under oidc when the game requires accounts', async () => {
      await expect(makeService(false).joinSession(PIN, 'Guest', null)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lets a guest in with the PIN and a nickname in open access', async () => {
      const res = await makeService(true, [], { participantAccess: 'open' }).joinSession(
        PIN,
        'Guest',
        null,
      );
      expect(res.nickname).toBe('Guest');
    });

    it('treats a signed-in participant as a guest in open access', async () => {
      // Even with the name choice closed, no account name is taken: they are all guests.
      const res = await makeService(false, [], { participantAccess: 'open' }).joinSession(
        PIN,
        'Typed',
        user,
      );
      expect(res.nickname).toBe('Typed');
    });

    it('keeps the PIN as the only barrier in local mode', async () => {
      process.env.AUTH_MODE = 'none';
      const res = await makeService(false).joinSession(PIN, 'Guest', null);
      expect(res.nickname).toBe('Guest');
    });

    it('refuses newcomers once the host closed the game', async () => {
      await expect(
        makeService(true, [], { participantAccess: 'open', joinLocked: '1' }).joinSession(
          PIN,
          'Late',
          null,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

/**
 * The room cap (escape M7 §1.5): an optional `room:<pin>:cap` holds the seats,
 * every player record of the room counting, connected or not. Against the real
 * Redis of the worker: the check inside the join script is what is atomic.
 */
describe('GameService.joinSession (room cap)', () => {
  const PIN = '990011';
  let redis: RedisService;
  let game: GameService;
  const flat: Record<string, string> = {
    roomId: 'r-cap',
    gameId: 'g-cap',
    quizId: 'q1',
    hostUserId: 'h1',
    state: 'LOBBY',
    currentIndex: '-1',
    totalQuestions: '1',
    fullCapture: '0',
    personalTracking: '1',
    pickOwnName: '1',
    title: 'Q',
    language: 'fr',
    createdAt: '1000',
    questionStartedAt: '0',
    questionEndsAt: '0',
    mode: 'manual',
    paused: '0',
    clockFrozen: '0',
  };

  const clean = async () => {
    const keys = [...(await redis.keys(`room:${PIN}*`)), ...(await redis.keys('game:g-cap*'))];
    if (keys.length) await redis.del(...keys);
  };

  beforeAll(async () => {
    // Loaded here: the worker's REDIS_URL is set by then.
    const { RedisService: Real } = await import('../redis/redis.service');
    redis = new Real();
    game = new GameService({} as PrismaService, redis);
  });

  beforeEach(async () => {
    await clean();
    await redis.hset(gameKeys.room(PIN), flat);
    await redis.hset(gameKeys.game('g-cap' as GameId), flat);
  });

  afterAll(async () => {
    await clean();
    await redis.quit();
  });

  const cap = (n: number) => redis.set(gameKeys.roomCap(PIN), String(n));
  const join = (name: string) => game.joinSession(PIN, name, null);
  const seats = () => redis.hlen(gameKeys.players(PIN));

  it('no cap key: no limit', async () => {
    for (let i = 0; i < 8; i++) await join(`P${i}`);
    expect(await seats()).toBe(8);
  });

  it('cap 2: the third join is refused, and its nickname stays free', async () => {
    await cap(2);
    await join('Ann');
    await join('Bob');
    await expect(join('Cyd')).rejects.toThrow(
      expect.objectContaining({ message: 'session.full' }) as Error,
    );
    await expect(join('Cyd')).rejects.toThrow(ForbiddenException);
    expect(await seats()).toBe(2);
    expect(await redis.sismember(gameKeys.nicknames(PIN), 'cyd')).toBe(0);
    // A seat freed (the cap raised here), the refused name is anyone's.
    await cap(3);
    expect((await join('Cyd')).nickname).toBe('Cyd');
  });

  it('20 joins at once at cap 6 give exactly 6 players', async () => {
    await cap(6);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => join(`Racer${i}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect(await seats()).toBe(6);
    expect(await redis.scard(gameKeys.nicknames(PIN))).toBe(6);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as Error).message).toBe('session.full');
    }
  });

  it('a join gives the cap key the TTL of the room again; no cap key stays none', async () => {
    await join('Ann');
    expect(await redis.exists(gameKeys.roomCap(PIN))).toBe(0);
    await redis.set(gameKeys.roomCap(PIN), '6', 'EX', 10);
    await join('Bob');
    expect(await redis.ttl(gameKeys.roomCap(PIN))).toBe(GAME_TTL_S);
  });

  it('a ban frees a seat', async () => {
    await cap(2);
    const a = await join('Ann');
    await join('Bob');
    await expect(join('Cyd')).rejects.toThrow(ForbiddenException);
    await game.banPlayer(PIN, 'g-cap' as GameId, a.playerId, 5);
    expect((await join('Cyd')).nickname).toBe('Cyd');
  });

  it('a player of a full room comes back with their token', async () => {
    await cap(1);
    const a = await join('Ann');
    await game.setConnected(PIN, a.playerId, false);
    await expect(join('Bob')).rejects.toThrow(ForbiddenException);
    expect(await game.resolveSession(a.sessionToken)).toMatchObject({
      pin: PIN,
      playerId: a.playerId,
    });
    expect(await game.setConnected(PIN, a.playerId, true)).toMatchObject({ connected: true });
  });
});

describe('names typed by a client', () => {
  it('keeps one line: control characters (NUL included) become spaces', () => {
    expect(oneLine('  Ana\u0000\n  Bel\u007f ')).toBe('Ana Bel');
    expect(sanitizeNickname('ab\u0000')).toBe('ab');
  });

  it('takes nothing else than text', () => {
    expect(oneLine(42)).toBe('');
    expect(oneLine({ name: 'x' })).toBe('');
    expect(() => sanitizeNickname(42 as unknown as string)).toThrow();
  });
});
