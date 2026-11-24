import {
  type EscapeClosed,
  type EscapeFinale,
  type EscapeHostState,
  GameState,
} from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { EscapeStore } from '../../src/escape/escape.store';
import { lostLibrary } from '../../src/escape/samples';
import { GameEngine } from '../../src/game/game.engine';
import { GameService } from '../../src/game/game.service';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  createAs,
  eventually,
  joinAndSync,
  record,
  runningRoom,
  seedTemplate,
  stateWhere,
  submitAs,
} from './escape-harness';

/** A race room of `templateId`, solo, its host console synced. */
async function soloRace(ctx: EscapeContext, templateId: string) {
  const host = ctx.h.connectHost();
  const { pin } = await createAs(host, templateId, 'race', { race: { format: 'solo' } });
  if (!pin) throw new Error('race refused');
  expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
  return { host, pin };
}

/** `host:ban` (GameEngine.afterBan): the banned player leaves the escape run too. */
export function banTests(ctx: EscapeContext): void {
  let library: string;
  const store = () => ctx.h.app.get(EscapeStore);
  const metaOf = async (pin: string) => (await ctx.h.app.get(GameService).getMeta(pin))!;

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
  });

  /** The host bans `p`, who gets `kicked`. */
  const ban = async (host: Socket, pin: string, p: SyncedPlayer) => {
    const kicked = nextEvent(p.socket, 'kicked');
    host.emit('host:ban', { pin, playerId: p.playerId, minutes: 5 });
    await kicked;
  };

  it('running: out of the team and its index, the roles dealt again; the kicked phone cannot act or sync back', async () => {
    const { host, pin, teams } = await runningRoom(ctx, { players: 2, teams: 1 });
    const [a, b] = teams.t1;
    const { id } = await metaOf(pin);
    const alone = stateWhere(b.socket, (s) => s.team?.members.length === 1);
    await ban(host, pin, a);
    const s = await alone;
    expect(s.team!.members.map((m) => m.playerId)).toEqual([b.playerId]);
    // Vault Heist's three roles are all B's now.
    expect(s.view!.roles).toHaveLength(ctx.vault.roles.length);
    expect(await store().teamOfPlayer(id, a.playerId)).toBeNull();
    expect((await store().team(id, 't1'))!.team.members).toEqual([b.playerId]);
    // A client that ignores `kicked`.
    expect(await submitAs(a, pin, 'lobby-door', '0417')).toEqual({
      ok: false,
      reason: 'not-joined',
    });
    expect(await a.socket.emitWithAck('escape:ask-hint', { pin, hintId: 'x' })).toEqual({
      ok: false,
      reason: 'not-joined',
    });
    expect(await a.socket.emitWithAck('escape:sync', { pin })).toMatchObject({ ok: false });
    const seen: unknown[] = [];
    a.socket.on('escape:team-update', (u) => seen.push(u));
    expect(await submitAs(b, pin, 'lobby-door', '0417')).toMatchObject({ ok: true });
    await settle(100);
    expect(seen).toEqual([]);
    const engine = ctx.h.app.get(EscapeEngine) as unknown as {
      gone: Map<string, Map<string, number>>;
    };
    expect(engine.gone.get(id)?.has(a.playerId) ?? false).toBe(false);
  });

  it('a command of the banned player still waiting in the queue does not put them back in a team', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, ctx.templateId, 'hosted');
    if (!pin) throw new Error('create refused');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const a = await joinAndSync(ctx.h, pin, 'Ann');
    const b = await joinAndSync(ctx.h, pin, 'Bob');
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'self', count: 2 })).toEqual({
      ok: true,
    });
    const { id } = await metaOf(pin);
    const save = store().save.bind(store());
    let choose: Promise<unknown> | undefined;
    // Bob's choice holds the queue: Ann is banned, then her own choice arrives
    // (her socket still a player's until `banned` runs, behind Bob's).
    jest.spyOn(store(), 'save').mockImplementationOnce(async (...args) => {
      await save(...args);
      await ban(host, pin, a);
      choose = a.socket.emitWithAck('escape:choose-team', { pin, teamId: 't2' });
      await settle(100);
    });
    expect(await b.socket.emitWithAck('escape:choose-team', { pin, teamId: 't1' })).toEqual({
      ok: true,
    });
    expect(await choose).toMatchObject({ ok: false, error: { code: 'escape.not_joined' } });
    expect(await store().teamOfPlayer(id, a.playerId)).toBeNull();
    expect((await store().team(id, 't2'))!.team.members).toEqual([]);
  });

  it('running: a team the ban empties goes, and no longer holds the run open', async () => {
    const { host, pin, teams } = await runningRoom(ctx, { players: 2, teams: 2 });
    const [b] = teams.t2;
    const { id } = await metaOf(pin);
    for (const lockId of ctx.vault.stages.flatMap((st) => st.locks.map((l) => l.id))) {
      expect(await host.emitWithAck('escape:unlock', { pin, teamId: 't1', lockId })).toEqual({
        ok: true,
      });
    }
    expect((await store().run(id))!.phase).toBe('running');
    const finale = nextEvent<EscapeFinale>(host, 'escape:finale');
    await ban(host, pin, b);
    const f = await finale;
    expect(f.ranking.map((r) => r.teamId)).toEqual(['t1']);
    expect((await store().run(id))!.teamIds).toEqual(['t1']);
  });

  it('running: the last player banned ends the run', async () => {
    const { host, pin, players } = await runningRoom(ctx, { players: 1, teams: 1 });
    const finale = nextEvent<EscapeFinale>(host, 'escape:finale');
    await ban(host, pin, players[0]);
    expect((await finale).ranking).toEqual([]);
  });

  it('a solo race: the banned player’s team leaves the board, forming or running', async () => {
    const { host, pin } = await soloRace(ctx, library);
    const [a, b, c] = [
      await joinAndSync(ctx.h, pin, 'Ann'),
      await joinAndSync(ctx.h, pin, 'Bob'),
      await joinAndSync(ctx.h, pin, 'Cy'),
    ];
    const { id } = await metaOf(pin);
    const teamsNow = async () => (await store().run(id))!.teamIds.length;
    const hostSees = (n: number) =>
      nextEvent<EscapeHostState>(host, 'escape:host', { where: (h) => h.teams.length === n });
    let seen = hostSees(2);
    await ban(host, pin, a);
    await seen;
    expect(await teamsNow()).toBe(2);
    const running = stateWhere(c.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    await running;
    seen = hostSees(1);
    await ban(host, pin, b);
    await seen;
    expect(await teamsNow()).toBe(1);
    expect((await store().run(id))!.phase).toBe('running');
    expect(c.last().team!.members).toHaveLength(1);
  });
}

