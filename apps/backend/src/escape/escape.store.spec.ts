import { type EscapeFinale, GameState } from '@quiz-dock/contracts';
import { GAME_TTL_S, type GameId, gameKeys } from '../game/game.keys';
import { RedisService } from '../redis/redis.service';
import { onTestRedis } from '../../test/test-targets';
import type { EscapeRun, EscapeSnapshot, TeamRecord } from './escape-live.types';
import { newTeam } from './escape-rules';
import { escapeKeys } from './escape.keys';
import { EscapeStore } from './escape.store';
import { tpl } from './fixtures';

/** Against the worker's test Redis (see the Jest global setup). */
describe('EscapeStore (Redis)', () => {
  let redis: RedisService;
  let store: EscapeStore;
  let id: GameId;
  let n = 0;

  const snapshot: EscapeSnapshot = { templateId: tpl.id, version: 3, template: tpl, takenAt: 1 };
  const run: EscapeRun = {
    phase: 'forming',
    formation: 'self',
    maxSize: 4,
    teamIds: ['t1', 't2'],
    clock: { startedAt: 0, pausedAt: 0, pausedMs: 0, endedElapsedMs: null, limitMs: 3_600_000 },
  };
  const record = (teamId: string, members: string[]): TeamRecord => ({
    team: newTeam(tpl, teamId, `Team ${teamId}`, members),
    lastProgressAt: 0,
    stuck: false,
    timedOut: false,
  });
  const finale: EscapeFinale = {
    gameId: 'g1',
    title: 'Vault',
    finale: 'Out!',
    ranking: [
      {
        teamId: 't1',
        name: 'Team t1',
        place: 1,
        scoreMs: 1000,
        escaped: true,
        stagesCleared: 2,
        stageClearedAt: [500, 1000],
        hintsUsed: 1,
        paidHints: 0,
        hintPenaltyS: 0,
        adjustMs: 0,
        hostUnlocks: 0,
        members: ['Ann'],
      },
    ],
    awards: { fastest: 't1', fewestHints: 't1', teamwork: null, photoFinish: null },
  };
  const allKeys = () => [
    escapeKeys.room(id),
    escapeKeys.host(id),
    escapeKeys.template(id),
    escapeKeys.run(id),
    escapeKeys.teams(id),
    escapeKeys.members(id),
    escapeKeys.results(id),
  ];

  beforeAll(() => {
    if (!onTestRedis()) {
      throw new Error('REDIS_URL must point at the test database (see test/jest.global-setup.ts)');
    }
    redis = new RedisService();
  });

  beforeEach(() => {
    id = `store-test-${Date.now()}-${n++}` as GameId;
    store = new EscapeStore(redis);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await redis.del(...allKeys());
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('round-trips every record', async () => {
    await store.writeOpen(id, '123456', 'host-1', snapshot, run);
    await store.save(id, {
      teams: [record('t1', ['p1', 'p2']), record('t2', ['p3'])],
      members: { set: { p1: 't1', p2: 't1', p3: 't2' } },
    });
    await store.saveResults(id, finale);

    expect(await new EscapeStore(redis).snapshot(id)).toEqual(snapshot);
    expect(await store.run(id)).toEqual(run);
    expect(await store.roomOf(id)).toBe('123456');
    expect(await store.hostOf(id)).toBe('host-1');
    const teams = await store.teams(id);
    expect([...teams.keys()].sort()).toEqual(['t1', 't2']);
    expect(teams.get('t1')).toEqual(record('t1', ['p1', 'p2']));
    expect(await store.team(id, 't2')).toEqual(record('t2', ['p3']));
    expect(await store.team(id, 'nope')).toBeNull();
    expect(await store.teamOfPlayer(id, 'p3')).toBe('t2');
    expect(await store.teamOfPlayer(id, 'nobody')).toBeNull();
    expect(await store.results(id)).toEqual(finale);

    const running: EscapeRun = { ...run, phase: 'running', clock: { ...run.clock, startedAt: 5 } };
    await store.saveRun(id, running);
    expect(await store.run(id)).toEqual(running);
  });

  it('reads nothing for a game that has none', async () => {
    expect(await store.snapshot(id)).toBeNull();
    expect(await store.hostOf(id)).toBeNull();
    expect(await store.run(id)).toBeNull();
    expect((await store.teams(id)).size).toBe(0);
    expect(await store.results(id)).toBeNull();
  });

  it('refuses a record that does not have the stored shape, rather than trusting it', async () => {
    await redis.set(escapeKeys.run(id), JSON.stringify({ ...run, phase: 'dancing' }));
    await expect(store.run(id)).rejects.toThrow();
    await redis.hset(escapeKeys.teams(id), 't1', JSON.stringify({ team: { id: 't1' } }));
    await expect(store.team(id, 't1')).rejects.toThrow();
  });

  it('gives every key it writes the game TTL', async () => {
    await store.writeOpen(id, '123456', 'host-1', snapshot, run);
    await store.save(id, {
      run,
      teams: [record('t1', ['p1'])],
      members: { set: { p1: 't1' } },
    });
    await store.saveResults(id, finale);
    for (const key of allKeys()) {
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(GAME_TTL_S);
    }
  });

  it('touch gives every key of the run the game TTL again, in one MULTI', async () => {
    await store.writeOpen(id, '123456', 'host-1', snapshot, run);
    await store.save(id, { teams: [record('t1', ['p1'])], members: { set: { p1: 't1' } } });
    await store.saveResults(id, finale);
    for (const key of allKeys()) await redis.expire(key, 5);
    const multi = jest.spyOn(redis, 'multi');
    await store.touch(id);
    expect(multi).toHaveBeenCalledTimes(1);
    for (const key of allKeys()) expect(await redis.ttl(key)).toBeGreaterThan(GAME_TTL_S - 5);
  });

  it('moves a player in one MULTI: both teams and the members index', async () => {
    await store.writeOpen(id, '123456', 'host-1', snapshot, run);
    await store.save(id, {
      teams: [record('t1', ['p1', 'p2']), record('t2', [])],
      members: { set: { p1: 't1', p2: 't1' } },
    });
    const multi = jest.spyOn(redis, 'multi');
    await store.save(id, {
      teams: [record('t1', ['p1']), record('t2', ['p2'])],
      members: { set: { p2: 't2' } },
    });
    expect(multi).toHaveBeenCalledTimes(1);
    expect((await store.team(id, 't2'))?.team.members).toEqual(['p2']);
    expect(await store.teamOfPlayer(id, 'p2')).toBe('t2');

    await store.save(id, { teams: [record('t2', [])], members: { del: ['p2'] } });
    expect(await store.teamOfPlayer(id, 'p2')).toBeNull();
  });

  it('replaces every team and the whole members index in one MULTI', async () => {
    await store.writeOpen(id, '123456', 'host-1', snapshot, run);
    await store.save(id, {
      teams: [record('t1', ['p1']), record('t2', ['p2'])],
      members: { set: { p1: 't1', p2: 't2' } },
    });
    const multi = jest.spyOn(redis, 'multi');
    await store.save(id, {
      replace: true,
      teams: [record('t1', ['p2'])],
      members: { set: { p2: 't1' } },
    });
    expect(multi).toHaveBeenCalledTimes(1);
    expect([...(await store.teams(id)).keys()]).toEqual(['t1']);
    expect(await store.teamOfPlayer(id, 'p1')).toBeNull();
    expect(await store.teamOfPlayer(id, 'p2')).toBe('t1');

    await store.save(id, { replace: true });
    expect((await store.teams(id)).size).toBe(0);
  });

  it('keeps the snapshot it read: no second GET', async () => {
    await store.writeOpen(id, '123456', 'host-1', snapshot, run);
    const fresh = new EscapeStore(redis);
    const get = jest.spyOn(redis, 'get');
    await fresh.snapshot(id);
    await fresh.snapshot(id);
    expect(get.mock.calls.filter(([key]) => key === escapeKeys.template(id))).toHaveLength(1);
  });

  describe('setGameState', () => {
    const game = () => gameKeys.game(id);
    afterEach(() => redis.del(game()));

    it('writes the state over any live one and returns the one before', async () => {
      await redis.hset(game(), { state: GameState.Lobby, prevState: '' });
      expect(await store.setGameState(id, GameState.Escape)).toBe(GameState.Lobby);
      expect(await redis.hgetall(game())).toEqual({ state: GameState.Escape, prevState: '' });
    });

    it('while the host is away, writes the state the host comes back to', async () => {
      await redis.hset(game(), { state: GameState.HostDisconnected, prevState: GameState.Escape });
      expect(await store.setGameState(id, GameState.Podium)).toBe(GameState.HostDisconnected);
      expect(await redis.hgetall(game())).toEqual({
        state: GameState.HostDisconnected,
        prevState: GameState.Podium,
      });
    });

    it('leaves an ended game ended, and writes nothing for a game that is gone', async () => {
      await redis.hset(game(), { state: GameState.Ended, prevState: '' });
      expect(await store.setGameState(id, GameState.Podium)).toBe(GameState.Ended);
      expect(await redis.hgetall(game())).toEqual({ state: GameState.Ended, prevState: '' });
      await redis.del(game());
      expect(await store.setGameState(id, GameState.Podium)).toBeNull();
      expect(await redis.exists(game())).toBe(0);
    });
  });
});
