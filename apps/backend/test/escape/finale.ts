import { type EscapeFinale, type EscapeScreenFinale, GameState } from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { GameEngine } from '../../src/game/game.engine';
import { type GameId, gameKeys } from '../../src/game/game.keys';
import { GameService } from '../../src/game/game.service';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { EscapeStore } from '../../src/escape/escape.store';
import { awards, rankTeams } from '../../src/escape/escape-rules';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type RunningRoom,
  createEscape,
  eventually,
  joinAndSync,
  record,
  runningRoom,
  stateWhere,
  submitAs,
} from './escape-harness';
import { receivedLeaks, screenLeaksIn } from './leaks';

/** End, finale, and a room closed or switched under a run (Task 3.15). */
export function finaleTests(ctx: EscapeContext): void {
  const unlock = (host: Socket, pin: string, teamId: string, lockId: string) =>
    host.emitWithAck('escape:unlock', { pin, teamId, lockId });

  /** The host opens every lock of every stage: the team escapes. */
  async function escapeTeam(room: RunningRoom, teamId: string): Promise<void> {
    for (const stage of ctx.vault.stages) {
      for (const lock of stage.locks) {
        expect(await unlock(room.host, room.pin, teamId, lock.id)).toEqual({ ok: true });
      }
    }
  }

  const finaleOn = (socket: Socket) => nextEvent<EscapeFinale>(socket, 'escape:finale');
  /** M6: screens get the screen finale instead (test/escape/screen.ts). */
  const screenFinaleOn = (socket: Socket) =>
    nextEvent<EscapeScreenFinale>(socket, 'escape:screen-finale');
  const gameId = async (pin: string) => (await ctx.h.app.get(GameService).getMeta(pin))!.id;
  const inProcess = (id: GameId, pin: string) => ctx.h.app.get(EscapeEngine).inProcess(id, pin);

  it('E1/E2: escape:end freezes the clocks and sends the finale to the phones and the host (the screen its own); the room is on its podium', async () => {
    const room = await runningRoom(ctx, { players: 2, teams: 2 });
    const { pin, host, screen, teams, players } = room;
    const seen = players.map((p) => record(p.socket));
    const screenSeen = record(screen);
    await escapeTeam(room, 't1');
    const id = await gameId(pin);
    const finales = [...players.map((p) => finaleOn(p.socket)), finaleOn(host)];
    const onScreen = screenFinaleOn(screen);
    const podium = nextEvent<{ state: string }>(screen, 'game:state', {
      where: (s) => s.state === GameState.Podium,
    });
    const last = stateWhere(teams.t2[0].socket, (s) => s.phase === 'finale');
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    const [first, ...rest] = await Promise.all(finales);
    for (const f of rest) expect(f).toEqual(first);
    expect((await onScreen).ranking.map((r) => r.teamId)).toEqual(
      first.ranking.map((r) => r.teamId),
    );
    await podium;

    const stored = await ctx.h.app.get(EscapeStore).teams(id);
    const states = [...stored.values()].map((r) => r.team);
    expect(first.ranking.map((r) => [r.teamId, r.place])).toEqual(
      rankTeams(states).map((r) => [r.team.id, r.place]),
    );
    expect(first.ranking[0]).toMatchObject({ teamId: 't1', place: 1, escaped: true });
    expect(first.ranking[1]).toMatchObject({ teamId: 't2', escaped: false, scoreMs: null });
    expect(first.awards.fastest).toBe('t1');
    expect(first.awards).toEqual({ ...awards(states), photoFinish: null });
    expect(await ctx.h.app.get(EscapeStore).results(id)).toEqual(first);
    expect((await ctx.h.app.get(GameService).getMeta(pin))!.state).toBe(GameState.Podium);

    // Frozen: the clock no longer moves, and nothing can be played or adjusted.
    const frozen = (await last).clock.elapsedMs;
    expect(await submitAs(teams.t2[0], pin, 'lobby-door', '0417')).toEqual({
      ok: false,
      reason: 'not-running',
    });
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: 60 })).toMatchObject({
      ok: false,
      error: { code: 'escape.wrong_phase' },
    });
    expect(await host.emitWithAck('escape:end', { pin })).toMatchObject({
      ok: false,
      error: { code: 'escape.wrong_phase' },
    });
    await settle(120);
    const again = stateWhere(teams.t2[0].socket, () => true);
    expect(await teams.t2[0].socket.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    expect((await again).clock.elapsedMs).toBe(frozen);

    // A second finale re-sends the same results.
    const resent = finaleOn(host);
    expect(await host.emitWithAck('escape:finale', { pin })).toEqual({ ok: true });
    expect(await resent).toEqual(first);
    expect(inProcess(id, pin)).toEqual({ ticking: false, gone: false, board: false });
    // Phones and the screen: nothing they should not see, the finale included.
    for (const [i, p] of players.entries()) {
      expect(receivedLeaks(seen[i], ctx.vault, p.playerId)).toEqual([]);
    }
    expect(receivedLeaks(screenSeen, ctx.vault)).toEqual([]);
    expect(screenLeaksIn(screenSeen, ctx.vault)).toEqual([]);
  });

  it('E2: a team past its deadline but not yet flagged gets its time-up before the finale', async () => {
    const { pin, host, teams } = await runningRoom(ctx, { players: 2, teams: 2 });
    // Paused: no tick flags the time-up; the finale has to.
    expect(await host.emitWithAck('escape:pause', { pin, paused: true })).toEqual({ ok: true });
    expect(
      await host.emitWithAck('escape:adjust-time', { pin, deltaS: -3600, teamId: 't1' }),
    ).toEqual({ ok: true });
    const seen = record(teams.t1[0].socket);
    const other = record(teams.t2[0].socket);
    const finale = finaleOn(teams.t1[0].socket);
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    await finale;
    const order = seen
      .filter(
        ([e, p]) =>
          e === 'escape:finale' ||
          (e === 'escape:team-update' && (p as { kind: string }).kind === 'time-up'),
      )
      .map(([e, p]) => (e === 'escape:finale' ? e : p));
    expect(order).toEqual([{ teamId: 't1', kind: 'time-up' }, 'escape:finale']);
    expect(other.filter(([e]) => e === 'escape:team-update')).toEqual([]);
  });

  it('T4: the last team out starts the finale on its own', async () => {
    const room = await runningRoom(ctx, { players: 1, teams: 1 });
    const finale = screenFinaleOn(room.screen);
    const state = stateWhere(room.players[0].socket, (s) => s.phase === 'finale');
    await escapeTeam(room, 't1');
    expect((await finale).ranking).toMatchObject([{ teamId: 't1', place: 1, escaped: true }]);
    expect((await state).team?.escaped).toBe(true);
    expect((await ctx.h.app.get(GameService).getMeta(room.pin))!.state).toBe(GameState.Podium);
  });

  it('escape:end and escape:finale are refused while forming', async () => {
    const host = ctx.h.connectHost();
    const pin = await createEscape(host, ctx.templateId);
    for (const event of ['escape:end', 'escape:finale']) {
      expect(await host.emitWithAck(event, { pin })).toMatchObject({
        ok: false,
        error: { code: 'escape.wrong_phase' },
      });
    }
  });

  it('escape:finale from a running run ends it first', async () => {
    const { pin, host, screen } = await runningRoom(ctx, { players: 2, teams: 2 });
    const finale = finaleOn(host);
    const onScreen = screenFinaleOn(screen);
    expect(await host.emitWithAck('escape:finale', { pin })).toEqual({ ok: true });
    expect((await finale).ranking).toHaveLength(2);
    expect((await onScreen).ranking).toHaveLength(2);
  });

  it('E3: host:end mid-run sends the finale (best effort) before game:ended; the ticker stops', async () => {
    const { pin, host, screen, players } = await runningRoom(ctx, { players: 2, teams: 2 });
    const id = await gameId(pin);
    expect(inProcess(id, pin).ticking).toBe(true);
    const seen = record(players[0].socket);
    const ended = nextEvent(players[0].socket, 'game:ended');
    const finale = finaleOn(players[0].socket);
    const onScreen = screenFinaleOn(screen);
    host.emit('host:end', { pin });
    await ended;
    const f = await finale;
    expect(f.ranking).toHaveLength(2);
    expect(f.gameId).toBe(id);
    await onScreen;
    const order = seen.map(([e]) => e).filter((e) => e === 'escape:finale' || e === 'game:ended');
    expect(order).toEqual(['escape:finale', 'game:ended']);
    expect(await ctx.h.app.get(EscapeStore).results(id)).toEqual(f);
    await eventually(async () =>
      expect(inProcess(id, pin)).toEqual({ ticking: false, gone: false, board: false }),
    );
    // The room stays ended: the finale does not put it back on a podium.
    expect((await ctx.h.app.get(GameService).getMeta(pin))!.state).toBe(GameState.Ended);
  });

  it('escape:results: the stored finale, after the room ended, to those who were in it', async () => {
    const { pin, host, players, screen } = await runningRoom(ctx, { players: 1, teams: 1 });
    const id = await gameId(pin);
    const [a] = players;
    const finale = finaleOn(a.socket);
    const ended = nextEvent(a.socket, 'game:ended');
    host.emit('host:end', { pin });
    const f = await finale;
    await ended;
    // Still connected: the phone (with its token) and the host console; a screen
    // never reads the full finale (M6 §1.4).
    expect(
      await a.socket.emitWithAck('escape:results', { gameId: id, sessionToken: a.sessionToken }),
    ).toEqual({ ok: true, finale: f });
    expect(await host.emitWithAck('escape:results', { gameId: id })).toEqual({
      ok: true,
      finale: f,
    });
    expect(await screen.emitWithAck('escape:results', { gameId: id })).toMatchObject({
      ok: false,
      error: { code: 'escape.not_in_room' },
    });
    // A phone back after a reload: its session token says it was there.
    const back = ctx.h.connect();
    expect(
      await back.emitWithAck('escape:results', { gameId: id, sessionToken: a.sessionToken }),
    ).toEqual({ ok: true, finale: f });
    // Anyone else is refused, and an unknown game has no results.
    const stranger = ctx.h.connect();
    expect(await stranger.emitWithAck('escape:results', { gameId: id })).toMatchObject({
      ok: false,
      error: { code: 'escape.not_in_room' },
    });
    expect(
      await stranger.emitWithAck('escape:results', { gameId: id, sessionToken: 'nope' }),
    ).toMatchObject({ ok: false, error: { code: 'escape.not_in_room' } });
    expect(await a.socket.emitWithAck('escape:results', { gameId: 'f'.repeat(32) })).toMatchObject({
      ok: false,
      error: { code: 'escape.not_found' },
    });
  });

  it("escape:results: the run's host reads them on a new socket after the room closed; nobody else does", async () => {
    const { pin, host, players } = await runningRoom(ctx, { players: 1, teams: 1 });
    const id = await gameId(pin);
    const finale = finaleOn(players[0].socket);
    const ended = nextEvent(players[0].socket, 'game:ended');
    host.emit('host:end', { pin });
    const f = await finale;
    await ended;
    host.disconnect();
    // A reload after the room closed: a new console socket, no room, the same user.
    const back = ctx.h.connectHost();
    expect(await back.emitWithAck('escape:results', { gameId: id })).toEqual({
      ok: true,
      finale: f,
    });
    const refused = { ok: false, error: { code: 'escape.not_in_room' } };
    const other = ctx.h.connect({ localUser: 'Another host' });
    expect(await other.emitWithAck('escape:results', { gameId: id })).toMatchObject(refused);
  });

  it('escape:results: a recycled PIN gives another host its own room, not the old run', async () => {
    const { pin, host, players } = await runningRoom(ctx, { players: 1, teams: 1 });
    const id = await gameId(pin);
    const finale = finaleOn(players[0].socket);
    const ended = nextEvent(players[0].socket, 'game:ended');
    host.emit('host:end', { pin });
    const f = await finale;
    await ended;

    // Another host gets the seat and, by chance, the same PIN for a room of their own.
    const { prisma } = ctx.h;
    const other = await prisma.user.upsert({
      where: { oidcSubject: 'local:recycler' },
      create: { oidcSubject: 'local:recycler', displayName: 'Recycler', roles: ['host'] },
      update: { roles: ['host'] },
    });
    const template = await prisma.escapeTemplate.create({
      data: {
        ownerId: other.id,
        title: ctx.vault.title,
        status: 'published',
        content: { ...ctx.vault, id: undefined } as object,
        version: 1,
      },
    });
    const service = ctx.h.app.get(GameService);
    const redis = (service as unknown as { redis: { set(...a: unknown[]): Promise<unknown> } })
      .redis;
    const alloc = jest
      .spyOn(service as unknown as { allocatePin(roomId: string): Promise<string> }, 'allocatePin')
      .mockImplementationOnce(async (roomId: string) => {
        await redis.set(gameKeys.pin(pin), roomId, 'EX', 3600, 'NX');
        return pin;
      });
    await prisma.hostSeat.update({ where: { id: 1 }, data: { userId: other.id } });
    try {
      const recycler = ctx.h.connect({ localUser: 'Recycler' });
      expect(await createEscape(recycler, template.id)).toBe(pin);
      expect(await gameId(pin)).not.toBe(id);
      // In the live room of that PIN, but not the old run's host: refused.
      expect(await recycler.emitWithAck('escape:results', { gameId: id })).toMatchObject({
        ok: false,
        error: { code: 'escape.not_in_room' },
      });
      // The old run's host still reads them.
      const back = ctx.h.connectHost();
      expect(await back.emitWithAck('escape:results', { gameId: id })).toEqual({
        ok: true,
        finale: f,
      });
      recycler.emit('host:end', { pin });
    } finally {
      alloc.mockRestore();
      await prisma.hostSeat.update({ where: { id: 1 }, data: { userId: ctx.h.hostUserId } });
      await prisma.escapeTemplate.delete({ where: { id: template.id } }).catch(() => undefined);
    }
  });

  it("escape:results: a phone signed in as the host's user still needs its token", async () => {
    const { pin, host } = await runningRoom(ctx, { players: 1, teams: 1 });
    const id = await gameId(pin);
    // In local mode a phone may carry the host's name: it is a player, so the token decides.
    const phone = ctx.h.connectHost();
    const joined = await phone.emitWithAck('player:join', { pin, nickname: 'Twin' });
    expect(joined.playerId).toEqual(expect.any(String));
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    expect(await phone.emitWithAck('escape:results', { gameId: id })).toMatchObject({
      ok: false,
      error: { code: 'escape.not_in_room' },
    });
  });

  it('escape:results: a phone needs its token; a switched room refuses the old run to newcomers and the screen', async () => {
    const { pin, host, players, screen } = await runningRoom(ctx, { players: 1, teams: 1 });
    const id = await gameId(pin);
    const [a] = players;
    const finale = finaleOn(a.socket);
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    const f = await finale;
    const refused = { ok: false, error: { code: 'escape.not_in_room' } };
    const ask = (s: Socket, sessionToken?: string) =>
      s.emitWithAck('escape:results', { gameId: id, ...(sessionToken ? { sessionToken } : {}) });

    // A phone of the run, still connected: its socket's PIN alone is not enough.
    expect(await ask(a.socket)).toMatchObject(refused);
    expect(await ask(a.socket, a.sessionToken)).toEqual({ ok: true, finale: f });
    // The host console, while the room is still on this run. The screens never
    // (M6 §1.4), the host's own window (signed in as the host) included.
    const hostScreen = ctx.h.connectHost();
    await hostScreen.emitWithAck('spectator:join', { pin });
    expect(await ask(host)).toEqual({ ok: true, finale: f });
    expect(await ask(screen)).toMatchObject(refused);
    expect(await ask(hostScreen)).toMatchObject(refused);

    // The room moves on to a new run under the same PIN.
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    expect(await host.emitWithAck('escape:open', { pin, templateId: ctx.templateId })).toEqual({
      ok: true,
    });
    expect(await gameId(pin)).not.toBe(id);
    const newcomer = await joinAndSync(ctx.h, pin, 'New');
    // A newcomer who knows the old id: refused without a token, and with its own
    // token, as it was in no team of the old run.
    expect(await ask(newcomer.socket)).toMatchObject(refused);
    expect(await ask(newcomer.socket, newcomer.sessionToken)).toMatchObject(refused);
    // The screen is in the room of another game now; the host, the run's host, still reads it.
    expect(await ask(host)).toEqual({ ok: true, finale: f });
    expect(await ask(screen)).toMatchObject(refused);
    // A screen signed in as the host is still a screen: its live room decides, not its user.
    expect(await ask(hostScreen)).toMatchObject(refused);
    // The old run's player still gets its results with its token.
    expect(await ask(a.socket, a.sessionToken)).toEqual({ ok: true, finale: f });
  });

  it('host gone: the host window never cuts a run short; it closes the room once the run is over', async () => {
    const room = await runningRoom(ctx, { players: 2, teams: 2 });
    const { pin, host, teams } = room;
    const [a] = teams.t1;
    const away = nextEvent<{ state: string }>(a.socket, 'game:state', {
      where: (s) => s.state === GameState.HostDisconnected,
    });
    host.disconnect();
    await away;
    // Owner decision 1: the run goes on without its host.
    expect(await submitAs(a, pin, 'lobby-door', '0417')).toEqual({
      ok: true,
      outcome: 'lock-solved',
    });
    const meta = (await ctx.h.app.get(GameService).getMeta(pin))!;
    // GameEngine.endOrphaned: the 15-minute host window, run now (as its timer would).
    const engine = ctx.h.app.get(GameEngine) as unknown as {
      endOrphaned(ref: { pin: string; id: GameId }, hostUserId: string): Promise<void>;
    };
    const windowEnds = () => engine.endOrphaned({ pin, id: meta.id }, meta.hostUserId);
    let ended = 0;
    a.socket.on('game:ended', () => ended++);
    // Twice while the run plays: the room stays open, the window is armed again.
    await windowEnds();
    await windowEnds();
    await settle(100);
    expect(ended).toBe(0);
    const still = (await ctx.h.app.get(GameService).getMeta(pin))!;
    expect(still.state).toBe(GameState.HostDisconnected);
    expect(still.prevState).toBe(GameState.Escape);
    expect((await ctx.h.app.get(EscapeStore).run(meta.id))!.phase).toBe('running');

    // The run reaches its time limit: the finale, the room on its podium for the host.
    const finale = finaleOn(a.socket);
    const store = ctx.h.app.get(EscapeStore);
    const run = (await store.run(meta.id))!;
    await store.saveRun(meta.id, { ...run, clock: { ...run.clock, limitMs: 1 } });
    const f = await finale;
    expect(f.ranking.find((r) => r.teamId === 't1')).toMatchObject({ escaped: false });
    const over = (await ctx.h.app.get(GameService).getMeta(pin))!;
    expect(over.state).toBe(GameState.HostDisconnected);
    expect(over.prevState).toBe(GameState.Podium);
    expect(ended).toBe(0);

    // The next expiry closes the room.
    const gameEnded = nextEvent(a.socket, 'game:ended');
    await windowEnds();
    await gameEnded;
    expect((await ctx.h.app.get(GameService).getMeta(pin))!.state).toBe(GameState.Ended);
    expect(await store.results(meta.id)).toEqual(f);
  });

  it('host gone: a run that ends on its own keeps its podium when the host comes back', async () => {
    const room = await runningRoom(ctx, { players: 1, teams: 1 });
    const { pin, host, players } = room;
    const [a] = players;
    // Everything but the last lock, while the host is here.
    const locks = ctx.vault.stages.flatMap((s) => s.locks.map((l) => l.id));
    for (const lockId of locks.slice(0, -1)) {
      expect(await unlock(host, pin, 't1', lockId)).toEqual({ ok: true });
    }
    const away = nextEvent<{ state: string }>(a.socket, 'game:state', {
      where: (s) => s.state === GameState.HostDisconnected,
    });
    host.disconnect();
    await away;
    const finale = finaleOn(a.socket);
    expect(a.last().view!.stageIndex).toBe(ctx.vault.stages.length - 1);
    expect(await submitAs(a, pin, locks.at(-1)!, ['south', 'west'])).toEqual({
      ok: true,
      outcome: 'escaped',
    });
    await finale;
    const meta = (await ctx.h.app.get(GameService).getMeta(pin))!;
    expect(meta.state).toBe(GameState.HostDisconnected);
    expect(meta.prevState).toBe(GameState.Podium);
    // The host is back: the room goes to its podium, not back to a running run.
    const back = ctx.h.connectHost();
    const podium = nextEvent<{ state: string }>(a.socket, 'game:state', {
      where: (s) => s.state === GameState.Podium,
    });
    expect(await back.emitWithAck('host:attach', { pin })).toMatchObject({ ok: true });
    await podium;
  });

  it('E4: host:back-to-lobby mid-run stops the run without a finale', async () => {
    const { pin, host, players, screen } = await runningRoom(ctx, { players: 2, teams: 1 });
    const id = await gameId(pin);
    let finales = 0;
    screen.on('escape:finale', () => finales++);
    screen.on('escape:screen-finale', () => finales++);
    players[0].socket.on('escape:finale', () => finales++);
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    expect(await submitAs(players[0], pin, 'lobby-door', '0417')).toMatchObject({
      ok: false,
      error: { code: 'escape.not_found' },
    });
    await eventually(async () =>
      expect(inProcess(id, pin)).toEqual({ ticking: false, gone: false, board: false }),
    );
    await settle(150);
    expect(finales).toBe(0);
  });
}
