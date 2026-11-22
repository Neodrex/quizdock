import type { EscapeBoard, EscapeFinale, EscapeScreenFinale } from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { GameService } from '../../src/game/game.service';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type RunningRoom,
  createEscape,
  extraScreens,
  joinAndSync,
  record,
  runningRoom,
  submitAs,
} from './escape-harness';
import { answersOf, screenLeaksIn } from './leaks';

/** Big screens (M6): the screen finale, its routing and the screens' reads. */
export function screenTests(ctx: EscapeContext): void {
  const finaleOn = (s: Socket) => nextEvent<EscapeFinale>(s, 'escape:finale');
  const screenFinaleOn = (s: Socket) => nextEvent<EscapeScreenFinale>(s, 'escape:screen-finale');
  const gameId = async (pin: string) => (await ctx.h.app.get(GameService).getMeta(pin))!.id;

  /** Every kind of screen of a running room, the harness's unpaired copy included. */
  async function screensOf(room: RunningRoom): Promise<Record<string, Socket>> {
    return { unpaired: room.screen, ...(await extraScreens(ctx.h, room.pin, room.host)) };
  }

  it('escape:end: the phones and the host get the finale, every screen the screen finale only', async () => {
    const room = await runningRoom(ctx, { players: 2, teams: 2 });
    const { pin, host, players } = room;
    const screens = await screensOf(room);
    const seen = Object.fromEntries(Object.entries(screens).map(([k, s]) => [k, record(s)]));
    const full = [...players.map((p) => finaleOn(p.socket)), finaleOn(host)];
    const onScreens = Object.values(screens).map(screenFinaleOn);
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    const [f, ...rest] = await Promise.all(full);
    for (const g of rest) expect(g).toEqual(f);
    const [sf, ...others] = await Promise.all(onScreens);
    for (const g of others) expect(g).toEqual(sf);

    expect(sf.gameId).toBe(await gameId(pin));
    expect(sf.ranking.map((r) => r.teamId)).toEqual(f.ranking.map((r) => r.teamId));
    expect(sf.ranking.map((r) => r.members)).toEqual(f.ranking.map((r) => r.members));
    expect(sf.stages).toEqual(ctx.vault.stages.map((s) => ({ title: s.title })));
    expect(sf.limitMs).toBe(ctx.vault.targetMinutes * 60_000);
    await settle(120);
    for (const [kind, frames] of Object.entries(seen)) {
      expect([kind, frames.filter(([e]) => e === 'escape:finale')]).toEqual([kind, []]);
    }
    // escape:finale again: the same two payloads again.
    const again = [finaleOn(players[0].socket), finaleOn(host), screenFinaleOn(screens.paired)];
    expect(await host.emitWithAck('escape:finale', { pin })).toEqual({ ok: true });
    const [f2, h2, s2] = await Promise.all(again);
    expect(f2).toEqual(f);
    expect(h2).toEqual(f);
    expect(s2).toEqual(sf);
    await settle(120);
    for (const [kind, frames] of Object.entries(seen)) {
      expect([kind, frames.filter(([e]) => e === 'escape:finale')]).toEqual([kind, []]);
    }
  });

  it('a screen that syncs in the finale gets the board and the screen finale', async () => {
    const room = await runningRoom(ctx, { players: 1, teams: 1 });
    const { pin, host } = room;
    const f = finaleOn(host);
    const sf = screenFinaleOn(room.screen);
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    await f;
    const expected = await sf;
    // A reload: a new socket, joined and synced in the finale.
    const back = ctx.h.connect();
    await back.emitWithAck('spectator:join', { pin });
    const seen = record(back);
    const board = nextEvent<EscapeBoard>(back, 'escape:board');
    const screenFinale = screenFinaleOn(back);
    expect(await back.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    expect((await board).phase).toBe('finale');
    expect(await screenFinale).toEqual(expected);
    await settle(50);
    expect(seen.filter(([e]) => e === 'escape:finale')).toEqual([]);
  });

  it('escape:results refuses every screen; the phone token and the host stay readable', async () => {
    const room = await runningRoom(ctx, { players: 1, teams: 1 });
    const { pin, host, players } = room;
    const screens = await screensOf(room);
    const id = await gameId(pin);
    const f = finaleOn(host);
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    const finale = await f;
    for (const [kind, s] of Object.entries(screens)) {
      expect([kind, await s.emitWithAck('escape:results', { gameId: id })]).toMatchObject([
        kind,
        { ok: false, error: { code: 'escape.not_in_room' } },
      ]);
    }
    const [a] = players;
    expect(
      await a.socket.emitWithAck('escape:results', { gameId: id, sessionToken: a.sessionToken }),
    ).toEqual({ ok: true, finale });
    expect(await host.emitWithAck('escape:results', { gameId: id })).toEqual({ ok: true, finale });
  });

  it('the lobby board names the players as they come and as teams form; the run empties it', async () => {
    const host = ctx.h.connectHost();
    const pin = await createEscape(host, ctx.templateId);
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const screen = ctx.h.connect();
    await screen.emitWithAck('spectator:join', { pin });
    const first = nextEvent<EscapeBoard>(screen, 'escape:board');
    expect(await screen.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    expect(await first).toMatchObject({
      gameId: await gameId(pin),
      phase: 'forming',
      formation: { mode: 'auto', maxSize: null },
      roster: [],
    });
    // A phone joins and syncs: the screen sees its nickname, with no team yet.
    const named = nextEvent<EscapeBoard>(screen, 'escape:board', {
      where: (b) => b.roster.some((r) => r.nickname === 'Ada'),
    });
    await joinAndSync(ctx.h, pin, 'Ada');
    expect((await named).roster).toEqual([{ teamId: null, nickname: 'Ada', connected: true }]);
    await joinAndSync(ctx.h, pin, 'Ben');
    const dealt = nextEvent<EscapeBoard>(screen, 'escape:board', {
      where: (b) => b.roster.length === 2 && b.roster.every((r) => r.teamId !== null),
    });
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 2 })).toEqual({
      ok: true,
    });
    expect((await dealt).roster.map((r) => r.nickname)).toEqual(['Ada', 'Ben']);
    const started = nextEvent<EscapeBoard>(screen, 'escape:board', {
      where: (b) => b.phase === 'running',
    });
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect((await started).roster).toEqual([]);
  });

  it('screenLeaksIn catches each kind of leak, and lets nicknames through', () => {
    const tpl = ctx.vault;
    const [stage] = tpl.stages;
    const shared = stage.clues.find((c) => c.roleId === null) ?? stage.clues[0];
    const leaky: [string, unknown][] = [
      ['escape:state', {}],
      ['escape:team-update', {}],
      ['escape:host', {}],
      ['escape:host-team', {}],
      ['escape:outline', {}],
      ['escape:finale', {}],
      ['escape:board', { teams: [{ unlockText: 'x' }] }],
      ['escape:screen-finale', { ranking: [{ adjustMs: 0, hostUnlocks: 0, paidHints: 0 }] }],
      ['escape:board', { roster: [{ playerId: 'p1', nickname: 'Ann' }] }],
      ['escape:announce', { teamName: stage.unlockText }],
      ['escape:announce', { teamName: stage.intro }],
      ['escape:board', { title: shared.body }],
      ['escape:board', { title: stage.hints[0].text }],
      ['escape:board', { title: answersOf(tpl)[0] }],
    ];
    const found = leaky.map((frame) => screenLeaksIn([frame], tpl));
    for (const [i, f] of found.entries()) expect([i, f.length > 0]).toEqual([i, true]);
    expect(found[7]).toHaveLength(3);
    const clean: [string, unknown][] = [
      ['escape:board', { roster: [{ teamId: null, nickname: 'Ann', connected: true }] }],
      ['escape:screen-finale', { ranking: [{ members: ['Ann', 'Bob'] }], title: tpl.title }],
      ['escape:board', { teams: [{ stageTitle: stage.title }] }],
    ];
    expect(screenLeaksIn(clean, tpl)).toEqual([]);
  });

  it('every kind of screen gets nothing it should not over a run, and the nicknames it should', async () => {
    let screens!: Record<string, Socket>;
    const seen: Record<string, [string, unknown][]> = {};
    const room = await runningRoom(ctx, {
      players: 2,
      teams: 1,
      beforeStart: async (pin, r) => {
        seen.unpaired = record(r.screen);
        const extra = await extraScreens(ctx.h, pin, r.host);
        for (const [k, s] of Object.entries(extra)) seen[k] = record(s);
        // The recordings above start after the sync: sync again for the forming board.
        for (const s of [r.screen, ...Object.values(extra)]) {
          expect(await s.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
        }
        screens = { unpaired: r.screen, ...extra };
      },
    });
    const { pin, host, teams } = room;
    const [a] = teams.t1;
    expect(await host.emitWithAck('escape:hint', { pin, teamId: 't1' })).toEqual({
      ok: true,
      released: 1,
    });
    expect(await submitAs(a, pin, 'lobby-door', '0417')).toMatchObject({ ok: true });
    expect(
      await host.emitWithAck('escape:unlock', { pin, teamId: 't1', lockId: 'lobby-badge' }),
    ).toEqual({ ok: true });
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: 60 })).toEqual({ ok: true });
    const finales = Object.values(screens).map(screenFinaleOn);
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    await Promise.all(finales);
    await settle(100);
    const nicknames = room.players.map((p) => p.nickname);
    for (const [kind, frames] of Object.entries(seen)) {
      expect([kind, screenLeaksIn(frames, ctx.vault)]).toEqual([kind, []]);
      // Nicknames do reach the screen: the forming roster and the finale's members.
      const roster = frames
        .filter(([e]) => e === 'escape:board')
        .flatMap(([, b]) => (b as EscapeBoard).roster.map((r) => r.nickname));
      expect([kind, [...new Set(roster)].sort()]).toEqual([kind, [...nicknames].sort()]);
      const members = frames
        .filter(([e]) => e === 'escape:screen-finale')
        .flatMap(([, f]) => (f as EscapeScreenFinale).ranking.flatMap((r) => r.members));
      expect([kind, members.sort()]).toEqual([kind, [...nicknames].sort()]);
    }
  });
}
