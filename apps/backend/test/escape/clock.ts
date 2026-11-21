import type { EscapeHostTeam, EscapePlayerState, EscapeTeamUpdate } from '@quiz-dock/contracts';
import { rankTeams } from '../../src/escape/escape-rules';
import { EscapeStore } from '../../src/escape/escape.store';
import { GameService } from '../../src/game/game.service';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  eventually,
  record,
  runningRoom,
  stateWhere,
  submitAs,
} from './escape-harness';
import { receivedLeaks } from './leaks';

/** Pause, resume and time adjustments (Task 3.12). */
export function clockTests(ctx: EscapeContext): void {
  const timeUpdate = (p: SyncedPlayer, where: (u: EscapeTeamUpdate) => boolean = () => true) =>
    nextEvent<EscapeTeamUpdate>(p.socket, 'escape:team-update', {
      where: (u) => (u.kind === 'time' || u.kind === 'time-up') && where(u),
    });

  /** Vault Heist's limit (40 min) less 1 s: a deadline about a second away. */
  const NEAR_DEADLINE_S = -(40 * 60 - 1);

  async function teamsOf(pin: string) {
    const id = (await ctx.h.app.get(GameService).getMeta(pin))!.id;
    return [...(await ctx.h.app.get(EscapeStore).teams(id)).values()];
  }

  it('P1/P2: a pause freezes every clock and refuses submits; resume continues where it stopped', async () => {
    const { pin, host, players } = await runningRoom(ctx, { players: 2, teams: 2 });
    const paused = players.map((p) => stateWhere(p.socket, (s) => s.clock.paused));
    expect(await host.emitWithAck('escape:pause', { pin, paused: true })).toEqual({ ok: true });
    const frozen = await Promise.all(paused);
    for (const s of frozen) {
      expect(s.team).toMatchObject({ deadlineAt: null });
      expect(s.team!.remainingMs).toBeGreaterThan(0);
    }
    expect(await submitAs(players[0], pin, 'lobby-door', '0417')).toEqual({
      ok: false,
      reason: 'paused',
    });
    await settle(200);
    // Still frozen: a fresh sync gives the same run time and remaining time.
    const again = stateWhere(players[0].socket, () => true);
    await players[0].socket.emitWithAck('escape:sync', { pin });
    const still = await again;
    expect(still.clock.elapsedMs).toBe(frozen[0].clock.elapsedMs);
    expect(still.team!.remainingMs).toBe(frozen[0].team!.remainingMs);

    const resumed = players.map((p) => stateWhere(p.socket, (s) => !s.clock.paused));
    expect(await host.emitWithAck('escape:pause', { pin, paused: false })).toEqual({ ok: true });
    const back = await Promise.all(resumed);
    for (const [i, s] of back.entries()) {
      expect(s.clock.elapsedMs - frozen[i].clock.elapsedMs).toBeLessThan(100);
      expect(s.team!.deadlineAt).toEqual(expect.any(Number));
    }
    expect(await submitAs(players[0], pin, 'lobby-door', '0417')).toMatchObject({ ok: true });
  });

  it('pausing or resuming twice is a no-op', async () => {
    const { pin, host, players } = await runningRoom(ctx, { players: 1, teams: 1 });
    const paused = stateWhere(players[0].socket, (s) => s.clock.paused);
    await host.emitWithAck('escape:pause', { pin, paused: true });
    await paused;
    const seen = record(players[0].socket);
    expect(await host.emitWithAck('escape:pause', { pin, paused: true })).toEqual({ ok: true });
    await settle(100);
    expect(seen.filter(([e]) => e === 'escape:state')).toEqual([]);
    // Resume twice: also a no-op the second time.
    await host.emitWithAck('escape:pause', { pin, paused: false });
    await settle(50);
    const seen2 = record(players[0].socket);
    expect(await host.emitWithAck('escape:pause', { pin, paused: false })).toEqual({ ok: true });
    await settle(100);
    expect(seen2.filter(([e]) => e === 'escape:state')).toEqual([]);
  });

  it('while paused the ticker does nothing (no time-up, no stuck); resume brings them back', async () => {
    const { pin, host, teams } = await runningRoom(ctx, { players: 1, teams: 1 });
    const [a] = teams.t1;
    // A deadline about a second away, then the pause at once.
    await host.emitWithAck('escape:adjust-time', { pin, deltaS: NEAR_DEADLINE_S });
    await host.emitWithAck('escape:pause', { pin, paused: true });
    const seen = record(a.socket);
    const hostSeen = record(host);
    await settle(1_500);
    expect(seen.filter(([, u]) => (u as EscapeTeamUpdate).kind === 'time-up')).toEqual([]);
    expect(hostSeen.filter(([e]) => e === 'escape:host-team')).toEqual([]);
    expect(a.last().team?.timedOut).toBe(false);
    // The host may still give a hint while paused.
    expect(await host.emitWithAck('escape:hint', { pin })).toEqual({ ok: true, released: 1 });
    const timeUp = timeUpdate(a, (u) => u.kind === 'time-up');
    await host.emitWithAck('escape:pause', { pin, paused: false });
    expect(await timeUp).toEqual({ teamId: 't1', kind: 'time-up' });
  });

  it('T1: extra time for one team moves its deadline only, not the ranking; all teams at once', async () => {
    const { pin, host, teams, players } = await runningRoom(ctx, { players: 2, teams: 2 });
    const seen = players.map((p) => record(p.socket));
    const [a] = teams.t1;
    const [b] = teams.t2;
    const before = rankTeams((await teamsOf(pin)).map((r) => r.team));
    const bTime = timeUpdate(b);
    const bState = stateWhere(b.socket, (s) => s.team!.remainingMs > 2_400_000);
    expect(
      await host.emitWithAck('escape:adjust-time', { pin, deltaS: 120, teamId: 't2' }),
    ).toEqual({ ok: true });
    expect(await bTime).toEqual({ teamId: 't2', kind: 'time', deltaMs: 120_000 });
    const bs = await bState;
    const as = a.last();
    // Same instant for both: the deadlines are 120 s apart.
    expect(bs.team!.deadlineAt! - as.team!.deadlineAt!).toBeGreaterThan(119_000);
    expect(bs.team!.deadlineAt! - as.team!.deadlineAt!).toBeLessThan(121_000);
    await settle(100);
    expect(seen[players.indexOf(a)].filter(([e]) => e === 'escape:team-update')).toEqual([]);
    // Deadline only: the ranking (order and scores) is the same.
    const after = rankTeams((await teamsOf(pin)).map((r) => r.team));
    const strip = (r: typeof before) => r.map((x) => [x.team.id, x.place, x.scoreMs]);
    expect(strip(after)).toEqual(strip(before));
    expect(after.find((x) => x.team.id === 't2')!.team.adjustMs).toBe(120_000);

    const all = [timeUpdate(a), timeUpdate(b)];
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: -60 })).toEqual({
      ok: true,
    });
    for (const u of await Promise.all(all))
      expect(u).toMatchObject({ kind: 'time', deltaMs: -60_000 });
    const adjusts = (await teamsOf(pin)).map((r) => [r.team.id, r.team.adjustMs]).sort();
    expect(adjusts).toEqual([
      ['t1', -60_000],
      ['t2', 60_000],
    ]);
    expect(receivedLeaks(seen.flat(), ctx.vault)).toEqual([]);
  });

  it('adjusting is refused for an escaped team, an unknown team, or outside a running run', async () => {
    const store = ctx.h.app.get(EscapeStore);
    const { pin, host } = await runningRoom(ctx, { players: 2, teams: 2 });
    const id = (await ctx.h.app.get(GameService).getMeta(pin))!.id;
    const t1 = (await store.team(id, 't1'))!;
    await store.save(id, { teams: [{ ...t1, team: { ...t1.team, escapedAt: 1_000 } }] });
    expect(
      await host.emitWithAck('escape:adjust-time', { pin, deltaS: 60, teamId: 't1' }),
    ).toMatchObject({ ok: false, error: { code: 'escape.team_escaped' } });
    expect(
      await host.emitWithAck('escape:adjust-time', { pin, deltaS: 60, teamId: 'zz' }),
    ).toMatchObject({ ok: false, error: { code: 'escape.team_not_found' } });
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: 0 })).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: 3601 })).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
    // Every team: the escaped one is left alone.
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: 30 })).toEqual({ ok: true });
    const adjusts = Object.fromEntries(
      [...(await store.teams(id)).values()].map((r) => [r.team.id, r.team.adjustMs]),
    );
    expect(adjusts).toEqual({ t1: 0, t2: 30_000 });
  });

  it('time added to a timed-out team brings it back while the run still runs', async () => {
    const { pin, host, teams } = await runningRoom(ctx, { players: 2, teams: 2 });
    const [a] = teams.t1;
    const timeUp = timeUpdate(a, (u) => u.kind === 'time-up');
    await host.emitWithAck('escape:adjust-time', { pin, deltaS: -3600, teamId: 't1' });
    await timeUp;
    await eventually(async () => expect(a.last().team?.timedOut).toBe(true));
    const back = stateWhere(a.socket, (s: EscapePlayerState) => s.team?.timedOut === false);
    await host.emitWithAck('escape:adjust-time', { pin, deltaS: 3600, teamId: 't1' });
    const s = await back;
    expect(s.team!.deadlineAt).toEqual(expect.any(Number));
    expect(s.team!.remainingMs).toBeGreaterThan(2_000_000);
    expect(await submitAs(a, pin, 'lobby-door', '0417')).toMatchObject({ ok: true });
    // The tick does not flag it again.
    const hostSeen = record(host);
    await settle(200);
    expect(
      hostSeen.filter(
        ([e, t]) => e === 'escape:host-team' && (t as EscapeHostTeam).timedOut === true,
      ),
    ).toEqual([]);
  });

  it('quiz host:pause on an escape room gives session.escape_game', async () => {
    const { pin, host } = await runningRoom(ctx, { players: 1, teams: 1 });
    expect(await host.emitWithAck('host:pause', { pin, paused: true })).toMatchObject({
      ok: false,
      error: { code: 'session.escape_game' },
    });
  });
}
