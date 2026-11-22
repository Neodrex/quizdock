import {
  type EscapeAnnounce,
  type EscapeFinale,
  type EscapeHostState,
  type EscapePlayerState,
  type EscapeScreenFinale,
  type EscapeTeamUpdate,
  GameState,
} from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { awards, rankTeams } from '../../src/escape/escape-rules';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { EscapeStore } from '../../src/escape/escape.store';
import type { EscapeTemplate } from '../../src/escape/escape.types';
import { vaultHeist } from '../../src/escape/samples';
import { GameService } from '../../src/game/game.service';
import { nextEvent } from '../game-harness';
import {
  type EscapeContext,
  type RunningRoom,
  type SyncedPlayer,
  eventually,
  firstStateWhere,
  record,
  runningRoom,
  seedTemplate,
  stateWhere,
  submitAs,
} from './escape-harness';
import { hostLeaks, receivedLeaks, stringsIn } from './leaks';

/**
 * Task 3.16: one two-team, roles-mode Vault Heist run through sockets only,
 * from create to finale. The `it`s share one run and follow each other: a
 * failure cascades into the ones after it, so read the first failure.
 *
 * The template is Vault Heist with its first hint timed at 0 s, so the run
 * has a free (timed) hint as well as paid ones (asked, and from the host).
 */
