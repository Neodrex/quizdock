import type {
  EscapeAnnounce,
  EscapeBoard,
  EscapeHostTeam,
  EscapeTeamUpdate,
} from '@quiz-dock/contracts';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  createEscape,
  eventually,
  joinAndSync,
  record,
  runningRoom,
  stateWhere,
  submitAs,
} from './escape-harness';
import { receivedLeaks } from './leaks';

/** Submissions: outcomes, events, the wrong-answer limit and concurrent submits (Task 3.10). */
export function playTests(ctx: EscapeContext): void {
  const teamUpdate = (p: SyncedPlayer, where: (u: EscapeTeamUpdate) => boolean) =>
    nextEvent<EscapeTeamUpdate>(p.socket, 'escape:team-update', { where });

  /** Clears Vault Heist's first stage for the team of `p`. */
  async function clearLobby(p: SyncedPlayer, pin: string): Promise<void> {
    expect(await submitAs(p, pin, 'lobby-door', '0417')).toEqual({
      ok: true,
      outcome: 'lock-solved',
    });
    expect(await submitAs(p, pin, 'lobby-badge', ['blue'])).toEqual({
      ok: true,
      outcome: 'stage-cleared',
    });
  }

  it('a right code solves the lock: the team gets the update and a new state, the other team nothing', async () => {
    const { pin, teams, players, screen } = await runningRoom(ctx, { players: 4, teams: 2 });
    const seen = [...players.map((p) => record(p.socket)), record(screen)];
    const [a, a2] = teams.t1;
    const [b] = teams.t2;
    const update = teamUpdate(a2, (u) => u.kind === 'lock-solved');
    const state = stateWhere(
      a2.socket,
      (s) => !!s.view?.locks.find((l) => l.id === 'lobby-door')?.solved,
    );
    expect(await submitAs(a, pin, 'lobby-door', '0417')).toEqual({
      ok: true,
      outcome: 'lock-solved',
    });
    expect(await update).toEqual({
      teamId: 't1',
      kind: 'lock-solved',
      lockId: 'lobby-door',
      by: a.playerId,
    });
    expect((await state).view?.stageIndex).toBe(0);
    await settle(100);
    const bSeen = seen[players.indexOf(b)];
    expect(bSeen.filter(([e]) => e === 'escape:team-update')).toEqual([]);
    expect(receivedLeaks(seen.flat(), ctx.vault)).toEqual([]);
  });

  it('finishing the stage: stage-cleared with its unlock text, an announce, and the board moves one team only', async () => {
    const { pin, teams, players, screen, host } = await runningRoom(ctx, {
      players: 4,
      teams: 2,
    });
    const seen = [...players.map((p) => record(p.socket)), record(screen)];
    const [a, a2] = teams.t1;
    const cleared = teamUpdate(a2, (u) => u.kind === 'stage-cleared');
    const announce = nextEvent<EscapeAnnounce>(screen, 'escape:announce');
    const board = nextEvent<EscapeBoard>(screen, 'escape:board', {
      where: (b) => b.teams[0].stageIndex === 1,
    });
    const hostTeam = nextEvent<EscapeHostTeam>(host, 'escape:host-team', {
      where: (t) => t.stageIndex === 1,
    });
    const next = stateWhere(a2.socket, (s) => s.view?.stageIndex === 1);
    await clearLobby(a, pin);
    expect(await cleared).toEqual({
      teamId: 't1',
      kind: 'stage-cleared',
      stageIndex: 0,
      unlockText: ctx.vault.stages[0].unlockText,
      by: a.playerId,
    });
    expect(await announce).toEqual({
      kind: 'stage-cleared',
      teamId: 't1',
      teamName: 'Team 1',
      stageIndex: 0,
    });
    const b = await board;
    expect(b.teams[0]).toMatchObject({ id: 't1', stageIndex: 1, locksSolved: 0 });
    expect(b.teams[1]).toMatchObject({ id: 't2', stageIndex: 0, locksSolved: 0 });
    expect((await hostTeam).stageClearedAt).toHaveLength(1);
    expect((await next).view?.title).toBe(ctx.vault.stages[1].title);
    expect(receivedLeaks(seen.flat(), ctx.vault)).toEqual([]);
  });

  it('after wrongMax wrong answers the team waits: a right answer is not checked until the window ends', async () => {
    const { pin, teams, players } = await runningRoom(ctx, { players: 2, teams: 1 });
    const seen = players.map((p) => record(p.socket));
    const [a, a2] = teams.t1;
    const wrong = teamUpdate(a2, (u) => u.kind === 'wrong');
    for (let i = 0; i < 3; i++) {
      expect(await submitAs(i % 2 ? a2 : a, pin, 'lobby-door', '9999')).toEqual({
        ok: true,
        outcome: 'wrong',
      });
    }
    expect(await wrong).toEqual({ teamId: 't1', kind: 'wrong', by: a.playerId });
    const blocked = await submitAs(a, pin, 'lobby-door', '0417');
    expect(blocked).toMatchObject({ ok: false, reason: 'rate-limited' });
    const retry = (blocked as { retryAfterMs: number }).retryAfterMs;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(1_000);
    // The whole team waits, and the lock stayed shut.
    expect(await submitAs(a2, pin, 'lobby-door', '0417')).toMatchObject({
      reason: 'rate-limited',
    });
    expect(a.last().view?.locks[0].solved).toBe(false);
    await eventually(async () =>
      expect(await submitAs(a, pin, 'lobby-door', '0417')).toEqual({
        ok: true,
        outcome: 'lock-solved',
      }),
    );
    expect(receivedLeaks(seen.flat(), ctx.vault)).toEqual([]);
  });

  it('two teammates submit the same lock at once: one solves it, the other gets already-solved', async () => {
    const { pin, teams, host } = await runningRoom(ctx, { players: 2, teams: 1 });
    const [a, b] = teams.t1;
    const hostTeam = nextEvent<EscapeHostTeam>(host, 'escape:host-team', {
      where: (t) => t.solved.includes('lobby-door'),
    });
    const acks = await Promise.all([
      submitAs(a, pin, 'lobby-door', '0417'),
      submitAs(b, pin, 'lobby-door', '0417'),
    ]);
    expect(acks).toEqual(
      expect.arrayContaining([
        { ok: true, outcome: 'lock-solved' },
        { ok: false, reason: 'already-solved' },
      ]),
    );
    const t = await hostTeam;
    expect(Object.values(t.solvesBy).reduce((n, v) => n + v, 0)).toBe(1);
  });

  it("the stage's two last locks at once: one lock-solved, one stage-cleared, one clear time", async () => {
    const { pin, teams, host } = await runningRoom(ctx, { players: 2, teams: 1 });
    const [a, b] = teams.t1;
    const hostTeam = nextEvent<EscapeHostTeam>(host, 'escape:host-team', {
      where: (t) => t.stageIndex === 1,
    });
    const acks = await Promise.all([
      submitAs(a, pin, 'lobby-door', '0417'),
      submitAs(b, pin, 'lobby-badge', ['blue']),
    ]);
    expect(acks.map((x) => (x as { outcome: string }).outcome).sort()).toEqual([
      'lock-solved',
      'stage-cleared',
    ]);
    expect((await hostTeam).stageClearedAt).toHaveLength(1);
  });

  it('a combined part from a role the player does not hold gives not-your-part; its own is accepted', async () => {
    const { pin, teams, players } = await runningRoom(ctx, { players: 3, teams: 1 });
    const seen = players.map((p) => record(p.socket));
    const [a, b] = teams.t1;
    await clearLobby(a, pin);
    // Its state goes out on the same socket before the ack.
    expect(a.last().view?.stageIndex).toBe(1);
    const mine = a.last().view!.roles[0];
    const other = ctx.vault.roles.map((r) => r.id).find((r) => r !== mine)!;
    expect(await submitAs(a, pin, 'security-switch', 'falcon', other)).toEqual({
      ok: false,
      reason: 'not-your-part',
    });
    const answer = { hacker: 'falcon', safecracker: 'copper', lookout: 'midnight' }[mine]!;
    const part = teamUpdate(b, (u) => u.kind === 'part-accepted');
    expect(await submitAs(a, pin, 'security-switch', answer, mine)).toEqual({
      ok: true,
      outcome: 'part-accepted',
    });
    expect(await part).toEqual({
      teamId: 't1',
      kind: 'part-accepted',
      lockId: 'security-switch',
      roleId: mine,
      by: a.playerId,
    });
    expect(receivedLeaks(seen.flat(), ctx.vault)).toEqual([]);
  });

  it('refuses an unjoined socket, a run not started and a player without a team', async () => {
    const host = ctx.h.connectHost();
    const pin = await createEscape(host, ctx.templateId);
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const stranger = ctx.h.connect();
    expect(
      await stranger.emitWithAck('escape:submit', { pin, lockId: 'lobby-door', input: '0417' }),
    ).toEqual({ ok: false, reason: 'not-joined' });
    const a = await joinAndSync(ctx.h, pin, 'Ann');
    expect(await submitAs(a, pin, 'lobby-door', '0417')).toEqual({
      ok: false,
      reason: 'not-running',
    });
    // Self formation: a player who joins after the start chooses a team first (F5).
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'self', count: 1 })).toEqual({
      ok: true,
    });
    expect(await a.socket.emitWithAck('escape:choose-team', { pin, teamId: 't1' })).toEqual({
      ok: true,
    });
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    const c = await joinAndSync(ctx.h, pin, 'Cy');
    expect(c.last().team).toBeNull();
    expect(await submitAs(c, pin, 'lobby-door', '0417')).toEqual({ ok: false, reason: 'no-team' });
    expect(await submitAs(a, pin, 'lobby-door', 12 as never)).toMatchObject({
      ok: false,
      error: { code: 'validation' },
    });
  });
}
