import type {
  EscapeAnnounce,
  EscapeAskHintAck,
  EscapeHostTeam,
  EscapePlayerState,
  EscapeTeamUpdate,
} from '@quiz-dock/contracts';
import { escapeKeys } from '../../src/escape/escape.keys';
import { vaultHeist } from '../../src/escape/samples';
import { GameService } from '../../src/game/game.service';
import { RedisService } from '../../src/redis/redis.service';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  eventually,
  nextHostTeam,
  record,
  runningRoom,
  seedTemplate,
  stateWhere,
  submitAs,
} from './escape-harness';
import { leaksIn, receivedLeaks, screenLeaksIn } from './leaks';

/** Hints on request, by the host and on a timer; stuck warnings; time-up (Task 3.11). */
export function hintTests(ctx: EscapeContext): void {
  const ask = (p: SyncedPlayer, pin: string, hintId: string): Promise<EscapeAskHintAck> =>
    p.socket.emitWithAck('escape:ask-hint', { pin, hintId });

  const hintUpdate = (p: SyncedPlayer) =>
    nextEvent<EscapeTeamUpdate>(p.socket, 'escape:team-update', {
      where: (u) => u.kind === 'hint',
    });

  const lobbyH1 = vaultHeist.stages[0].hints[0];

  it('H1: asking for the offered hint releases it, paid, and its text reaches the team', async () => {
    const { pin, teams, players, screen } = await runningRoom(ctx, { players: 2, teams: 1 });
    const seen = [...players.map((p) => record(p.socket)), record(screen)];
    const [a, b] = teams.t1;
    expect(a.last().nextHint).toEqual({ id: lobbyH1.id, penaltyS: lobbyH1.penaltyS });
    const update = hintUpdate(b);
    const state = stateWhere(b.socket, (s) => (s.view?.hints.length ?? 0) > 0);
    const announce = nextEvent<EscapeAnnounce>(screen, 'escape:announce');
    expect(await ask(a, pin, lobbyH1.id)).toEqual({ ok: true });
    expect(await update).toEqual({
      teamId: 't1',
      kind: 'hint',
      hintId: lobbyH1.id,
      source: 'request',
    });
    const s = await state;
    expect(s.view?.hints).toEqual([{ id: lobbyH1.id, text: lobbyH1.text }]);
    expect(s.team?.hintPenaltyS).toBe(lobbyH1.penaltyS);
    expect(s.nextHint?.id).toBe(vaultHeist.stages[0].hints[1].id);
    expect(await announce).toMatchObject({ kind: 'hint', teamId: 't1', stageIndex: 0 });
    expect(receivedLeaks(seen.flat(), ctx.vault)).toEqual([]);
    expect(screenLeaksIn(seen.at(-1)!, ctx.vault)).toEqual([]);
  });

  it('the same hint asked from two phones at once is released once; a stale id gives no-hint', async () => {
    const { pin, teams } = await runningRoom(ctx, { players: 2, teams: 1 });
    const [a, b] = teams.t1;
    const acks = await Promise.all([ask(a, pin, lobbyH1.id), ask(b, pin, lobbyH1.id)]);
    expect(acks).toEqual(expect.arrayContaining([{ ok: true }, { ok: false, reason: 'no-hint' }]));
    expect(leaksIn(acks, ctx.vault)).toEqual([]);
    expect(a.last().view?.hints).toHaveLength(1);
    expect(a.last().team?.hintPenaltyS).toBe(lobbyH1.penaltyS);
    expect(await ask(a, pin, lobbyH1.id)).toEqual({ ok: false, reason: 'no-hint' });
    expect(await ask(a, pin, 'nope')).toEqual({ ok: false, reason: 'no-hint' });
  });

  it('H2: the host releases the next hint to every team, paid', async () => {
    const { pin, teams, host, screen } = await runningRoom(ctx, { players: 2, teams: 2 });
    const screenSeen = record(screen);
    const updates = [hintUpdate(teams.t1[0]), hintUpdate(teams.t2[0])];
    expect(await host.emitWithAck('escape:hint', { pin })).toEqual({ ok: true, released: 2 });
    for (const u of await Promise.all(updates)) {
      expect(u).toMatchObject({ kind: 'hint', hintId: lobbyH1.id, source: 'host' });
    }
    await eventually(async () =>
      expect(teams.t1[0].last().team?.hintPenaltyS).toBe(lobbyH1.penaltyS),
    );
    // One team: its next hint.
    const one = hintUpdate(teams.t2[0]);
    expect(await host.emitWithAck('escape:hint', { pin, teamId: 't2' })).toEqual({
      ok: true,
      released: 1,
    });
    expect(await one).toMatchObject({ hintId: vaultHeist.stages[0].hints[1].id });
    expect(await host.emitWithAck('escape:hint', { pin, teamId: 'zz' })).toMatchObject({
      ok: false,
      error: { code: 'escape.team_not_found' },
    }); // M6: the hints the host released never reach the screen.
    await settle(100);
    expect(screenSeen.some(([e]) => e === 'escape:announce')).toBe(true);
    expect(screenLeaksIn(screenSeen, ctx.vault)).toEqual([]);
  });

  it('H2: a confirmed hint for an unknown team is refused as not found, never as time up', async () => {
    const { pin, host } = await runningRoom(ctx, { players: 2, teams: 2 });
    expect(
      await host.emitWithAck('escape:hint', { pin, teamId: 'zz', hintId: lobbyH1.id }),
    ).toMatchObject({ ok: false, error: { code: 'escape.team_not_found' } });
    // A team of the run whose record is gone: not found too.
    const id = (await ctx.h.app.get(GameService).getMeta(pin))!.id;
    await ctx.h.app.get(RedisService).hdel(escapeKeys.teams(id), 't2');
    expect(
      await host.emitWithAck('escape:hint', { pin, teamId: 't2', hintId: lobbyH1.id }),
    ).toMatchObject({ ok: false, error: { code: 'escape.team_not_found' } });
  });

  it('H2: the host names the hint it confirmed; another next hint is refused, unpaid', async () => {
    const { pin, teams, host } = await runningRoom(ctx, { players: 2, teams: 1 });
    const [a] = teams.t1;
    const lobbyH2 = vaultHeist.stages[0].hints[1];
    // The team asks first: the host's confirm still showed the first hint.
    expect(await ask(a, pin, lobbyH1.id)).toEqual({ ok: true });
    expect(
      await host.emitWithAck('escape:hint', { pin, teamId: 't1', hintId: lobbyH1.id }),
    ).toMatchObject({ ok: false, error: { code: 'escape.hint-changed' } });
    await eventually(async () => expect(a.last().view?.hints).toHaveLength(1));
    expect(a.last().team?.hintPenaltyS).toBe(lobbyH1.penaltyS);
    // The hint it now shows: released, paid.
    const update = hintUpdate(a);
    expect(
      await host.emitWithAck('escape:hint', { pin, teamId: 't1', hintId: lobbyH2.id }),
    ).toEqual({ ok: true, released: 1 });
    expect(await update).toMatchObject({ hintId: lobbyH2.id, source: 'host' });
    // No hint left on the stage: the confirmed one is refused, never `released: 0`.
    expect(
      await host.emitWithAck('escape:hint', { pin, teamId: 't1', hintId: lobbyH2.id }),
    ).toMatchObject({ ok: false, error: { code: 'escape.hint-changed' } });
  });

  it('H3: a timed hint is released by the ticker, free, without any request', async () => {
    const timed = await seedTemplate(ctx.h, {
      ...vaultHeist,
      title: 'Timed heist',
      stages: vaultHeist.stages.map((st, i) =>
        i === 0
          ? { ...st, hints: st.hints.map((h, j) => (j === 0 ? { ...h, releaseAfterS: 0 } : h)) }
          : st,
      ),
    });
    const seen: [string, unknown][][] = [];
    const updates: Promise<EscapeTeamUpdate>[] = [];
    const { players } = await runningRoom(ctx, {
      players: 2,
      teams: 1,
      templateId: timed,
      beforeStart: async (_pin, room) => {
        seen.push(...room.players.map((p) => record(p.socket)));
        updates.push(hintUpdate(room.players[0]));
      },
    });
    expect(await updates[0]).toEqual({
      teamId: 't1',
      kind: 'hint',
      hintId: lobbyH1.id,
      source: 'timer',
    });
    await eventually(async () => expect(players[0].last().view?.hints).toHaveLength(1));
    expect(players[0].last().team?.hintPenaltyS).toBe(0);
    expect(receivedLeaks(seen.flat(), { ...ctx.vault, id: timed })).toEqual([]);
  });

  it('K2: no progress for stuckMs flags the team for the host; progress clears it', async () => {
    let stuck!: Promise<EscapeHostTeam>;
    const { pin, teams, host } = await runningRoom(ctx, {
      players: 1,
      teams: 1,
      beforeStart: async (_pin, room) => {
        stuck = nextHostTeam(room.host, (t) => t.stuck);
      },
    });
    expect((await stuck).id).toBe('t1');
    const unstuck = nextHostTeam(host, (t) => !t.stuck);
    expect(await submitAs(teams.t1[0], pin, 'lobby-door', '0417')).toMatchObject({ ok: true });
    expect(await unstuck).toMatchObject({ id: 't1', stuck: false, solved: ['lobby-door'] });
  });

  it('T3/T4: a team past its deadline times out; when every team is done the finale starts', async () => {
    const { pin, teams, host, screen } = await runningRoom(ctx, { players: 2, teams: 2 });
    const timeUps = [
      nextEvent<EscapeTeamUpdate>(teams.t1[0].socket, 'escape:team-update', {
        where: (u) => u.kind === 'time-up',
      }),
    ];
    const announce = nextEvent<EscapeAnnounce>(screen, 'escape:announce', {
      where: (a) => a.kind === 'time-up',
    });
    // t1's deadline behind it (the limit is 40 min).
    expect(
      await host.emitWithAck('escape:adjust-time', { pin, deltaS: -3600, teamId: 't1' }),
    ).toEqual({ ok: true });
    const [a] = teams.t1;
    const [b] = teams.t2;
    expect(await timeUps[0]).toEqual({ teamId: 't1', kind: 'time-up' });
    expect(await announce).toMatchObject({ teamId: 't1' });
    expect(await submitAs(a, pin, 'lobby-door', '0417')).toEqual({ ok: false, reason: 'time-up' });
    expect(await ask(a, pin, lobbyH1.id)).toEqual({ ok: false, reason: 'time-up' });
    expect(await host.emitWithAck('escape:hint', { pin, teamId: 't1' })).toEqual({
      ok: true,
      released: 0,
    });
    // The hint the host confirmed before the time ran out: refused with why, not `released: 0`.
    expect(
      await host.emitWithAck('escape:hint', { pin, teamId: 't1', hintId: lobbyH1.id }),
    ).toMatchObject({ ok: false, error: { code: 'escape.time-up' } });
    await eventually(async () =>
      expect(a.last().team).toMatchObject({ timedOut: true, deadlineAt: null }),
    );
    // t2 still plays until its own deadline; then the finale starts on its own.
    expect(await submitAs(b, pin, 'lobby-door', '0417')).toMatchObject({ ok: true });
    await host.emitWithAck('escape:adjust-time', { pin, deltaS: -3600, teamId: 't2' });
    const finished = await stateWhere(b.socket, (s: EscapePlayerState) => s.phase === 'finale');
    expect(finished.team?.timedOut).toBe(true);
    expect(await submitAs(b, pin, 'lobby-badge', ['blue'])).toEqual({
      ok: false,
      reason: 'not-running',
    });
    expect(await host.emitWithAck('escape:hint', { pin })).toMatchObject({
      ok: false,
      error: { code: 'escape.wrong_phase' },
    });
  });
}
