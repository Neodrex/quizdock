import type {
  EscapeAnnounce,
  EscapeAskHintAck,
  EscapeHostTeam,
  EscapePlayerState,
  EscapeTeamUpdate,
} from '@quiz-dock/contracts';
import { EscapeStore } from '../../src/escape/escape.store';
import { vaultHeist } from '../../src/escape/samples';
import { GameService } from '../../src/game/game.service';
import { nextEvent } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  eventually,
  record,
  runningRoom,
  seedTemplate,
  stateWhere,
  submitAs,
} from './escape-harness';
import { leaksIn, receivedLeaks } from './leaks';

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
    const { pin, teams, host } = await runningRoom(ctx, { players: 2, teams: 2 });
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
    });
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
        stuck = nextEvent<EscapeHostTeam>(room.host, 'escape:host-team', {
          where: (t) => t.stuck,
        });
      },
    });
    expect((await stuck).id).toBe('t1');
    const unstuck = nextEvent<EscapeHostTeam>(host, 'escape:host-team', {
      where: (t) => !t.stuck,
    });
    expect(await submitAs(teams.t1[0], pin, 'lobby-door', '0417')).toMatchObject({ ok: true });
    expect(await unstuck).toMatchObject({ id: 't1', stuck: false, solved: ['lobby-door'] });
  });

  it('T3/T4: a team past its deadline times out; when every team is done the run finishes', async () => {
    const store = ctx.h.app.get(EscapeStore);
    const game = ctx.h.app.get(GameService);
    const timeUps: Promise<EscapeTeamUpdate>[] = [];
    let announce!: Promise<EscapeAnnounce>;
    const { pin, teams, host } = await runningRoom(ctx, {
      players: 2,
      teams: 2,
      beforeStart: async (p, room) => {
        // A short limit, and t1's deadline already behind it (adjust-time comes in 3.12).
        const id = (await game.getMeta(p))!.id;
        const run = (await store.run(id))!;
        await store.saveRun(id, { ...run, clock: { ...run.clock, limitMs: 1_500 } });
        const t1 = (await store.team(id, 't1'))!;
        await store.save(id, { teams: [{ ...t1, team: { ...t1.team, adjustMs: -1_500 } }] });
        timeUps.push(
          nextEvent<EscapeTeamUpdate>(room.players[0].socket, 'escape:team-update', {
            where: (u) => u.kind === 'time-up',
          }),
        );
        announce = nextEvent<EscapeAnnounce>(room.screen, 'escape:announce', {
          where: (a) => a.kind === 'time-up',
        });
      },
    });
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
    await eventually(async () =>
      expect(a.last().team).toMatchObject({ timedOut: true, deadlineAt: null }),
    );
    // t2 still plays until its own deadline, then the run finishes on its own.
    expect(await submitAs(b, pin, 'lobby-door', '0417')).toMatchObject({ ok: true });
    const finished = await stateWhere(b.socket, (s: EscapePlayerState) => s.phase === 'finished');
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