/** `host:back-to-lobby` while the run plays (GameEngine.beforeStop): an abort. */
export function stopTests(ctx: EscapeContext): void {
  let library: string;
  const store = () => ctx.h.app.get(EscapeStore);
  const engine = () => ctx.h.app.get(EscapeEngine);
  const metaOf = async (pin: string) => (await ctx.h.app.get(GameService).getMeta(pin))!;

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
  });

  it('the run is discarded: everyone is told, nothing is stored or left in process, and the room opens a new run', async () => {
    const { host, pin, players, screen } = await runningRoom(ctx, { players: 2, teams: 1 });
    const [a] = players;
    const { id } = await metaOf(pin);
    const finales: unknown[] = [];
    for (const s of [host, a.socket, screen]) {
      s.on('escape:finale', (f) => finales.push(f));
      s.on('escape:screen-finale', (f) => finales.push(f));
    }
    const closed = [host, a.socket, players[1].socket, screen].map((s) =>
      nextEvent<EscapeClosed>(s, 'escape:closed'),
    );
    const lobby = nextEvent<{ state: string }>(a.socket, 'game:state', {
      where: (s) => s.state === GameState.Lobby,
    });
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    expect(await Promise.all(closed)).toEqual(Array(4).fill({ gameId: id }));
    await lobby;
    expect(finales).toEqual([]);
    expect(await store().run(id)).toBeNull();
    expect(await store().results(id)).toBeNull();
    expect(await store().teamOfPlayer(id, a.playerId)).toBeNull();
    await eventually(async () =>
      expect(engine().inProcess(id, pin)).toEqual({
        ticking: false,
        gone: false,
        board: false,
        scheduled: false,
        siteRetry: false,
      }),
    );
    // A restart finds nothing to revive.
    await (engine() as unknown as { recover(): Promise<void> }).recover();
    expect(engine().inProcess(id, pin).ticking).toBe(false);
    expect(await submitAs(a, pin, 'lobby-door', '0417')).toMatchObject({ ok: false });
    expect(await host.emitWithAck('escape:results', { gameId: id })).toMatchObject({ ok: false });

    // The room is ready for a new run, with no stale state.
    const forming = stateWhere(a.socket, (s) => s.phase === 'forming' && s.gameId !== id);
    expect(await host.emitWithAck('escape:open', { pin, templateId: ctx.templateId })).toEqual({
      ok: true,
    });
    expect((await forming).team).toBeNull();
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toEqual({
      ok: true,
    });
    const running = stateWhere(a.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect((await running).view!.stageIndex).toBe(0);
  });

  it('a race: nothing is reported, and the room keeps its session', async () => {
    const { host, pin } = await soloRace(ctx, library);
    const a = await joinAndSync(ctx.h, pin, 'Ann');
    const running = stateWhere(a.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    await running;
    const { id } = await metaOf(pin);
    const report = jest.spyOn(engine() as unknown as { reportRace(): void }, 'reportRace');
    try {
      const closed = nextEvent<EscapeClosed>(a.socket, 'escape:closed');
      expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
      expect(await closed).toEqual({ gameId: id });
      expect(report).not.toHaveBeenCalled();
    } finally {
      report.mockRestore();
    }
    expect(await store().session(pin)).toMatchObject({ type: 'race', race: { started: true } });
  });

  it('a Stop that raced the run’s end is a podium’s back to the lobby: the finale and its results stay, no escape:closed, every client ends in the lobby', async () => {
    const { host, pin, players, screen } = await runningRoom(ctx, { players: 1, teams: 1 });
    const meta = await metaOf(pin);
    await settle(100);
    const seen = [host, players[0].socket, screen].map((s) => record(s));
    const saveResults = store().saveResults.bind(store());
    let stop: Promise<void> | undefined;
    // The finale is in the queue when the host's Stop arrives (the room still plays).
    jest.spyOn(store(), 'saveResults').mockImplementationOnce(async (...args) => {
      stop = ctx.h.app.get(GameEngine).backToLobby(pin, meta.hostUserId);
      await settle(50);
      await saveResults(...args);
    });
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    await stop;
    await settle(150);
    for (const events of seen) {
      const names = events.map(([e]) => e);
      expect(names).not.toContain('escape:closed');
      const finale = names.findIndex((e) => e === 'escape:finale' || e === 'escape:screen-finale');
      expect(finale).toBeGreaterThanOrEqual(0);
      const states = events.flatMap(([e, p], i) =>
        e === 'game:state' ? [{ i, state: (p as { state: string }).state }] : [],
      );
      expect(states.map((s) => s.state)).toEqual([GameState.Podium, GameState.Lobby]);
      expect(states[1].i).toBeGreaterThan(finale);
    }
    expect(await store().results(meta.id)).not.toBeNull();
    expect((await store().run(meta.id))!.phase).toBe('finale');
    expect(await host.emitWithAck('escape:results', { gameId: meta.id })).toMatchObject({
      ok: true,
    });
    expect((await metaOf(pin)).id).not.toBe(meta.id);
  });

  it('from the finale, back to the lobby keeps the results (not an abort)', async () => {
    const { host, pin, players } = await runningRoom(ctx, { players: 1, teams: 1 });
    const { id } = await metaOf(pin);
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    let closed = 0;
    players[0].socket.on('escape:closed', () => closed++);
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    await settle(100);
    expect(closed).toBe(0);
    expect(await store().results(id)).not.toBeNull();
  });
}
