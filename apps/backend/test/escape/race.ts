import {
  type EscapeFinale,
  type EscapeHostState,
  type EscapeScreenFinale,
  GameState,
} from '@quiz-dock/contracts';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { EscapeTimings } from '../../src/escape/escape-timings';
import { GameService } from '../../src/game/game.service';
import { gameKeys } from '../../src/game/game.keys';
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

    // F starts a team, then another: the first is left empty.
    const ghost = (await f.socket.emitWithAck('escape:new-team', { pin, name: 'Ghost' })) as {
      teamId: string;
      code: string;
    };
    const bats = (await f.socket.emitWithAck('escape:new-team', { pin, name: 'Bats' })) as {
      teamId: string;
      code: string;
    };
    expect(bats.code).not.toBe(ghost.code);

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

  it('escape:new-team and escape:join-team belong to team races', async () => {
    const { pin } = await raceRoom('solo');
    const p = await joinAndSync(ctx.h, pin, 'Solo');
    const out = refused('escape.not_in_session');
    expect(await p.socket.emitWithAck('escape:new-team', { pin, name: 'X' })).toMatchObject(out);
    expect(await p.socket.emitWithAck('escape:join-team', { pin, code: 'ABCD' })).toMatchObject(
      out,
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

    it('a restart before startsAt arms it again (recover), and it starts', async () => {
      const { pin } = await scheduled(1_500);
      const a = await joinAndSync(ctx.h, pin, 'Ann');
      const meta = await metaOf(pin);
      // What a restart loses: the timer.
      const inner = engine() as unknown as {
        scheduler: { disarm(pin: string): void };
        recover(): Promise<void>;
      };
      inner.scheduler.disarm(pin);
      expect(engine().inProcess(meta.id, pin).scheduled).toBe(false);
      await inner.recover();
      expect(engine().inProcess(meta.id, pin).scheduled).toBe(true);
      await stateWhere(a.socket, (s) => s.phase === 'running', 5_000);
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
