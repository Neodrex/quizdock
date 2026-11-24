/**
 * Races of the M6 screens: state writes of the escape engine against the
 * host's absence, in both orders. Not the M7 races of players (`race.ts`).
 */
import { GameState } from '@quiz-dock/contracts';
import { GameEngine } from '../../src/game/game.engine';
import { gameHash } from '../../src/game/game-hash';
import { gameKeys, type GameId } from '../../src/game/game.keys';
import { GameService } from '../../src/game/game.service';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { EscapeStore } from '../../src/escape/escape.store';
import { RedisService } from '../../src/redis/redis.service';
import { settle } from '../game-harness';
import {
  type EscapeContext,
  createEscape,
  joinAndSync,
  record,
  runningRoom,
} from './escape-harness';
import { screenLeaksIn } from './leaks';

/** GameEngine's private host-absence steps, driven by hand to interleave them. */
interface HostAbsence {
  declareHostDisconnected(ref: { pin: string; id: GameId }, hostUserId: string): Promise<void>;
  countHostSockets(pin: string, hostUserId: string): Promise<number>;
  freezeClock(pin: string, meta: unknown): Promise<void>;
}

/** State writes of the escape engine against the host's absence (atomic, both orders). */
export function raceTests(ctx: EscapeContext): void {
  const metaOf = async (pin: string) => (await ctx.h.app.get(GameService).getMeta(pin))!;
  const absence = () => ctx.h.app.get(GameEngine) as unknown as HostAbsence;

  /** A forming room with one auto team and one phone. */
  async function formingRoom() {
    const host = ctx.h.connectHost();
    const pin = await createEscape(host, ctx.templateId);
    await host.emitWithAck('escape:sync', { pin });
    const p = await joinAndSync(ctx.h, pin, 'Ann');
    await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 });
    return { host, pin, p, meta: await metaOf(pin) };
  }

  /** GameEngine.declareHostDisconnected, as the grace timer runs it, the host's sockets ignored. */
  async function declareAway(pin: string): Promise<void> {
    const engine = absence();
    const meta = await metaOf(pin);
    const count = jest.spyOn(engine, 'countHostSockets').mockResolvedValueOnce(0);
    try {
      await engine.declareHostDisconnected({ pin, id: meta.id }, meta.hostUserId);
    } finally {
      count.mockRestore();
    }
  }

  afterEach(() => jest.restoreAllMocks());

  it('escape:start is refused unless the game is in its lobby', async () => {
    const { host, pin, meta } = await formingRoom();
    const redis = ctx.h.app.get(RedisService);
    await redis.hset(gameKeys.game(meta.id), gameHash({ state: GameState.Podium }));
    expect(await host.emitWithAck('escape:start', { pin })).toMatchObject({
      ok: false,
      error: { code: 'escape.wrong_phase' },
    });
    expect((await ctx.h.app.get(EscapeStore).run(meta.id))!.phase).toBe('forming');
  });

  it('host away read before escape:start writes: the run is what the host comes back to', async () => {
    const { host, pin, meta } = await formingRoom();
    const engine = absence();
    const freeze = engine.freezeClock.bind(engine);
    // declareHostDisconnected has read LOBBY; the run starts before it writes.
    jest.spyOn(engine, 'freezeClock').mockImplementationOnce(async (...args) => {
      await freeze(...args);
      await ctx.h.app.get(EscapeEngine).start(pin, {
        userId: meta.hostUserId,
        email: null,
        oidcSubject: '',
      });
    });
    await declareAway(pin);
    const away = await metaOf(pin);
    expect(away.state).toBe(GameState.HostDisconnected);
    expect(away.prevState).toBe(GameState.Escape);
    expect(await host.emitWithAck('host:attach', { pin })).toMatchObject({ ok: true });
    expect((await metaOf(pin)).state).toBe(GameState.Escape);
  });

  it('host away between escape:start and its state write: the state stays HOST_DISCONNECTED', async () => {
    const { host, pin, p, meta } = await formingRoom();
    const seen = record(p.socket);
    const store = ctx.h.app.get(EscapeStore);
    const save = store.save.bind(store);
    jest.spyOn(store, 'save').mockImplementationOnce(async (...args) => {
      await save(...args);
      await declareAway(pin);
    });
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    const away = await metaOf(pin);
    expect(away.state).toBe(GameState.HostDisconnected);
    expect(away.prevState).toBe(GameState.Escape);
    await settle(100);
    const states = seen.filter(([e]) => e === 'game:state').map(([, s]) => s);
    expect(states).not.toContainEqual(expect.objectContaining({ state: GameState.Escape }));
    expect((await store.run(meta.id))!.phase).toBe('running');
    expect(await host.emitWithAck('host:attach', { pin })).toMatchObject({ ok: true });
    expect((await metaOf(pin)).state).toBe(GameState.Escape);
  });

  it('host away between the finale and its state write: PODIUM waits in prevState', async () => {
    const { host, pin, players } = await runningRoom(ctx, { players: 1, teams: 1 });
    const seen = record(players[0].socket);
    const store = ctx.h.app.get(EscapeStore);
    const saveResults = store.saveResults.bind(store);
    jest.spyOn(store, 'saveResults').mockImplementationOnce(async (...args) => {
      await saveResults(...args);
      await declareAway(pin);
    });
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    const away = await metaOf(pin);
    expect(away.state).toBe(GameState.HostDisconnected);
    expect(away.prevState).toBe(GameState.Podium);
    await settle(100);
    const states = seen.filter(([e]) => e === 'game:state').map(([, s]) => s);
    expect(states).not.toContainEqual(expect.objectContaining({ state: GameState.Podium }));
    expect(await host.emitWithAck('host:attach', { pin })).toMatchObject({ ok: true });
    expect((await metaOf(pin)).state).toBe(GameState.Podium);
  });

  it('a run the room switched away from mid-command sends nothing more (back to the lobby)', async () => {
    const { host, pin, players, screen } = await runningRoom(ctx, { players: 1, teams: 1 });
    const meta = await metaOf(pin);
    // Events held from setup (escape:start) drain first, so only later ones count.
    await settle(100);
    const phone = record(players[0].socket);
    const board = record(screen);
    const store = ctx.h.app.get(EscapeStore);
    const save = store.save.bind(store);
    // escape:hint saves the team, then the room goes back to its lobby before the emits.
    jest.spyOn(store, 'save').mockImplementationOnce(async (...args) => {
      await save(...args);
      await ctx.h.app.get(GameEngine).backToLobby(pin, meta.hostUserId);
    });
    expect(await host.emitWithAck('escape:hint', { pin, teamId: 't1' })).toEqual({
      ok: true,
      released: 1,
    });
    await settle(150);
    const escapeEvents = (seen: [string, unknown][]) =>
      seen.map(([e]) => e).filter((e) => e.startsWith('escape:'));
    expect(escapeEvents(phone)).toEqual([]);
    expect(escapeEvents(board)).toEqual([]);
    expect(screenLeaksIn(board, ctx.vault)).toEqual([]);
  });

  it('a board due for a room that is gone meanwhile is skipped quietly', async () => {
    const { pin } = await runningRoom(ctx, { players: 1, teams: 1 });
    const game = ctx.h.app.get(GameService);
    const meta = await metaOf(pin);
    // The room is there for the first read, gone for the next.
    const spy = jest.spyOn(game, 'getMeta').mockResolvedValueOnce(meta).mockResolvedValue(null);
    const engine = ctx.h.app.get(EscapeEngine) as unknown as {
      currentView(pin: string): Promise<{ id: string } | null>;
    };
    try {
      await expect(engine.currentView(pin)).resolves.toMatchObject({ id: meta.id });
      await expect(engine.currentView(pin)).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
}
