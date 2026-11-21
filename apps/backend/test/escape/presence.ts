import type { EscapePlayerState, EscapeTeamUpdate } from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { nextEvent, settle } from '../game-harness';
import {
  type EscapeContext,
  type SyncedPlayer,
  record,
  runningRoom,
  stateWhere,
  submitAs,
} from './escape-harness';
import { receivedLeaks } from './leaks';

/** Disconnects, reconnects and roles (Task 3.14). */
export function presenceTests(ctx: EscapeContext): void {
  /** Vault Heist's combined lock of stage 2: each role's part. */
  const PARTS: Record<string, string> = {
    hacker: 'falcon',
    safecracker: 'copper',
    lookout: 'midnight',
  };

  const rolesUpdate = (socket: Socket) =>
    nextEvent<EscapeTeamUpdate>(socket, 'escape:team-update', { where: (u) => u.kind === 'roles' });

  const rolesOf = (s: EscapePlayerState, playerId: string) =>
    s.team!.members.find((m) => m.playerId === playerId)!.roles;

  /** A two-phone team at Vault Heist's second stage (the combined lock, role clues). */
  async function atSecurity() {
    const room = await runningRoom(ctx, { players: 2, teams: 1 });
    const [a, b] = room.teams.t1;
    const there = stateWhere(b.socket, (s) => s.view?.stageIndex === 1);
    await submitAs(a, room.pin, 'lobby-door', '0417');
    await submitAs(a, room.pin, 'lobby-badge', ['blue']);
    await there;
    return { ...room, a, b };
  }

  /** `p` back on a new socket through quizdock's session token, then synced. */
  async function comeBack(p: SyncedPlayer, pin: string) {
    const socket = ctx.h.connect();
    const states: EscapePlayerState[] = [];
    socket.on('escape:state', (s: EscapePlayerState) => states.push(s));
    const seen = record(socket);
    expect(
      await socket.emitWithAck('player:reconnect', { sessionToken: p.sessionToken }),
    ).toMatchObject({ ok: true });
    const state = stateWhere(socket, () => true);
    expect(await socket.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    await state;
    return { socket, states, seen };
  }

  it('R2: a role holder drops; after the grace a teammate holds the role, sees its clue and enters its part', async () => {
    const { pin, a, b } = await atSecurity();
    const seen = record(b.socket);
    const aRoles = rolesOf(b.last(), a.playerId);
    const bRoles = rolesOf(b.last(), b.playerId);
    expect(aRoles.length).toBeGreaterThan(0);
    const update = rolesUpdate(b.socket);
    const gained = stateWhere(b.socket, (s) => aRoles.every((r) => s.view!.roles.includes(r)));
    const t0 = Date.now();
    a.socket.disconnect();
    expect(await update).toEqual({ teamId: 't1', kind: 'roles' });
    // Not before the grace (150 ms).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    const s = await gained;
    expect(s.view!.roles.sort()).toEqual([...aRoles, ...bRoles].sort());
    const sw = s.view!.locks.find((l) => l.id === 'security-switch')!;
    expect(sw.myParts!.sort()).toEqual([...aRoles, ...bRoles].sort());
    const clueRoles = s.view!.clues.map((c) => c.roleId);
    for (const r of aRoles) {
      const own = ctx.vault.stages[1].clues.find((c) => c.roleId === r);
      if (own) expect(clueRoles).toContain(r);
    }
    expect(s.team!.members.find((m) => m.playerId === a.playerId)).toMatchObject({
      connected: false,
      roles: [],
    });
    expect(await submitAs(b, pin, 'security-switch', PARTS[aRoles[0]], aRoles[0])).toEqual({
      ok: true,
      outcome: 'part-accepted',
    });
    expect(receivedLeaks(seen, ctx.vault, b.playerId)).toEqual([]);
  });

  it('R3: the player comes back with a role, the current stage and the locks done; roles stay sticky', async () => {
    const { pin, a, b } = await atSecurity();
    const aRoles = rolesOf(b.last(), a.playerId);
    const moved = stateWhere(b.socket, (s) => aRoles.every((r) => s.view!.roles.includes(r)));
    a.socket.disconnect();
    const bAll = (await moved).view!.roles;
    expect(await submitAs(b, pin, 'security-switch', PARTS[bAll[0]], bAll[0])).toMatchObject({
      ok: true,
    });
    const bSeen = record(b.socket);
    const back = await comeBack(a, pin);
    const s = back.states.at(-1)!;
    expect(s.phase).toBe('running');
    expect(s.view!.stageIndex).toBe(1);
    expect(s.view!.roles.length).toBeGreaterThan(0);
    expect(rolesOf(s, a.playerId)).toEqual(s.view!.roles);
    // Sticky: the teammate keeps every role it held.
    expect(rolesOf(s, b.playerId).sort()).toEqual([...bAll].sort());
    expect(s.team!.members.find((m) => m.playerId === a.playerId)!.connected).toBe(true);
    const lock = s.view!.locks.find((l) => l.id === 'security-switch')!;
    expect(lock).toMatchObject({ solved: false });
    expect(lock.partsDone).toEqual([bAll[0]]);
    await settle(100);
    expect(rolesOf(b.last(), b.playerId).sort()).toEqual([...bAll].sort());
    expect(receivedLeaks(back.seen, ctx.vault, a.playerId)).toEqual([]);
    expect(receivedLeaks(bSeen, ctx.vault, b.playerId)).toEqual([]);
  });

  it('a disconnect and a reconnect within the grace change no roles', async () => {
    const { pin, a, b } = await atSecurity();
    const before = b.last().team!.members.map((m) => [m.playerId, m.roles]);
    const seen = record(b.socket);
    a.socket.disconnect();
    await comeBack(a, pin);
    await settle(400);
    expect(
      seen.filter(
        ([e, u]) => e === 'escape:team-update' && (u as EscapeTeamUpdate).kind === 'roles',
      ),
    ).toEqual([]);
    expect(b.last().team!.members.map((m) => [m.playerId, m.roles])).toEqual(before);
  });

  it("a stale socket's disconnect, after the player came back on a new one, changes nothing", async () => {
    const { pin, a, b } = await atSecurity();
    const before = b.last().team!.members.map((m) => [m.playerId, m.roles]);
    await comeBack(a, pin);
    const seen = record(b.socket);
    a.socket.disconnect();
    await settle(400);
    expect(
      seen.filter(
        ([e, u]) => e === 'escape:team-update' && (u as EscapeTeamUpdate).kind === 'roles',
      ),
    ).toEqual([]);
    expect(b.last().team!.members.map((m) => [m.playerId, m.roles, m.connected])).toEqual(
      before.map(([id, roles]) => [id, roles, true]),
    );
  });
}
