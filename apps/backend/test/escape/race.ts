import type { EscapeHostState } from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { lostLibrary } from '../../src/escape/samples';
import { nextEvent } from '../game-harness';
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

/** Every value under a `code` key of `value`, at any depth. */
export function codesIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(codesIn);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      k === 'code' && typeof v === 'string' ? [v] : codesIn(v),
    );
  }
  return [];
}

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

  it('escape:new-team and escape:join-team belong to team races', async () => {
    const { pin } = await raceRoom('solo');
    const p = await joinAndSync(ctx.h, pin, 'Solo');
    const out = refused('escape.not_in_session');
    expect(await p.socket.emitWithAck('escape:new-team', { pin, name: 'X' })).toMatchObject(out);
    expect(await p.socket.emitWithAck('escape:join-team', { pin, code: 'ABCD' })).toMatchObject(
      out,
    );
  });
}
