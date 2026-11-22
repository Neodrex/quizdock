import type { EscapeBoard, EscapeFinale, EscapeScreenFinale } from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { GameService } from '../../src/game/game.service';
import { nextEvent, settle } from '../game-harness';
import { type EscapeContext, type RunningRoom, record, runningRoom } from './escape-harness';

/** Big screens (M6): the screen finale, its routing and the screens' reads. */
export function screenTests(ctx: EscapeContext): void {
  const finaleOn = (s: Socket) => nextEvent<EscapeFinale>(s, 'escape:finale');
  const screenFinaleOn = (s: Socket) => nextEvent<EscapeScreenFinale>(s, 'escape:screen-finale');
  const gameId = async (pin: string) => (await ctx.h.app.get(GameService).getMeta(pin))!.id;

  /**
   * Every kind of screen of a running room: the harness's (an unpaired copy),
   * the host's own window (signed in as the host), a screen paired by its code
   * and a participant's follow copy.
   */
  async function screensOf(room: RunningRoom): Promise<Record<string, Socket>> {
    const { pin, host } = room;
    const own = ctx.h.connectHost();
    expect(await own.emitWithAck('spectator:join', { pin })).toEqual({ ok: true });
    const paired = ctx.h.connect();
    const { pairingCode: code } = (await paired.emitWithAck('spectator:join', { pin })) as {
      pairingCode: string;
    };
    expect(code).toEqual(expect.any(String));
    const token = nextEvent(paired, 'screen:paired');
    expect(await host.emitWithAck('host:pair-screen', { pin, code })).toEqual({ ok: true });
    await token;
    const follow = ctx.h.connect();
    expect(await follow.emitWithAck('spectator:join', { pin, follow: true })).toEqual({
      ok: true,
    });
    return { unpaired: room.screen, own, paired, follow };
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
}