export function vaultHeistRunTests(ctx: EscapeContext): void {
  let tpl: EscapeTemplate;
  let room: RunningRoom;
  let pin: string;
  let host: Socket;
  let A: SyncedPlayer[];
  let B: SyncedPlayer[];
  /** What each phone and the screen got, with whose it is (null: the screen). */
  const recordings: { who: string | null; socket: Socket; seen: [string, unknown][] }[] = [];
  const hostSeen: [string, unknown][] = [];

  const update = (p: SyncedPlayer, where: (u: EscapeTeamUpdate) => boolean) =>
    nextEvent<EscapeTeamUpdate>(p.socket, 'escape:team-update', { where });
  const roleOf = (s: EscapePlayerState, playerId: string) =>
    s.team!.members.find((m) => m.playerId === playerId)!.roles;
  /** Who of `team` holds `roleId` now. */
  const holder = (team: SyncedPlayer[], roleId: string) =>
    team.find((p) => p.socket.connected && roleOf(p.last(), p.playerId).includes(roleId))!;
  const hintText = (id: string) =>
    tpl.stages.flatMap((s) => s.hints).find((h) => h.id === id)!.text;
  /** No phone or screen has seen these hints' texts so far. */
  const unseen = (...ids: string[]) => {
    for (const { seen } of recordings) {
      const strings = new Set(stringsIn(seen.map(([, p]) => p)));
      for (const id of ids) expect(strings.has(hintText(id))).toBe(false);
    }
  };
  async function hostState(): Promise<EscapeHostState> {
    const next = nextEvent<EscapeHostState>(host, 'escape:host');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    return next;
  }

  it('1. create, auto teams of 3 and 3, start: three distinct roles per team; a free timed hint each', async () => {
    const content = {
      ...vaultHeist,
      title: 'Vault Heist (timed)',
      stages: vaultHeist.stages.map((st, i) =>
        i === 0
          ? { ...st, hints: st.hints.map((h, j) => (j === 0 ? { ...h, releaseAfterS: 0 } : h)) }
          : st,
      ),
    };
    const templateId = await seedTemplate(ctx.h, content);
    tpl = { ...content, id: templateId };
    const timed: Promise<EscapeTeamUpdate>[] = [];
    room = await runningRoom(ctx, {
      players: 6,
      teams: 2,
      templateId,
      beforeStart: async (_pin, r) => {
        for (const p of r.players)
          recordings.push({ who: p.playerId, socket: p.socket, seen: record(p.socket) });
        recordings.push({ who: null, socket: r.screen, seen: record(r.screen) });
        r.host.onAny((e: string, p: unknown) => hostSeen.push([e, p]));
        unseen('lobby-h1');
        timed.push(...r.players.map((p) => update(p, (u) => u.kind === 'hint')));
      },
    });
    ({ pin, host } = room);
    A = room.teams.t1;
    B = room.teams.t2;
    expect(A).toHaveLength(3);
    expect(B).toHaveLength(3);
    for (const team of [A, B]) {
      const roles = team.map((p) => roleOf(p.last(), p.playerId));
      expect(roles.every((r) => r.length === 1)).toBe(true);
      expect(new Set(roles.flat()).size).toBe(3);
    }
    for (const u of await Promise.all(timed)) {
      expect(u).toMatchObject({ kind: 'hint', hintId: 'lobby-h1', source: 'timer' });
    }
    await eventually(async () => {
      for (const p of [...A, ...B])
        expect(p.last().view!.hints.map((h) => h.id)).toEqual(['lobby-h1']);
    });
    expect(A[0].last().team!.hintPenaltyS).toBe(0);
  });

  it('2. team A clears The Lobby', async () => {
    const cleared = update(A[1], (u) => u.kind === 'stage-cleared');
    expect(await submitAs(A[0], pin, 'lobby-door', '0417')).toEqual({
      ok: true,
      outcome: 'lock-solved',
    });
    expect(await submitAs(A[2], pin, 'lobby-badge', ['blue'])).toEqual({
      ok: true,
      outcome: 'stage-cleared',
    });
    expect(await cleared).toMatchObject({ teamId: 't1', stageIndex: 0 });
  });

  it('3. team B: three wrong codes, then a right one is rate-limited; after the window it opens', async () => {
    for (const code of ['1111', '2222', '3333']) {
      expect(await submitAs(B[0], pin, 'lobby-door', code)).toEqual({ ok: true, outcome: 'wrong' });
    }
    const limited = await submitAs(B[1], pin, 'lobby-door', '0417');
    expect(limited).toMatchObject({ ok: false, reason: 'rate-limited' });
    expect(limited.ok === false && limited.retryAfterMs).toBeGreaterThan(0);
    await eventually(async () =>
      expect(await submitAs(B[1], pin, 'lobby-door', '0417')).toEqual({
        ok: true,
        outcome: 'lock-solved',
      }),
    );
  });

  it('4. the host unlocks lobby-badge for B: stage 1, credited to nobody', async () => {
    const at1 = stateWhere(B[0].socket, (s) => s.view?.stageIndex === 1);
    expect(
      await host.emitWithAck('escape:unlock', { pin, teamId: 't2', lockId: 'lobby-badge' }),
    ).toEqual({ ok: true });
    await at1;
    const b = (await hostState()).teams.find((t) => t.id === 't2')!;
    expect(b).toMatchObject({ stageIndex: 1, hostUnlocks: ['lobby-badge'] });
    expect(b.solvesBy['lobby-badge']).toBeUndefined();
  });

  it('5. pause (frozen clocks, submits refused), resume; +120 s for B, then -60 s for all', async () => {
    const paused = [...A, ...B].map((p) => stateWhere(p.socket, (s) => s.clock.paused));
    expect(await host.emitWithAck('escape:pause', { pin, paused: true })).toEqual({ ok: true });
    for (const s of await Promise.all(paused)) expect(s.team!.deadlineAt).toBeNull();
    expect(await submitAs(A[0], pin, 'security-override', 'lights out')).toEqual({
      ok: false,
      reason: 'paused',
    });
    const resumed = [...A, ...B].map((p) =>
      stateWhere(p.socket, (s) => !s.clock.paused && s.team!.deadlineAt !== null),
    );
    expect(await host.emitWithAck('escape:pause', { pin, paused: false })).toEqual({ ok: true });
    await Promise.all(resumed);

    const bTime = update(B[0], (u) => u.kind === 'time');
    expect(
      await host.emitWithAck('escape:adjust-time', { pin, deltaS: 120, teamId: 't2' }),
    ).toEqual({ ok: true });
    expect(await bTime).toEqual({ teamId: 't2', kind: 'time', deltaMs: 120_000 });
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: -60 })).toEqual({
      ok: true,
    });
    const adjust = Object.fromEntries((await hostState()).teams.map((t) => [t.id, t.adjustMs]));
    expect(adjust).toEqual({ t1: -60_000, t2: 60_000 });
  });

  let lookout: SyncedPlayer;

  it("6. A's lookout drops; a teammate takes the role and enters its part; A clears security", async () => {
    lookout = holder(A, 'lookout');
    const rest = A.filter((p) => p !== lookout);
    const handover = update(rest[0], (u) => u.kind === 'roles');
    const taken = firstStateWhere(
      rest.map((p) => p.socket),
      (s, i) => roleOf(s, rest[i].playerId).includes('lookout'),
    );
    lookout.socket.disconnect();
    expect(await handover).toEqual({ teamId: 't1', kind: 'roles' });
    await taken;
    const parts = { lookout: 'midnight', hacker: 'falcon', safecracker: 'copper' };
    const newLookout = holder(rest, 'lookout');
    expect(newLookout.last().view!.clues.map((c) => c.id)).toContain('security-lookout');
    expect(await submitAs(newLookout, pin, 'security-switch', parts.lookout, 'lookout')).toEqual({
      ok: true,
      outcome: 'part-accepted',
    });
    expect(
      await submitAs(holder(rest, 'hacker'), pin, 'security-switch', parts.hacker, 'hacker'),
    ).toEqual({ ok: true, outcome: 'part-accepted' });
    expect(
      await submitAs(
        holder(rest, 'safecracker'),
        pin,
        'security-switch',
        parts.safecracker,
        'safecracker',
      ),
    ).toEqual({ ok: true, outcome: 'lock-solved' });
    expect(await submitAs(rest[0], pin, 'security-override', 'lights out')).toEqual({
      ok: true,
      outcome: 'stage-cleared',
    });
  });

  it('7. the lookout comes back and syncs: a role again, on stage 2', async () => {
    const socket = ctx.h.connect();
    recordings.push({ who: lookout.playerId, socket, seen: record(socket) });
    const states: EscapePlayerState[] = [];
    socket.on('escape:state', (s: EscapePlayerState) => states.push(s));
    expect(
      await socket.emitWithAck('player:reconnect', { sessionToken: lookout.sessionToken }),
    ).toMatchObject({ ok: true });
    const state = stateWhere(socket, () => true);
    expect(await socket.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const s = await state;
    expect(s.view!.stageIndex).toBe(2);
    expect(roleOf(s, lookout.playerId).length).toBeGreaterThan(0);
    const back: SyncedPlayer = {
      ...lookout,
      socket,
      states,
      last: () => states.at(-1)!,
    };
    A = A.map((p) => (p === lookout ? back : p));
  });

  it('8. B asks a hint (paid); the host releases one hint to every team (paid)', async () => {
    unseen('security-h1', 'security-h2', 'vault-h1');
    const offered = B[0].last().nextHint!;
    expect(offered).toEqual({ id: 'security-h1', penaltyS: 30 });
    expect(await B[0].socket.emitWithAck('escape:ask-hint', { pin, hintId: offered.id })).toEqual({
      ok: true,
    });
    const toA = update(A[0], (u) => u.kind === 'hint');
    const toB = update(B[1], (u) => u.kind === 'hint' && u.source === 'host');
    expect(await host.emitWithAck('escape:hint', { pin })).toEqual({ ok: true, released: 2 });
    expect(await toA).toMatchObject({ teamId: 't1', hintId: 'vault-h1', source: 'host' });
    expect(await toB).toMatchObject({ teamId: 't2', hintId: 'security-h2' });
    const h = Object.fromEntries((await hostState()).teams.map((t) => [t.id, t.hintPenaltyS]));
    expect(h).toEqual({ t1: 30, t2: 90 });
  });

  it('9. A clears The Vault Door and The Getaway: escaped; the screen gets the banner', async () => {
    const escaped = A.map((p) => update(p, (u) => u.kind === 'escaped'));
    const banner = nextEvent<EscapeAnnounce>(room.screen, 'escape:announce', {
      where: (a) => a.kind === 'escaped',
    });
    expect(await submitAs(A[0], pin, 'vault-dials', ['gold', 'silver', 'bronze'])).toEqual({
      ok: true,
      outcome: 'lock-solved',
    });
    expect(await submitAs(A[1], pin, 'vault-keypad', '314')).toEqual({
      ok: true,
      outcome: 'stage-cleared',
    });
    expect(await submitAs(A[2], pin, 'getaway-van', 'open sesame')).toEqual({
      ok: true,
      outcome: 'lock-solved',
    });
    expect(await submitAs(A[0], pin, 'getaway-exits', ['south', 'west'])).toEqual({
      ok: true,
      outcome: 'escaped',
    });
    await Promise.all(escaped);
    expect(await banner).toMatchObject({ teamId: 't1' });
  });

  it('10. B is stuck: the host sees it', async () => {
    await eventually(async () =>
      expect((await hostState()).teams.find((t) => t.id === 't2')!.stuck).toBe(true),
    );
  });

  let finale: EscapeFinale;

  it('11. B escapes, its locks in other orders; the last team out starts the finale', async () => {
    const finales = [...A, ...B].map((p) => nextEvent<EscapeFinale>(p.socket, 'escape:finale'));
    // M6: the screen gets the screen finale, not this one.
    const onScreen = nextEvent<EscapeScreenFinale>(room.screen, 'escape:screen-finale');
    const podium = nextEvent<{ state: string }>(room.screen, 'game:state', {
      where: (s) => s.state === GameState.Podium,
    });
    expect(await submitAs(B[0], pin, 'security-override', 'lights out')).toEqual({
      ok: true,
      outcome: 'lock-solved',
    });
    const parts = { lookout: 'midnight', hacker: 'falcon', safecracker: 'copper' };
    const order = ['safecracker', 'lookout', 'hacker'] as const;
    for (const [i, role] of order.entries()) {
      expect(await submitAs(holder(B, role), pin, 'security-switch', parts[role], role)).toEqual({
        ok: true,
        outcome: i < 2 ? 'part-accepted' : 'stage-cleared',
      });
    }
    expect(await submitAs(B[2], pin, 'vault-keypad', '314')).toEqual({
      ok: true,
      outcome: 'lock-solved',
    });
    expect(await submitAs(B[1], pin, 'vault-dials', ['gold', 'silver', 'bronze'])).toEqual({
      ok: true,
      outcome: 'stage-cleared',
    });
    expect(await submitAs(B[0], pin, 'getaway-exits', ['south', 'west'])).toEqual({
      ok: true,
      outcome: 'lock-solved',
    });
    expect(await submitAs(B[1], pin, 'getaway-van', 'open sesame')).toEqual({
      ok: true,
      outcome: 'escaped',
    });
    const [first, ...rest] = await Promise.all(finales);
    for (const f of rest) expect(f).toEqual(first);
    finale = first;
    expect((await onScreen).ranking.map((r) => r.teamId)).toEqual(
      first.ranking.map((r) => r.teamId),
    );
    await podium;
  });

  it('12. the finale ranks and awards as rankTeams and awards on the stored teams', async () => {
    const id = (await ctx.h.app.get(GameService).getMeta(pin))!.id;
    const stored = await ctx.h.app.get(EscapeStore).teams(id);
    const teams = ['t1', 't2'].map((t) => stored.get(t)!.team);
    expect(finale.ranking.map((r) => [r.teamId, r.place, r.scoreMs])).toEqual(
      rankTeams(teams).map((r) => [r.team.id, r.place, r.scoreMs]),
    );
    const a = awards(teams);
    expect(finale.awards).toEqual({ ...a, photoFinish: a.photoFinish && [...a.photoFinish] });
    expect(finale.awards).toMatchObject({ fastest: 't1', fewestHints: 't1' });
    expect(finale.ranking).toMatchObject([
      {
        teamId: 't1',
        place: 1,
        escaped: true,
        stagesCleared: 4,
        hintsUsed: 2,
        paidHints: 1,
        hintPenaltyS: 30,
        adjustMs: -60_000,
        hostUnlocks: 0,
      },
      {
        teamId: 't2',
        place: 2,
        escaped: true,
        stagesCleared: 4,
        hintsUsed: 3,
        paidHints: 2,
        hintPenaltyS: 90,
        adjustMs: 60_000,
        hostUnlocks: 1,
      },
    ]);
    // Deadline only (owner decision 2): the score is the escape time plus paid hints.
    const [ra, rb] = finale.ranking;
    expect(ra.scoreMs).toBe(teams[0].escapedAt! + 30_000);
    expect(rb.scoreMs).toBe(teams[1].escapedAt! + 90_000);
    expect(await ctx.h.app.get(EscapeStore).results(id)).toEqual(finale);
    expect(ctx.h.app.get(EscapeEngine).inProcess(id, pin).ticking).toBe(false);
  });

  it('13. host:end closes the room', async () => {
    const ended = nextEvent(room.screen, 'game:ended');
    host.emit('host:end', { pin });
    await ended;
  });

  it('14. no phone and no screen got anything it should not', async () => {
    unseen('lobby-h2', 'vault-h2', 'getaway-h1', 'getaway-h2');
    for (const { who, socket, seen } of recordings) {
      expect(receivedLeaks(seen, tpl, who ?? undefined)).toEqual([]);
      const events = new Set(seen.map(([e]) => e));
      for (const e of ['escape:outline', 'escape:host', 'escape:host-team']) {
        expect(events.has(e)).toBe(false);
      }
      // Every socket still in the room saw the finale (the lookout's first one had
      // left): the phones the full one, the screen its own only (M6).
      const phone = who !== null;
      expect(events.has('escape:finale')).toBe(phone && socket.connected);
      expect(events.has('escape:screen-finale')).toBe(!phone && socket.connected);
    }
    // The host console got its outline and every frame of the run, but no answer.
    expect(hostSeen.some(([e]) => e === 'escape:outline')).toBe(true);
    expect(hostLeaks(hostSeen, tpl)).toEqual([]);
  });
}
