import {
  type EscapeClosed,
  type EscapeFinale,
  type EscapeHostState,
  GameState,
} from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { EscapeTimings } from '../../src/escape/escape-timings';
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

  /** The escape and `game:state` events of `seen`, as short tags, in order. */
  const tags = (seen: [string, unknown][]) =>
    seen.flatMap(([e, p]) => {
      const { gameId, phase, state, board } = (p ?? {}) as {
        gameId?: string;
        phase?: string;
        state?: string;
        board?: { phase?: string };
      };
      if (e === 'game:state') return [`state ${state}`];
      if (!e.startsWith('escape:')) return [];
      return [[e.slice(7), gameId, phase ?? board?.phase].filter(Boolean).join(' ')];
    });
  /** `a` then `b` are both in `list`, in that order. */
  const inOrder = (list: string[], ...wanted: string[]) => {
    let from = 0;
    for (const w of wanted) {
      const at = list.indexOf(w, from);
      expect({ wanted: w, found: at >= 0, list }).toMatchObject({ wanted: w, found: true });
      from = at + 1;
    }
  };

  it('the run is discarded: everyone is told, nothing is stored or left in process, and the room forms the same escape room again on its own', async () => {
    const { host, pin, players, screen } = await runningRoom(ctx, { players: 2, teams: 1 });
    const [a] = players;
    const { id } = await metaOf(pin);
    const session = await store().session(pin);
    await settle(100);
    const seen = [host, a.socket, players[1].socket, screen].map((s) => record(s));
    const port = (engine() as unknown as { licences: { check(): unknown; recordUse(): unknown } })
      .licences;
    const licence = [jest.spyOn(port, 'check'), jest.spyOn(port, 'recordUse')];
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    // The whole sequence is out before the ack: no console has to ask for anything.
    const next = await metaOf(pin);
    expect(next).toMatchObject({ kind: 'escape', state: GameState.Lobby, title: 'Vault Heist' });
    expect(next.id).not.toBe(id);
    await settle(150);
    const [hostSeen, phone, other, board] = seen.map(tags);
    for (const list of [hostSeen, phone, other, board]) {
      expect(list.filter((t) => t.startsWith('closed'))).toEqual([`closed ${id}`]);
      expect(list.filter((t) => /finale/.test(t))).toEqual([]);
      // Nothing of the stopped run after its `escape:closed`.
      const after = list.slice(list.indexOf(`closed ${id}`) + 1);
      expect(after.filter((t) => t.includes(id))).toEqual([]);
    }
    const forming = `${next.id} forming`;
    for (const list of [phone, other]) {
      inOrder(list, `closed ${id}`, `state ${GameState.Lobby}`, 'look', `state ${forming}`);
    }
    inOrder(hostSeen, `closed ${id}`, `state ${GameState.Lobby}`, 'look', `host ${forming}`);
    inOrder(board, `closed ${id}`, `state ${GameState.Lobby}`, `board ${forming}`);
    // The players stay, unassigned: no team, progress, hint or clock of the stopped run.
    expect(a.last()).toMatchObject({ gameId: next.id, phase: 'forming', team: null, view: null });
    const run = (await store().run(next.id))!;
    expect(run).toMatchObject({ phase: 'forming', teamIds: [] });
    expect(run.clock).toMatchObject({ startedAt: 0, pausedMs: 0 });
    expect((await store().snapshot(next.id))!.templateId).toBe(ctx.templateId);
    // The session is the room's: kept as it was, and the re-open checks no licence.
    expect(await store().session(pin)).toEqual(session);
    for (const spy of licence) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }

    expect(await store().run(id)).toBeNull();
    expect(await store().results(id)).toBeNull();
    expect(await store().teamOfPlayer(id, a.playerId)).toBeNull();
    await eventually(async () =>
      expect(engine().inProcess(id, pin)).toMatchObject({ ticking: false, gone: false }),
    );
    // A restart finds nothing of the stopped run to revive.
    await (engine() as unknown as { recover(): Promise<void> }).recover();
    expect(engine().inProcess(id, pin).ticking).toBe(false);
    expect(await submitAs(a, pin, 'lobby-door', '0417')).toMatchObject({ ok: false });
    expect(await host.emitWithAck('escape:results', { gameId: id })).toMatchObject({ ok: false });

    // The new run forms and starts as any other.
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toEqual({
      ok: true,
    });
    const running = stateWhere(a.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect((await running).view!.stageIndex).toBe(0);
  });

  it('a second console (not the one that stopped) follows to the new run with no command of its own', async () => {
    const { host, pin } = await runningRoom(ctx, { players: 1, teams: 1 });
    const { id } = await metaOf(pin);
    const second = ctx.h.connectHost();
    expect(await second.emitWithAck('host:attach', { pin })).toMatchObject({ ok: true });
    expect(await second.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const formed = nextEvent<EscapeHostState>(second, 'escape:host', {
      where: (s) => s.gameId !== id && s.board.phase === 'forming',
    });
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    expect((await formed).teams).toEqual([]);
  });

  it('group play: the players are dealt into the new run’s team, and the look goes out', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    if (!pin) throw new Error('group refused');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const a = await joinAndSync(ctx.h, pin, 'Ann');
    const b = await joinAndSync(ctx.h, pin, 'Bob');
    const running = stateWhere(a.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    await running;
    const { id } = await metaOf(pin);
    const session = await store().session(pin);
    await settle(100);
    const seen = [a, b].map((p) => record(p.socket));
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    const next = await metaOf(pin);
    expect(next.kind).toBe('escape');
    await settle(150);
    for (const [i, p] of [a, b].entries()) {
      inOrder(tags(seen[i]), `closed ${id}`, 'look', `state ${next.id} forming`);
      expect(p.last()).toMatchObject({ gameId: next.id, phase: 'forming', view: null });
      expect(
        p
          .last()
          .team?.members.map((m) => m.playerId)
          .sort(),
      ).toEqual([a.playerId, b.playerId].sort());
    }
    expect((await store().run(next.id))!.teamIds).toHaveLength(1);
    expect(await store().session(pin)).toEqual(session);
    const again = stateWhere(a.socket, (s) => s.phase === 'running' && s.gameId === next.id);
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect((await again).view!.stageIndex).toBe(0);
  });

  it('a race: nothing is reported, the room keeps its session, and the new run forms until the host starts it', async () => {
    const { host, pin } = await soloRace(ctx, library);
    const a = await joinAndSync(ctx.h, pin, 'Ann');
    const running = stateWhere(a.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    await running;
    const { id } = await metaOf(pin);
    const session = await store().session(pin);
    const report = jest.spyOn(engine() as unknown as { reportRace(): void }, 'reportRace');
    try {
      const closed = nextEvent<EscapeClosed>(a.socket, 'escape:closed');
      const forming = stateWhere(a.socket, (s) => s.phase === 'forming' && s.gameId !== id);
      expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
      expect(await closed).toEqual({ gameId: id });
      expect((await forming).team).toBeNull();
      expect(report).not.toHaveBeenCalled();
    } finally {
      report.mockRestore();
    }
    expect(await store().session(pin)).toEqual(session);
    expect(session).toMatchObject({ type: 'race', race: { started: true } });
    const next = await metaOf(pin);
    expect(await store().run(next.id)).toMatchObject({ phase: 'forming', maxSize: 1, teamIds: [] });
  });

  it('a scheduled race stopped after its start time does not start again on its own: the host starts it', async () => {
    const timings = ctx.h.app.get(EscapeTimings);
    const saved = { raceMinLeadMs: timings.raceMinLeadMs };
    Object.assign(timings, { raceMinLeadMs: 300 });
    try {
      const host = ctx.h.connectHost();
      const { pin } = await createAs(host, library, 'race', {
        race: { format: 'solo', startsAt: Date.now() + 500 },
      });
      if (!pin) throw new Error('race refused');
      expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      const a = await joinAndSync(ctx.h, pin, 'Ann');
      await stateWhere(a.socket, (s) => s.phase === 'running');
      const { id } = await metaOf(pin);
      expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
      const next = await metaOf(pin);
      expect(next.id).not.toBe(id);
      // A phone and the console sync again (a reload): neither starts it.
      expect(await a.socket.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      await settle(300);
      expect((await store().run(next.id))!.phase).toBe('forming');
      expect(engine().inProcess(next.id, pin)).toMatchObject({ ticking: false, scheduled: false });
      // The host window treats it as any forming room: no scheduled start to wait for.
      const waits = engine() as unknown as {
        waitsForStart(p: string, i: string): Promise<boolean>;
      };
      expect(await waits.waitsForStart(pin, next.id)).toBe(false);
      const running = stateWhere(a.socket, (s) => s.phase === 'running' && s.gameId === next.id);
      expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
      await running;
    } finally {
      Object.assign(timings, saved);
    }
  });

  it('a template that can no longer be opened: the stop still goes through, to the room’s plain lobby', async () => {
    const gone = await seedTemplate(ctx.h, { ...lostLibrary, title: 'Withdrawn' });
    const { host, pin, players } = await runningRoom(ctx, {
      players: 1,
      teams: 1,
      templateId: gone,
    });
    const { id } = await metaOf(pin);
    const session = await store().session(pin);
    await ctx.h.prisma.escapeTemplate.update({ where: { id: gone }, data: { status: 'draft' } });
    await settle(100);
    const seen = record(players[0].socket);
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    await settle(150);
    const next = await metaOf(pin);
    expect(next.id).not.toBe(id);
    expect(next.state).toBe(GameState.Lobby);
    expect(next.kind).not.toBe('escape');
    const list = tags(seen);
    inOrder(list, `closed ${id}`, `state ${GameState.Lobby}`);
    expect(list.filter((t) => t.startsWith('state ') && t.includes('forming'))).toEqual([]);
    expect(await store().run(id)).toBeNull();
    expect(await store().session(pin)).toEqual(session);
    // The host picks another escape room from there, as before.
    const forming = stateWhere(players[0].socket, (s) => s.phase === 'forming');
    expect(await host.emitWithAck('escape:open', { pin, templateId: ctx.templateId })).toEqual({
      ok: true,
    });
    await forming;
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
