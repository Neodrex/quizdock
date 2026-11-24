import {
  type EscapeFinale,
  type EscapeHostBatch,
  type EscapeHostState,
  type EscapeHostTeam,
  type EscapeScreenFinale,
  GameState,
} from '@quiz-dock/contracts';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { EscapeTimings } from '../../src/escape/escape-timings';
import { EscapeStore } from '../../src/escape/escape.store';
import { GameEngine } from '../../src/game/game.engine';
import { GameService } from '../../src/game/game.service';
import { gameKeys } from '../../src/game/game.keys';
import { gameHash } from '../../src/game/game-hash';
import { RedisService } from '../../src/redis/redis.service';
import type { Socket } from 'socket.io-client';
import { lostLibrary } from '../../src/escape/samples';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  createAs,
  eventually,
  joinAndSync,
  record,
  seedTemplate,
  stateWhere,
} from './escape-harness';
import { codesIn } from './leaks';

/** Races (M7 Tasks 7.7–7.9): solo teams, team codes, scheduled starts, scale. */
export function raceSessionTests(ctx: EscapeContext): void {
  let library: string;
  const refused = (code: string) => ({ ok: false, error: expect.objectContaining({ code }) });

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
  });

  /** A race room of Lost Library, its host console synced. */
  const raceRoom = async (format: 'solo' | 'teams') => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'race', { race: { format } });
    if (!pin) throw new Error('race refused');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    return { host, pin };
  };

  const start = async (host: Socket, pin: string, players: SyncedPlayer[]) => {
    const running = players.map((p) => stateWhere(p.socket, (s) => s.phase === 'running'));
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    return Promise.all(running);
  };

  // ── Formation (Task 7.7) ──

  it('solo: each phone’s first sync makes its own team, named after it; a late joiner plays at once', async () => {
    const { host, pin } = await raceRoom('solo');
    const players: SyncedPlayer[] = [];
    for (const name of ['Ann', 'Bob', 'Cy']) {
      const p = await joinAndSync(ctx.h, pin, name);
      players.push(p);
    }
    const teams = players.map((p) => p.last().team);
    expect(teams.map((t) => t?.name)).toEqual(['Ann', 'Bob', 'Cy']);
    expect(new Set(teams.map((t) => t?.id)).size).toBe(3);
    expect(teams.every((t) => t?.members.length === 1)).toBe(true);
    expect(players[0].last().session).toMatchObject({ type: 'race', raceFormat: 'solo' });

    await start(host, pin, players);
    const late = await joinAndSync(ctx.h, pin, 'Late');
    // Its team came with the sync (before the ack).
    const mine = late.last();
    expect(mine.view).not.toBeNull();
    expect(mine.team).toMatchObject({ name: 'Late', members: [expect.anything()] });
    expect(
      await late.socket.emitWithAck('escape:submit', { pin, lockId: 'catalogue', input: '42' }),
    ).toEqual({ ok: true, outcome: 'lock-solved' });
    // Host help for all is allowed in a race (§1.1): every team gets a hint.
    expect(await host.emitWithAck('escape:hint', { pin })).toEqual({ ok: true, released: 4 });
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: 60 })).toEqual({
      ok: true,
    });
  });

  it('teams: a team by code holds 3; wrong codes are limited; at the start the rest play solo', async () => {
    const { host, pin } = await raceRoom('teams');
    const hostSeen = record(host);
    const [a, b, c, d, e, f] = await Promise.all(
      ['Ann', 'Ben', 'Cat', 'Dan', 'Eve', 'Fay'].map((n) => joinAndSync(ctx.h, pin, n)),
    );
    const seen = new Map([a, b, c, d, e, f].map((p) => [p, record(p.socket)] as const));
    expect(a.last().team).toBeNull();

    const owls = (await a.socket.emitWithAck('escape:new-team', { pin, name: ' Owls ' })) as {
      ok: boolean;
      teamId: string;
      code: string;
    };
    expect(owls).toMatchObject({ ok: true, code: expect.stringMatching(/^[A-HJ-NP-Z]{4}$/) });
    const typed = ` ${owls.code.slice(0, 2).toLowerCase()} ${owls.code.slice(2)} `;
    expect(await b.socket.emitWithAck('escape:join-team', { pin, code: typed })).toEqual({
      ok: true,
      teamId: owls.teamId,
    });
    expect(await c.socket.emitWithAck('escape:join-team', { pin, code: owls.code })).toEqual({
      ok: true,
      teamId: owls.teamId,
    });
    expect(await d.socket.emitWithAck('escape:join-team', { pin, code: owls.code })).toMatchObject(
      refused('escape.team_full'),
    );
    await eventually(async () =>
      expect(a.last().team).toMatchObject({
        name: 'Owls',
        code: owls.code,
        members: [expect.anything(), expect.anything(), expect.anything()],
      }),
    );

    // Wrong codes: five, then every code waits, a right one too.
    const wrong = owls.code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    for (let i = 0; i < 5; i++) {
      expect(await e.socket.emitWithAck('escape:join-team', { pin, code: wrong })).toMatchObject(
        refused('escape.team_code_unknown'),
      );
    }
    expect(await e.socket.emitWithAck('escape:join-team', { pin, code: owls.code })).toMatchObject(
      refused('escape.too_many_codes'),
    );

    // F starts a team, then another: the first, left empty, is gone with its code.
    const ghost = (await f.socket.emitWithAck('escape:new-team', { pin, name: 'Ghost' })) as {
      teamId: string;
      code: string;
    };
    const gone = nextEvent<EscapeHostState>(host, 'escape:host', {
      where: (s) => s.teams.some((t) => t.name === 'Bats'),
    });
    const bats = (await f.socket.emitWithAck('escape:new-team', { pin, name: 'Bats' })) as {
      teamId: string;
      code: string;
    };
    expect(bats.code).not.toBe(ghost.code);
    expect((await gone).teams.map((t) => t.name)).toEqual(['Owls', 'Bats']);
    expect(await d.socket.emitWithAck('escape:join-team', { pin, code: ghost.code })).toMatchObject(
      refused('escape.team_code_unknown'),
    );

    // Picking a listed team is not how a race forms.
    expect(
      await d.socket.emitWithAck('escape:choose-team', { pin, teamId: owls.teamId }),
    ).toMatchObject(refused('escape.self_select_closed'));

    const hostState = nextEvent<EscapeHostState>(host, 'escape:host', {
      where: (s) => s.teams.length > 0 && s.unassigned.length === 0,
    });
    const states = await start(host, pin, [a, b, c, d, e, f]);
    const started = await hostState;
    // The solo teams come in join order, and these phones joined at once.
    expect(started.teams.map((t) => [t.name, t.memberCount]).sort()).toEqual([
      ['Bats', 1],
      ['Dan', 1],
      ['Eve', 1],
      ['Owls', 3],
    ]);
    expect(started.teams.slice(0, 2).map((t) => t.name)).toEqual(['Owls', 'Bats']);
    expect(states[3].team).toMatchObject({ name: 'Dan' });
    expect(states[3].team?.code).toBeUndefined();

    // Running: a player with a team cannot start another; a late one can.
    expect(await a.socket.emitWithAck('escape:new-team', { pin, name: 'X' })).toMatchObject(
      refused('escape.wrong_phase'),
    );
    const late = await joinAndSync(ctx.h, pin, 'Late');
    expect(late.last().team).toBeNull();
    expect(await late.socket.emitWithAck('escape:new-team', { pin, name: 'Late' })).toMatchObject({
      ok: true,
    });
    expect(late.last().view).not.toBeNull();

    // Every phone saw its own team's code only; the host and the screens none.
    const own = new Map([
      [a, [owls.code]],
      [b, [owls.code]],
      [c, [owls.code]],
      [d, []],
      [e, []],
      [f, [ghost.code, bats.code]],
    ]);
    // Escape payloads only: an error frame has a `code` of its own.
    const escapeFrames = (frames: [string, unknown][]) =>
      frames.filter(([ev]) => ev.startsWith('escape:'));
    for (const [p, frames] of seen) {
      expect(new Set(codesIn(escapeFrames(frames)))).toEqual(new Set(own.get(p)));
    }
    expect(codesIn(escapeFrames(hostSeen))).toEqual([]);
  });

  it('a race formation change reaches the mover and its teams only, then the host and the board', async () => {
    const { host, pin } = await raceRoom('teams');
    const [a, b, c] = await Promise.all(
      ['Ann', 'Ben', 'Cat'].map((n) => joinAndSync(ctx.h, pin, n)),
    );
    const states = (s: Socket) => {
      const frames = record(s);
      return () => frames.filter(([e]) => e === 'escape:state').length;
    };
    const [sa, sb, sc] = [a, b, c].map((p) => states(p.socket));
    const hostSeen = record(host);
    const owls = (await a.socket.emitWithAck('escape:new-team', { pin, name: 'Owls' })) as {
      code: string;
    };
    await eventually(async () => expect(a.last().team?.name).toBe('Owls'));
    expect(await b.socket.emitWithAck('escape:join-team', { pin, code: owls.code })).toMatchObject({
      ok: true,
    });
    await eventually(async () => expect(a.last().team?.members).toHaveLength(2));
    await settle(200);
    expect([sa(), sb(), sc()]).toEqual([2, 1, 0]);
    // B starts another team: B, and A (its old team), not C.
    expect(await b.socket.emitWithAck('escape:new-team', { pin, name: 'Bats' })).toMatchObject({
      ok: true,
    });
    await eventually(async () => expect(a.last().team?.members).toHaveLength(1));
    await settle(200);
    expect([sa(), sb(), sc()]).toEqual([3, 2, 0]);
    // The phone lists its own team only; the host still gets every change.
    expect(b.last().formation.teams.map((t) => t.name)).toEqual(['Bats']);
    await eventually(async () =>
      expect(
        hostSeen.some(
          ([e, s]) =>
            e === 'escape:host' && (s as EscapeHostState).teams.some((t) => t.name === 'Bats'),
        ),
      ).toBe(true),
    );
  });

  it('a solo race: a new phone’s sync sends no state to the others', async () => {
    const { pin } = await raceRoom('solo');
    const first = await Promise.all(['A1', 'A2', 'A3'].map((n) => joinAndSync(ctx.h, pin, n)));
    await settle(100);
    const counts = first.map((p) => {
      const frames = record(p.socket);
      return () => frames.filter(([e]) => e === 'escape:state').length;
    });
    const late = await joinAndSync(ctx.h, pin, 'A4');
    expect(late.last().team?.name).toBe('A4');
    await settle(200);
    expect(counts.map((n) => n())).toEqual([0, 0, 0]);
    expect(first[0].last().formation.teams).toHaveLength(1);
  });

  it('a team race holds at most as many teams as its cap', async () => {
    const { pin } = await raceRoom('teams');
    const [a, b, c] = await Promise.all(
      ['Ann', 'Ben', 'Cat'].map((n) => joinAndSync(ctx.h, pin, n)),
    );
    expect(await a.socket.emitWithAck('escape:new-team', { pin, name: 'A' })).toMatchObject({
      ok: true,
    });
    expect(await b.socket.emitWithAck('escape:new-team', { pin, name: 'B' })).toMatchObject({
      ok: true,
    });
    const store = ctx.h.app.get(EscapeStore);
    await store.writeSession(pin, { ...(await store.session(pin))!, cap: 2 });
    expect(await c.socket.emitWithAck('escape:new-team', { pin, name: 'C' })).toMatchObject(
      refused('session.full'),
    );
    // A team that empties as its player starts another makes room for it.
    expect(await a.socket.emitWithAck('escape:new-team', { pin, name: 'A2' })).toMatchObject({
      ok: true,
    });
  });

  it('escape:new-team and escape:join-team belong to team races', async () => {
    const { pin } = await raceRoom('solo');
    const p = await joinAndSync(ctx.h, pin, 'Solo');
    const out = refused('escape.not_in_session');
    expect(await p.socket.emitWithAck('escape:new-team', { pin, name: 'X' })).toMatchObject(out);
    expect(await p.socket.emitWithAck('escape:join-team', { pin, code: 'ABCD' })).toMatchObject(
      out,
    );
  });

  // ── Leaving a team (M8 Task 8.16) ──

  type NewTeam = { ok: boolean; teamId: string; code: string };

  it('a player leaves its team while forming, races solo at the start, and its empty team is gone', async () => {
    const { host, pin } = await raceRoom('teams');
    const [a, b, c] = await Promise.all(
      ['Ann', 'Ben', 'Cat'].map((n) => joinAndSync(ctx.h, pin, n)),
    );
    const owls = (await a.socket.emitWithAck('escape:new-team', { pin, name: 'Owls' })) as NewTeam;
    expect(await b.socket.emitWithAck('escape:join-team', { pin, code: owls.code })).toMatchObject({
      ok: true,
    });
    const bats = (await c.socket.emitWithAck('escape:new-team', { pin, name: 'Bats' })) as NewTeam;

    // B leaves Owls: back to no team; A stays in Owls.
    const free = stateWhere(b.socket, (s) => s.team === null);
    expect(await b.socket.emitWithAck('escape:leave-team', { pin })).toEqual({ ok: true });
    await free;
    await eventually(async () => expect(a.last().team?.members).toHaveLength(1));

    // C leaves Bats, its only member: the team and its code are gone.
    const gone = nextEvent<EscapeHostState>(host, 'escape:host', {
      where: (s) => !s.teams.some((t) => t.id === bats.teamId),
    });
    expect(await c.socket.emitWithAck('escape:leave-team', { pin })).toEqual({ ok: true });
    await gone;
    expect(await b.socket.emitWithAck('escape:join-team', { pin, code: bats.code })).toMatchObject(
      refused('escape.team_code_unknown'),
    );
    // Leaving again, with no team, changes nothing.
    expect(await c.socket.emitWithAck('escape:leave-team', { pin })).toEqual({ ok: true });

    // At the start B and C race solo, each in a team of one; A in Owls.
    const running = [a, b, c].map((p) => stateWhere(p.socket, (s) => s.phase === 'running'));
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    const [ra, rb, rc] = await Promise.all(running);
    expect(ra.team?.id).toBe(owls.teamId);
    for (const r of [rb, rc]) {
      expect(r.team?.members).toHaveLength(1);
      expect(r.team?.id).not.toBe(owls.teamId);
    }
    expect(rb.team?.id).not.toBe(rc.team?.id);
  });

  it('after leaving, a player can join another team by its code', async () => {
    const { pin } = await raceRoom('teams');
    const [a, b] = await Promise.all(['Ann', 'Ben'].map((n) => joinAndSync(ctx.h, pin, n)));
    const owls = (await a.socket.emitWithAck('escape:new-team', { pin, name: 'Owls' })) as NewTeam;
    await b.socket.emitWithAck('escape:new-team', { pin, name: 'Bats' });
    expect(await b.socket.emitWithAck('escape:leave-team', { pin })).toEqual({ ok: true });
    expect(await b.socket.emitWithAck('escape:join-team', { pin, code: owls.code })).toEqual({
      ok: true,
      teamId: owls.teamId,
    });
    await eventually(async () => expect(a.last().team?.members).toHaveLength(2));
  });

  it('leaving is refused once the race runs, in a solo race and outside a race', async () => {
    const { host, pin } = await raceRoom('teams');
    const a = await joinAndSync(ctx.h, pin, 'Ann');
    await a.socket.emitWithAck('escape:new-team', { pin, name: 'Owls' });
    await start(host, pin, [a]);
    expect(await a.socket.emitWithAck('escape:leave-team', { pin })).toMatchObject(
      refused('escape.wrong_phase'),
    );

    const solo = await raceRoom('solo');
    const s = await joinAndSync(ctx.h, solo.pin, 'Sol');
    expect(await s.socket.emitWithAck('escape:leave-team', { pin: solo.pin })).toMatchObject(
      refused('escape.not_in_session'),
    );

    const groupHost = ctx.h.connectHost();
    const { pin: g } = await createAs(groupHost, library, 'group');
    const p = await joinAndSync(ctx.h, g!, 'Gus');
    expect(await p.socket.emitWithAck('escape:leave-team', { pin: g })).toMatchObject(
      refused('escape.not_in_session'),
    );
  });

  // ── Scheduled start (Task 7.8) ──

  describe('scheduled start', () => {
    const timings = () => ctx.h.app.get(EscapeTimings);
    const engine = () => ctx.h.app.get(EscapeEngine);
    const metaOf = async (pin: string) => (await ctx.h.app.get(GameService).getMeta(pin))!;
    let saved: { raceMinLeadMs: number; raceTouchEveryMs: number };

    beforeAll(() => {
      const t = timings();
      saved = { raceMinLeadMs: t.raceMinLeadMs, raceTouchEveryMs: t.raceTouchEveryMs };
      Object.assign(t, { raceMinLeadMs: 500, raceTouchEveryMs: 100 });
    });
    afterAll(() => Object.assign(timings(), saved));

    const scheduled = async (inMs: number) => {
      const host = ctx.h.connectHost();
      const startsAt = Date.now() + inMs;
      const { pin } = await createAs(host, library, 'race', {
        race: { format: 'solo', startsAt },
      });
      if (!pin) throw new Error('race refused');
      expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      return { host, pin, startsAt };
    };

    it('starts on its own at startsAt, with no host message; the clock starts then', async () => {
      const { pin, startsAt } = await scheduled(1_500);
      const [a, b] = [await joinAndSync(ctx.h, pin, 'Ann'), await joinAndSync(ctx.h, pin, 'Ben')];
      expect(a.last().session).toMatchObject({ startsAt });
      const escape = nextEvent<{ state: string }>(a.socket, 'game:state', {
        where: (s) => s.state === GameState.Escape,
      });
      const running = [a, b].map((p) => stateWhere(p.socket, (s) => s.phase === 'running', 5_000));
      await escape;
      const [first] = await Promise.all(running);
      const startedAt = first.clock.serverNow - first.clock.elapsedMs;
      expect(Math.abs(startedAt - startsAt)).toBeLessThan(200);
      const meta = await metaOf(pin);
      expect(engine().inProcess(meta.id, pin).scheduled).toBe(false);
    });

    it('"Start now" before startsAt starts it once; the timer does not start it again', async () => {
      const { host, pin } = await scheduled(800);
      const a = await joinAndSync(ctx.h, pin, 'Ann');
      let escapes = 0;
      a.socket.on('game:state', (s: { state: string }) => {
        if (s.state === GameState.Escape) escapes++;
      });
      expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
      const meta = await metaOf(pin);
      expect(engine().inProcess(meta.id, pin).scheduled).toBe(false);
      await settle(1_200);
      expect(escapes).toBe(1);
      expect(a.last().phase).toBe('running');
    });

    it('nobody in at startsAt: it keeps forming, and the host starts it later', async () => {
      const { host, pin } = await scheduled(600);
      const meta = await metaOf(pin);
      await eventually(async () => expect(engine().inProcess(meta.id, pin).scheduled).toBe(false));
      await settle(100);
      expect((await metaOf(pin)).state).toBe(GameState.Lobby);
      const a = await joinAndSync(ctx.h, pin, 'Ann');
      const running = stateWhere(a.socket, (s) => s.phase === 'running');
      expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
      await running;
    });

    it('nobody in at startsAt: a later host sync does not start it; the host does', async () => {
      const { host, pin } = await scheduled(600);
      const meta = await metaOf(pin);
      await eventually(async () => expect(engine().inProcess(meta.id, pin).scheduled).toBe(false));
      await settle(100);
      const a = await joinAndSync(ctx.h, pin, 'Ann');
      expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      await settle(300);
      expect(a.last().phase).toBe('forming');
      expect((await metaOf(pin)).state).toBe(GameState.Lobby);
      const running = stateWhere(a.socket, (s) => s.phase === 'running');
      expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
      await running;
    });

    /** The host away from the lobby, written by hand as GameEngine does after its grace. */
    const hostAway = async (pin: string) => {
      const meta = await metaOf(pin);
      await ctx.h.app
        .get(RedisService)
        .hset(
          gameKeys.game(meta.id),
          gameHash({ state: GameState.HostDisconnected, prevState: GameState.Lobby }),
        );
    };
    /** GameEngine.endOrphaned: the 15-minute host window, run now (as its timer would). */
    const windowEnds = async (pin: string) => {
      const meta = await metaOf(pin);
      const game = ctx.h.app.get(GameEngine) as unknown as {
        endOrphaned(ref: { pin: string; id: string }, hostUserId: string): Promise<void>;
      };
      await game.endOrphaned({ pin, id: meta.id }, meta.hostUserId);
    };

    it('the host away at startsAt: the race starts on schedule; the run is what the host comes back to', async () => {
      const { pin, startsAt } = await scheduled(600);
      const a = await joinAndSync(ctx.h, pin, 'Ann');
      const meta = await metaOf(pin);
      await hostAway(pin);
      const s = await stateWhere(a.socket, (st) => st.phase === 'running', 5_000);
      expect(Math.abs(s.clock.serverNow - s.clock.elapsedMs - startsAt)).toBeLessThan(300);
      expect(engine().inProcess(meta.id, pin).scheduled).toBe(false);
      expect(await metaOf(pin)).toMatchObject({
        state: GameState.HostDisconnected,
        prevState: GameState.Escape,
      });
      // The existing rule from here: the host window never cuts the run short.
      await windowEnds(pin);
      expect((await metaOf(pin)).state).toBe(GameState.HostDisconnected);
      // Nothing stays armed behind the test.
      await ctx.h.app.get(GameEngine).end(pin, ctx.h.hostUserId);
    });

    it('the host window does not close a race waiting for its scheduled start; it closes one with no start to wait for', async () => {
      const { pin } = await scheduled(10_000);
      const a = await joinAndSync(ctx.h, pin, 'Ann');
      let ended = 0;
      a.socket.on('game:ended', () => ended++);
      await hostAway(pin);
      await windowEnds(pin);
      await settle(100);
      expect(ended).toBe(0);
      expect((await metaOf(pin)).state).toBe(GameState.HostDisconnected);
      expect(engine().inProcess((await metaOf(pin)).id, pin).scheduled).toBe(true);

      // No scheduled start: the window closes the forming room, as before.
      const other = await raceRoom('solo');
      const b = await joinAndSync(ctx.h, other.pin, 'Bob');
      const gone = nextEvent(b.socket, 'game:ended');
      await hostAway(other.pin);
      await windowEnds(other.pin);
      await gone;
      // The first room goes the same way once ended by hand (nothing stays armed).
      const first = nextEvent(a.socket, 'game:ended');
      await ctx.h.app.get(GameEngine).end(pin, ctx.h.hostUserId);
      await first;
    });

    it('a host console back after startsAt starts the race on its sync', async () => {
      const { host, pin } = await scheduled(600);
      const a = await joinAndSync(ctx.h, pin, 'Ann');
      // The start was missed and nothing is armed any more.
      const inner = engine() as unknown as { scheduler: { disarm(pin: string): void } };
      inner.scheduler.disarm(pin);
      await settle(800);
      expect(a.last().phase).toBe('forming');
      const running = stateWhere(a.socket, (s) => s.phase === 'running', 5_000);
      expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      await running;
    });

    it('a restart before startsAt arms it again (recover), and it starts', async () => {
      // A wide margin, so a loaded machine never reaches startsAt before the disarm.
      const { pin, startsAt } = await scheduled(10_000);
      const a = await joinAndSync(ctx.h, pin, 'Ann');
      const meta = await metaOf(pin);
      type Tasks = { fire: () => Promise<void> };
      const inner = engine() as unknown as {
        scheduler: { disarm(pin: string): void; arm(pin: string, at: number, t: Tasks): void };
        recover(): Promise<void>;
      };
      // What a restart loses: the timer.
      inner.scheduler.disarm(pin);
      expect(engine().inProcess(meta.id, pin).scheduled).toBe(false);
      const arm = jest.spyOn(inner.scheduler, 'arm');
      try {
        await inner.recover();
        expect(engine().inProcess(meta.id, pin).scheduled).toBe(true);
        const call = arm.mock.calls.find(([p]) => p === pin);
        expect(call?.[1]).toBe(startsAt);
        // Fire what recover armed now rather than wait the 10 s.
        const running = stateWhere(a.socket, (s) => s.phase === 'running', 5_000);
        await call![2].fire();
        await running;
      } finally {
        arm.mockRestore();
        inner.scheduler.disarm(pin);
      }
    });

    it('the room keeps its TTL while it waits; a closed room leaves no timer', async () => {
      const { host, pin } = await scheduled(60_000);
      const redis = ctx.h.app.get(RedisService);
      await redis.expire(gameKeys.room(pin), 100);
      await eventually(async () =>
        expect(await redis.ttl(gameKeys.room(pin))).toBeGreaterThan(100),
      );
      const meta = await metaOf(pin);
      expect(engine().inProcess(meta.id, pin).scheduled).toBe(true);
      const ended = nextEvent(host, 'game:ended');
      host.emit('host:end', { pin });
      await ended;
      expect(engine().inProcess(meta.id, pin)).toEqual({
        ticking: false,
        gone: false,
        board: expect.any(Boolean),
        scheduled: false,
        siteRetry: false,
      });
    });
  });

  // ── Scale (Task 7.9) ──

  it('the board and the host state go out at most once a second under a burst of submits', async () => {
    const { host, pin } = await raceRoom('solo');
    const players: SyncedPlayer[] = [];
    for (let i = 0; i < 10; i++) players.push(await joinAndSync(ctx.h, pin, `R${i}`));
    const screen = ctx.h.connect();
    await screen.emitWithAck('spectator:join', { pin });
    expect(await screen.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    await start(host, pin, players);
    await settle(1_100); // the start's frames are out of the window
    const hostSeen = record(host);
    const screenSeen = record(screen);
    const t0 = Date.now();
    // 50 submits, and 10 phones joining meanwhile (each a host state and a board).
    await Promise.all([
      ...players.flatMap((p) =>
        Array.from({ length: 5 }, () =>
          p.socket.emitWithAck('escape:submit', { pin, lockId: 'catalogue', input: '00' }),
        ),
      ),
      ...Array.from({ length: 10 }, (_, i) => joinAndSync(ctx.h, pin, `Late${i}`)),
    ]);
    await settle(Math.max(0, 3_000 - (Date.now() - t0)));
    const count = (seen: [string, unknown][], e: string) => seen.filter(([n]) => n === e).length;
    // 3 s at one a second, plus one at either edge of the window.
    expect(count(hostSeen, 'escape:board')).toBeLessThanOrEqual(4);
    expect(count(hostSeen, 'escape:host')).toBeLessThanOrEqual(4);
    expect(count(screenSeen, 'escape:board')).toBeLessThanOrEqual(4);
    expect(count(hostSeen, 'escape:host')).toBeGreaterThanOrEqual(1);
    expect(count(screenSeen, 'escape:board')).toBeGreaterThanOrEqual(1);
  });

  it('the host gets a race’s team changes with the board, one batch a period, the last change kept (M9 Task 9.3)', async () => {
    const { host, pin } = await raceRoom('solo');
    const players: SyncedPlayer[] = [];
    for (let i = 0; i < 10; i++) players.push(await joinAndSync(ctx.h, pin, `B${i}`));
    await start(host, pin, players);
    await settle(1_100); // the start's frames are out of the window
    const hostSeen = record(host);
    const t0 = Date.now();
    // 10 teams, 20 changes within one board period: a wrong code each, then the drawer.
    const wrong = players.map((p) =>
      p.socket.emitWithAck('escape:submit', { pin, lockId: 'catalogue', input: '00' }),
    );
    await Promise.all(wrong);
    const right = players.map((p) =>
      p.socket.emitWithAck('escape:submit', { pin, lockId: 'catalogue', input: '42' }),
    );
    expect(await Promise.all(right)).toEqual(
      players.map(() => ({ ok: true, outcome: 'lock-solved' })),
    );
    await settle(Math.max(0, 2_200 - (Date.now() - t0)));
    const of = (e: string) => hostSeen.filter(([n]) => n === e).map(([, p]) => p);
    // Nothing one team at a time: no host-team, team-update or banner.
    expect(of('escape:host-team')).toEqual([]);
    expect(of('escape:team-update')).toEqual([]);
    expect(of('escape:announce')).toEqual([]);
    const batches = of('escape:host-batch') as EscapeHostBatch[];
    // One batch a period (2.2 s: the first at once, then at most two held ones).
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches.length).toBeLessThanOrEqual(3);
    for (const b of batches) expect(new Set(b.teams.map((t) => t.id)).size).toBe(b.teams.length);
    // Every host frame: at most 3 a second.
    expect(hostSeen.length).toBeLessThanOrEqual(3 * 3);
    // Every update arrives once, in order.
    const updates = batches.flatMap((b) => b.updates);
    const latest = new Map<string, EscapeHostTeam>();
    for (const [e, p] of hostSeen) {
      if (e === 'escape:host-batch')
        for (const t of (p as EscapeHostBatch).teams) latest.set(t.id, t);
      if (e === 'escape:host') for (const t of (p as EscapeHostState).teams) latest.set(t.id, t);
    }
    for (const p of players) {
      const id = p.last().team!.id;
      expect(updates.filter((u) => u.teamId === id).map((u) => u.kind)).toEqual([
        'wrong',
        'lock-solved',
      ]);
      // The last change arrived: the drawer solved, one wrong code.
      expect(latest.get(id)).toMatchObject({
        wrong: 1,
        solved: expect.arrayContaining(['catalogue']),
      });
    }
    // Nothing stays behind the room.
    const meta = (await ctx.h.app.get(GameService).getMeta(pin))!;
    const ended = nextEvent(host, 'game:ended');
    host.emit('host:end', { pin });
    await ended;
    await eventually(async () =>
      expect(ctx.h.app.get(EscapeEngine).inProcess(meta.id, pin).board).toBe(false),
    );
  });

  it('a race’s held host news goes out before its finale, and nothing of the run after it (M9 fix round)', async () => {
    const { host, pin } = await raceRoom('solo');
    const players: SyncedPlayer[] = [];
    for (let i = 0; i < 3; i++) players.push(await joinAndSync(ctx.h, pin, `F${i}`));
    await start(host, pin, players);
    await settle(1_100); // the start's frames are out of the window
    const hostSeen = record(host);
    // The first change opens the window; the others wait in it.
    for (const p of players) {
      await p.socket.emitWithAck('escape:submit', { pin, lockId: 'catalogue', input: '00' });
    }
    const ended = nextEvent<EscapeFinale>(host, 'escape:finale');
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    await ended;
    await settle(2_200); // past any held period
    const at = hostSeen.findIndex(([e]) => e === 'escape:finale');
    const feed = [
      'escape:host-batch',
      'escape:host',
      'escape:board',
      'escape:team-update',
      'escape:host-team',
    ];
    expect(hostSeen.slice(at + 1).filter(([e]) => feed.includes(e))).toEqual([]);
    // Every team's wrong code came before the finale.
    const updates = hostSeen
      .slice(0, at)
      .filter(([e]) => e === 'escape:host-batch')
      .flatMap(([, b]) => (b as EscapeHostBatch).updates);
    for (const p of players) {
      expect(updates.filter((u) => u.teamId === p.last().team!.id).map((u) => u.kind)).toEqual([
        'wrong',
      ]);
    }
  });

  it('escape:results in a race: a phone gets the top teams and its own row, the host all', async () => {
    const { host, pin } = await raceRoom('solo');
    const players: SyncedPlayer[] = [];
    for (let i = 0; i < 22; i++) players.push(await joinAndSync(ctx.h, pin, `Q${i}`));
    await start(host, pin, players);
    const ended = nextEvent<EscapeFinale>(host, 'escape:finale');
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    const { gameId, ranking } = await ended;
    // The phone that placed last.
    const last = players.find((p) => p.last().team?.id === ranking.at(-1)!.teamId)!;
    const mine = (await last.socket.emitWithAck('escape:results', {
      gameId,
      sessionToken: last.sessionToken,
    })) as { ok: true; finale: EscapeFinale };
    expect(mine.finale.totalTeams).toBe(22);
    expect(mine.finale.ranking).toHaveLength(21);
    expect(mine.finale.ranking.at(-1)?.teamId).toBe(last.last().team?.id);
    const full = (await host.emitWithAck('escape:results', { gameId })) as {
      finale: EscapeFinale;
    };
    expect(full.finale.ranking).toHaveLength(22);
    expect(full.finale.totalTeams).toBeUndefined();
  });

  it('a race finale: phones and the screen get the top teams and the total; the host all of them', async () => {
    const { host, pin } = await raceRoom('solo');
    const players: SyncedPlayer[] = [];
    for (let i = 0; i < 3; i++) players.push(await joinAndSync(ctx.h, pin, `F${i}`));
    const screen = ctx.h.connect();
    await screen.emitWithAck('spectator:join', { pin });
    expect(await screen.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    await start(host, pin, players);
    const phone = nextEvent<EscapeFinale>(players[0].socket, 'escape:finale');
    const own = nextEvent<EscapeFinale>(host, 'escape:finale');
    const shown = nextEvent<EscapeScreenFinale>(screen, 'escape:screen-finale');
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    expect((await phone).totalTeams).toBe(3);
    expect((await phone).ranking).toHaveLength(3);
    expect((await shown).totalTeams).toBe(3);
    const full = await own;
    expect(full.ranking).toHaveLength(3);
    expect(full.totalTeams).toBeUndefined();
  });
}
