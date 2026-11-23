import {
  type EscapeFinale,
  type EscapeHostState,
  type EscapePlayerState,
  GameState,
  toolsOf,
} from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { lostLibrary } from '../../src/escape/samples';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { escapeRooms } from '../../src/escape/escape.keys';
import type { EscapeTemplate } from '../../src/escape/escape.types';
import { GameService } from '../../src/game/game.service';
import { EscapeStore } from '../../src/escape/escape.store';
import { EscapeTimings } from '../../src/escape/escape-timings';
import {
  ACME_LICENCE,
  DEV_LICENCE,
  DEV_LICENCES,
  EXPIRED_LICENCE,
} from '../../src/escape/licences/dev-licences';
import { gameKeys } from '../../src/game/game.keys';
import { RedisService } from '../../src/redis/redis.service';
import {
  LICENCE_PORT,
  type LicenceHost,
  type LicencePort,
} from '../../src/escape/licences/licence.port';
import {
  type EscapeContext,
  createAs,
  createEscape,
  joinAndSync,
  record,
  seedTemplate,
  stateWhere,
  useLicences,
} from './escape-harness';
import { hostLeaks } from './leaks';
import { nextEvent } from '../game-harness';

const MIN = 60_000;

/** The session type chosen on create and kept by the room (M7 Task 7.3). */
export function sessionTests(ctx: EscapeContext): void {
  let library: string;
  const store = () => ctx.h.app.get(EscapeStore);
  const capKey = (pin: string) => ctx.h.app.get(RedisService).get(gameKeys.roomCap(pin));
  const refused = (code: string) => ({ ok: false, error: expect.objectContaining({ code }) });

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
  });

  afterEach(() => useLicences(ctx.h));

  it('group play opens a parallel template with a cap of 6; the creator is its phone host', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    expect(pin).toMatch(/^\d{6}$/);
    expect(await capKey(pin!)).toBe('6');
    expect(await store().session(pin!)).toEqual({
      type: 'group',
      cap: 6,
      race: null,
      licence: null,
      licenceUsed: false,
      phoneHostUserId: ctx.h.hostUserId,
    });
  });

  it('group play refuses a roles template', async () => {
    const host = ctx.h.connectHost();
    expect(await createAs(host, ctx.templateId, 'group')).toMatchObject(
      refused('escape.session_mode'),
    );
  });

  it('a race starts at most 3 h ahead and never in the past', async () => {
    const host = ctx.h.connectHost();
    const startsAt = Date.now() + 120 * MIN;
    const { pin } = await createAs(host, library, 'race', { race: { format: 'solo', startsAt } });
    expect(await capKey(pin!)).toBe('500');
    expect((await store().session(pin!))?.race).toEqual({
      format: 'solo',
      startsAt,
      started: false,
      siteRaceId: null,
      brand: null,
    });
    const out = refused('escape.race_start_out_of_range');
    for (const at of [Date.now() + 240 * MIN, Date.now() - MIN, Date.now() + 10_000]) {
      expect(
        await createAs(host, library, 'race', { race: { format: 'teams', startsAt: at } }),
      ).toMatchObject(out);
    }
    // The dialog's "in 1 minute" (or "in 3 h") reaches the server a little late or early:
    // 5 s of slack on both bounds.
    const min = ctx.h.app.get(EscapeTimings).raceMinLeadMs;
    for (const at of [Date.now() + min - 2000, Date.now() + 180 * MIN + 2000]) {
      const { pin: ok } = await createAs(host, library, 'race', {
        race: { format: 'solo', startsAt: at },
      });
      expect(ok).toMatch(/^\d{6}$/);
    }
    // No start time: the host starts it.
    const hosted = await createAs(host, library, 'race', { race: { format: 'teams' } });
    expect((await store().session(hosted.pin!))?.race).toEqual({
      format: 'teams',
      startsAt: null,
      started: false,
      siteRaceId: null,
      brand: null,
    });
  });

  it('a race refuses a roles template', async () => {
    const host = ctx.h.connectHost();
    expect(
      await createAs(host, ctx.templateId, 'race', { race: { format: 'solo' } }),
    ).toMatchObject(refused('escape.session_mode'));
  });

  it('a hosted event takes its licence: the cap and the licence are frozen', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, ctx.templateId, 'hosted', { licenceId: 'acme' });
    expect(await capKey(pin!)).toBe('8');
    const s = await store().session(pin!);
    expect(s).toMatchObject({ type: 'hosted', cap: 8, licenceUsed: false, phoneHostUserId: null });
    expect(s?.licence).toEqual({
      id: 'acme',
      organisationId: 'acme-org',
      participantCap: 8,
      expiresAt: ACME_LICENCE.expiresAt,
      package: 'bundle',
      brand: ACME_LICENCE.brand,
    });
  });

  it('a hosted event refuses a licence that is expired, not the host’s, or not chosen among several', async () => {
    const theirs = { ...ACME_LICENCE, id: 'theirs', hosts: ['someone-else'] };
    useLicences(ctx.h, [...DEV_LICENCES, theirs]);
    const host = ctx.h.connectHost();
    const create = (licenceId?: string) =>
      createAs(host, ctx.templateId, 'hosted', licenceId ? { licenceId } : {});
    expect(await create(EXPIRED_LICENCE.id)).toMatchObject(refused('escape.licence_expired'));
    expect(await create('theirs')).toMatchObject(refused('escape.licence_not_facilitator'));
    expect(await create('nope')).toMatchObject(refused('escape.licence_not_found'));
    expect(await create()).toMatchObject(refused('escape.licence_required'));
    // A legacy create, too.
    expect(await createAs(host, ctx.templateId)).toMatchObject(refused('escape.licence_required'));
  });

  it('a hosted event with no usable licence is refused', async () => {
    useLicences(ctx.h, [EXPIRED_LICENCE]);
    const host = ctx.h.connectHost();
    expect(await createAs(host, ctx.templateId, 'hosted')).toMatchObject(
      refused('escape.licence_required'),
    );
  });

  it('a legacy create, with only the Dev licence usable, opens hosted with its cap', async () => {
    useLicences(ctx.h, [DEV_LICENCE]);
    const host = ctx.h.connectHost();
    const pin = await createEscape(host, ctx.templateId);
    expect(await capKey(pin)).toBe('500');
    expect(await store().session(pin)).toMatchObject({
      type: 'hosted',
      cap: 500,
      licence: { id: DEV_LICENCE.id },
    });
  });

  it('the licence stays as frozen at create', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, ctx.templateId, 'hosted', { licenceId: 'acme' });
    useLicences(ctx.h, [{ ...ACME_LICENCE, participantCap: 20 }]);
    expect(await capKey(pin!)).toBe('8');
    expect((await store().session(pin!))?.licence?.participantCap).toBe(8);
  });

  it('escape:open keeps the room’s session: a group room still refuses a roles template', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    await joinAndSync(ctx.h, pin!, 'P0');
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toEqual({
      ok: true,
    });
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    const meta = () => ctx.h.app.get(RedisService).hget(gameKeys.room(pin!), 'gameId');
    const before = await meta();
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    expect(
      await host.emitWithAck('escape:open', { pin, templateId: ctx.templateId }),
    ).toMatchObject(refused('escape.session_mode'));
    expect(await host.emitWithAck('escape:open', { pin, templateId: library })).toEqual({
      ok: true,
    });
    expect(await meta()).not.toBe(before);
    expect((await store().session(pin!))?.type).toBe('group');
    expect(await capKey(pin!)).toBe('6');
  });

  it('escape:open from a quiz room makes it hosted, under the licence it names', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const host = ctx.h.connectHost();
    const quiz = await ctx.h.seedQuiz();
    const open = async (licenceId?: string) => {
      const pin = await ctx.h.createGame(host, quiz.id);
      const ack = await host.emitWithAck('escape:open', {
        pin,
        templateId: library,
        ...(licenceId ? { licenceId } : {}),
      });
      return { pin, ack };
    };
    // Two usable: none named is refused, one named is taken.
    expect((await open()).ack).toMatchObject(refused('escape.licence_required'));
    expect((await open(EXPIRED_LICENCE.id)).ack).toMatchObject(refused('escape.licence_expired'));
    const { pin, ack } = await open('acme');
    expect(ack).toEqual({ ok: true });
    expect(await capKey(pin)).toBe('8');
    expect(await store().session(pin)).toMatchObject({
      type: 'hosted',
      cap: 8,
      licence: { id: 'acme' },
    });
  });

  it('escape:open in a room with a session ignores a licence id', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    await joinAndSync(ctx.h, pin!, 'P0');
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toEqual({
      ok: true,
    });
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    expect(
      await host.emitWithAck('escape:open', { pin, templateId: library, licenceId: 'acme' }),
    ).toEqual({ ok: true });
    expect(await store().session(pin!)).toMatchObject({ type: 'group', cap: 6, licence: null });
    expect(await capKey(pin!)).toBe('6');
  });

  // ── Host tools by session type (Task 7.5) ──

  /** The host's synced console of a new room; its first escape:host. */
  const syncedHost = async (host: Socket, pin: string): Promise<{ state: EscapeHostState }> => {
    const first = nextEvent<EscapeHostState>(host, 'escape:host');
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    return { state: await first };
  };

  it('group play refuses a host unlock; its other tools work', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    await syncedHost(host, pin!);
    const p = await joinAndSync(ctx.h, pin!, 'P0');
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toEqual({
      ok: true,
    });
    const running = stateWhere(p.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    const teamId = (await running).team!.id;
    expect(
      await host.emitWithAck('escape:unlock', { pin, teamId, lockId: 'catalogue' }),
    ).toMatchObject(refused('escape.not_in_session'));
    expect(await host.emitWithAck('escape:hint', { pin, teamId })).toMatchObject({ ok: true });
    expect(await host.emitWithAck('escape:hint', { pin })).toMatchObject({ ok: true });
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: 60, teamId })).toEqual({
      ok: true,
    });
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: 60 })).toEqual({
      ok: true,
    });
    expect(await host.emitWithAck('escape:pause', { pin, paused: true })).toEqual({ ok: true });
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
  });

  it.each([
    ['4 teams', { count: 4 }],
    ['teams of 7', { count: 1, maxSize: 7 }],
  ])('group play refuses %s (at most 3 teams of 6)', async (_, over) => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    await syncedHost(host, pin!);
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'self', ...over })).toMatchObject(
      refused('escape.not_in_session'),
    );
    expect(
      await host.emitWithAck('escape:teams', { pin, mode: 'self', count: 3, maxSize: 6 }),
    ).toEqual({ ok: true });
  });

  it('group play moves a player while forming only', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    await syncedHost(host, pin!);
    const p = await joinAndSync(ctx.h, pin!, 'P0');
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'self', count: 2 })).toEqual({
      ok: true,
    });
    expect(
      await host.emitWithAck('escape:move', { pin, playerId: p.playerId, teamId: 't1' }),
    ).toEqual({ ok: true });
    const running = stateWhere(p.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    await running;
    expect(
      await host.emitWithAck('escape:move', { pin, playerId: p.playerId, teamId: 't2' }),
    ).toMatchObject(refused('escape.wrong_phase'));
  });

  it('a race refuses teams, moves, a hint or time for one team; not the same for all', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'race', { race: { format: 'solo' } });
    await syncedHost(host, pin!);
    const p = await joinAndSync(ctx.h, pin!, 'P0');
    const out = refused('escape.not_in_session');
    // The type is checked before the phase: a forming race refuses them too.
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toMatchObject(
      out,
    );
    expect(
      await host.emitWithAck('escape:move', { pin, playerId: p.playerId, teamId: null }),
    ).toMatchObject(out);
    expect(await host.emitWithAck('escape:hint', { pin, teamId: 't1' })).toMatchObject(out);
    expect(
      await host.emitWithAck('escape:adjust-time', { pin, deltaS: 60, teamId: 't1' }),
    ).toMatchObject(out);
    expect(
      await host.emitWithAck('escape:unlock', { pin, teamId: 't1', lockId: 'catalogue' }),
    ).toMatchObject(out);
    // For all: the type allows it, the phase decides.
    const phase = refused('escape.wrong_phase');
    expect(await host.emitWithAck('escape:hint', { pin })).toMatchObject(phase);
    expect(await host.emitWithAck('escape:adjust-time', { pin, deltaS: 60 })).toMatchObject(phase);
  });

  it('escape:host carries the session; a hosted one names its licence and nothing more', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const host = ctx.h.connectHost();
    const group = await createAs(host, library, 'group');
    const { state: g } = await syncedHost(host, group.pin!);
    expect(g.session).toEqual({
      type: 'group',
      cap: 6,
      joined: 0,
      race: null,
      licence: null,
      tools: [...toolsOf('group')],
    });

    const acme = ctx.h.connectHost();
    const { pin } = await createAs(acme, ctx.templateId, 'hosted', { licenceId: 'acme' });
    await syncedHost(acme, pin!);
    const joined = nextEvent<EscapeHostState>(acme, 'escape:host', {
      where: (s) => s.session?.joined === 1,
    });
    await joinAndSync(ctx.h, pin!, 'P0');
    const h = await joined;
    expect(h.session).toEqual({
      type: 'hosted',
      cap: 8,
      joined: 1,
      race: null,
      licence: {
        organisationName: 'Acme',
        expiresAt: ACME_LICENCE.expiresAt,
        package: 'bundle',
      },
      tools: [...toolsOf('hosted')],
    });
    expect(Object.keys(h.session!.licence!)).not.toContain('id');
    const json = JSON.stringify(h);
    for (const secret of ['eventsLeft', 'hosts', 'acme-org', 'organisationId', '"acme"']) {
      expect(json).not.toContain(secret);
    }
  });

  // ── Licence use at the first start (Task 7.11) ──

  const port = () => ctx.h.app.get<LicencePort>(LICENCE_PORT);
  const asHost: LicenceHost = { userId: '', email: null, oidcSubject: '' };
  /** What remains of a licence (0 once used up: the source refuses it then). */
  const eventsLeft = async (id: string) => {
    const res = await port().check({ ...asHost, userId: ctx.h.hostUserId }, id, Date.now());
    if (res.ok) return res.licence.eventsLeft;
    if (res.reason === 'no-events-left') return 0;
    throw new Error(`licence ${id}: ${res.reason}`);
  };
  /** A room of `templateId` with one player in one team, synced, not started. */
  const readyRoom = async (
    type: 'group' | 'hosted',
    opts: { licenceId?: string } = {},
  ): Promise<{ host: Socket; pin: string }> => {
    const host = ctx.h.connectHost();
    const { pin, error } = await createAs(host, library, type, opts);
    if (!pin) throw new Error(`create refused: ${error?.code}`);
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    await joinAndSync(ctx.h, pin, 'P0');
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toEqual({
      ok: true,
    });
    return { host, pin };
  };
  const phaseOf = async (pin: string) => {
    const meta = await ctx.h.app.get(GameService).getMeta(pin);
    return (await store().run(meta!.id))?.phase;
  };

  it('a hosted event uses its licence at the room’s first start, once per room', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const a = await readyRoom('hosted', { licenceId: 'acme' });
    expect(await eventsLeft('acme')).toBe(2);
    expect(await a.host.emitWithAck('escape:start', { pin: a.pin })).toEqual({ ok: true });
    expect(await eventsLeft('acme')).toBe(1);
    expect((await store().session(a.pin))?.licenceUsed).toBe(true);

    // A second run in room A is free.
    expect(await a.host.emitWithAck('escape:end', { pin: a.pin })).toEqual({ ok: true });
    expect(await a.host.emitWithAck('host:back-to-lobby', { pin: a.pin })).toMatchObject({
      ok: true,
    });
    expect(await a.host.emitWithAck('escape:open', { pin: a.pin, templateId: library })).toEqual({
      ok: true,
    });
    await joinAndSync(ctx.h, a.pin, 'P1');
    expect(
      await a.host.emitWithAck('escape:teams', { pin: a.pin, mode: 'auto', count: 1 }),
    ).toEqual({ ok: true });
    expect(await a.host.emitWithAck('escape:start', { pin: a.pin })).toEqual({ ok: true });
    expect(await eventsLeft('acme')).toBe(1);

    // Room B uses the last event; room C cannot open.
    const b = await readyRoom('hosted', { licenceId: 'acme' });
    expect(await b.host.emitWithAck('escape:start', { pin: b.pin })).toEqual({ ok: true });
    expect(await eventsLeft('acme')).toBe(0);
    const c = ctx.h.connectHost();
    expect(await createAs(c, library, 'hosted', { licenceId: 'acme' })).toMatchObject(
      refused('escape.licence_no_events_left'),
    );
  });

  it('a licence expired since the create refuses the start; the room keeps forming', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const { host, pin } = await readyRoom('hosted', { licenceId: 'acme' });
    useLicences(ctx.h, [{ ...ACME_LICENCE, expiresAt: Date.now() - 1 }]);
    expect(await host.emitWithAck('escape:start', { pin })).toMatchObject(
      refused('escape.licence_expired'),
    );
    expect(await phaseOf(pin)).toBe('forming');
    expect((await store().session(pin))?.licenceUsed).toBe(false);
  });

  it('the licence source unavailable at the start: refused, nothing recorded (fail closed)', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const { host, pin } = await readyRoom('hosted', { licenceId: 'acme' });
    const check = jest
      .spyOn(port(), 'check')
      .mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    const recordUse = jest.spyOn(port(), 'recordUse');
    try {
      expect(await host.emitWithAck('escape:start', { pin })).toMatchObject(
        refused('escape.licence_unavailable'),
      );
      expect(recordUse).not.toHaveBeenCalled();
      expect(await phaseOf(pin)).toBe('forming');
      // The use itself unavailable: refused too, and the room still unused.
      recordUse.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
      expect(await host.emitWithAck('escape:start', { pin })).toMatchObject(
        refused('escape.licence_unavailable'),
      );
      expect(await phaseOf(pin)).toBe('forming');
      expect((await store().session(pin))?.licenceUsed).toBe(false);
      expect(await eventsLeft('acme')).toBe(2);
    } finally {
      check.mockRestore();
      recordUse.mockRestore();
    }
  });

  it('a start that fails after the use is recorded keeps it: the last event still starts the room', async () => {
    useLicences(ctx.h, [{ ...ACME_LICENCE, eventsLeft: 1 }]);
    const { host, pin } = await readyRoom('hosted', { licenceId: 'acme' });
    const save = jest.spyOn(store(), 'save').mockRejectedValueOnce(new Error('redis down'));
    try {
      expect(await host.emitWithAck('escape:start', { pin })).toMatchObject({ ok: false });
    } finally {
      save.mockRestore();
    }
    expect(await phaseOf(pin)).toBe('forming');
    expect((await store().session(pin))?.licenceUsed).toBe(true);
    expect(await eventsLeft('acme')).toBe(0);
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect(await phaseOf(pin)).toBe('running');
  });

  it('a hosted room not started yet never starts without a host (fails closed)', async () => {
    useLicences(ctx.h, DEV_LICENCES);
    const { pin } = await readyRoom('hosted', { licenceId: 'acme' });
    const recordUse = jest.spyOn(port(), 'recordUse');
    try {
      const inner = ctx.h.app.get(EscapeEngine) as unknown as {
        startRun(pin: string, host: undefined): Promise<boolean>;
      };
      await expect(inner.startRun(pin, undefined)).rejects.toMatchObject({
        message: 'escape.licence_required',
      });
      expect(recordUse).not.toHaveBeenCalled();
    } finally {
      recordUse.mockRestore();
    }
    expect(await phaseOf(pin)).toBe('forming');
    expect(await eventsLeft('acme')).toBe(2);
  });

  it('group play and races never call the licence port', async () => {
    const check = jest.spyOn(port(), 'check');
    const recordUse = jest.spyOn(port(), 'recordUse');
    try {
      const g = await readyRoom('group');
      expect(await g.host.emitWithAck('escape:start', { pin: g.pin })).toEqual({ ok: true });
      const host = ctx.h.connectHost();
      const { pin } = await createAs(host, library, 'race', { race: { format: 'solo' } });
      expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      await joinAndSync(ctx.h, pin!, 'R0');
      expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
      expect(check).not.toHaveBeenCalled();
      expect(recordUse).not.toHaveBeenCalled();
    } finally {
      check.mockRestore();
      recordUse.mockRestore();
    }
  });
}

/** Group play: the creator's phone hosts and plays (M7 Task 7.6, owner question 1). */
export function phoneHostTests(ctx: EscapeContext): void {
  let library: string;
  let tpl: EscapeTemplate;

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
    tpl = { id: library, ...lostLibrary };
  });

  /** Whether socket `id` is in the server room `room`. */
  const inRoom = async (room: string, id: string | undefined): Promise<boolean> => {
    const engine = ctx.h.app.get(EscapeEngine) as unknown as {
      server: { in(room: string): { fetchSockets(): Promise<{ id: string }[]> } };
    };
    return (await engine.server.in(room).fetchSockets()).some((s) => s.id === id);
  };
  const gameIdOf = async (pin: string) => (await ctx.h.app.get(GameService).getMeta(pin))!.id;

  /**
   * A group room whose creating socket joined it as the player `Hostess`, with
   * another phone; both in one team, the host's sync recorded.
   */
  const groupRoom = async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    const joined = (await host.emitWithAck('player:join', { pin, nickname: 'Hostess' })) as {
      playerId?: string;
      sessionToken?: string;
    };
    expect(joined.playerId).toBeTruthy();
    const seen = record(host);
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const other = await joinAndSync(ctx.h, pin!, 'Friend');
    const grouped = stateWhere(host, (s) => s.team !== null);
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toEqual({
      ok: true,
    });
    const state = await grouped;
    return {
      host,
      pin: pin!,
      playerId: joined.playerId!,
      sessionToken: joined.sessionToken!,
      other,
      seen,
      teamId: state.team!.id,
    };
  };

  it('a group room forms one team of everyone by default: the phone host can start it', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'group');
    expect(await host.emitWithAck('player:join', { pin, nickname: 'Hostess' })).toMatchObject({
      playerId: expect.any(String),
    });
    const mine = stateWhere(host, (s) => s.team !== null);
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    const team = (await mine).team!;
    expect(team).toMatchObject({ name: 'Team 1', members: [expect.anything()] });
    const other = await joinAndSync(ctx.h, pin!, 'Friend');
    expect(other.last().team).toMatchObject({
      id: team.id,
      members: [expect.anything(), expect.anything()],
    });
    const running = stateWhere(other.socket, (s) => s.phase === 'running');
    // No escape:teams: Start works as the phone's host bar sends it.
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect((await running).team?.id).toBe(team.id);
  });

  it('a host that joins its group room as a player gets the host payloads and its phone state', async () => {
    const { host, pin, seen, other, teamId } = await groupRoom();
    const events = seen.map(([e]) => e);
    for (const e of ['escape:outline', 'escape:host', 'escape:board', 'escape:state']) {
      expect(events).toContain(e);
    }
    const id = await gameIdOf(pin);
    expect(await inRoom(escapeRooms.host(pin), host.id)).toBe(true);
    expect(await inRoom(escapeRooms.team(id, teamId), host.id)).toBe(true);
    const mine = seen.filter(([e]) => e === 'escape:state').at(-1)![1] as EscapePlayerState;
    expect(mine.session).toEqual({
      type: 'group',
      raceFormat: null,
      startsAt: null,
      isPhoneHost: true,
    });
    expect(other.last().session?.isPhoneHost).toBe(false);
  });

  it('the phone host starts the run and plays it; its frames hold no answer', async () => {
    const { host, pin, seen } = await groupRoom();
    const running = stateWhere(host, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect((await running).session?.isPhoneHost).toBe(true);
    expect(
      await host.emitWithAck('escape:submit', { pin, lockId: 'catalogue', input: '42' }),
    ).toEqual({ ok: true, outcome: 'lock-solved' });
    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    expect(hostLeaks(seen, tpl)).toEqual([]);
  });

  it('the phone drops: it leaves as a player and as the host; it comes back with both roles', async () => {
    const { host, pin, playerId, sessionToken, other, teamId } = await groupRoom();
    const running = stateWhere(other.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    await running;
    const left = nextEvent<{ playerId: string }>(other.socket, 'player:left', {
      where: (l) => l.playerId === playerId,
    });
    const away = nextEvent<{ state: string }>(other.socket, 'game:state', {
      where: (s) => s.state === GameState.HostDisconnected,
    });
    host.disconnect();
    await left; // the player handling
    await away; // the host handling: its grace ran out
    // The team keeps playing.
    expect(
      await other.socket.emitWithAck('escape:submit', { pin, lockId: 'catalogue', input: '42' }),
    ).toEqual({ ok: true, outcome: 'lock-solved' });

    const back = ctx.h.connectHost();
    const resumed = nextEvent<{ state: string }>(other.socket, 'game:state', {
      where: (s) => s.state === GameState.Escape,
    });
    expect(await back.emitWithAck('host:attach', { pin })).toEqual({ ok: true });
    await resumed;
    expect(await back.emitWithAck('player:reconnect', { sessionToken })).toEqual({ ok: true });
    const hostState = nextEvent<EscapeHostState>(back, 'escape:host');
    const phone = stateWhere(back, (s) => s.phase === 'running');
    expect(await back.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    expect((await hostState).teams.map((t) => t.id)).toEqual([teamId]);
    const mine = await phone;
    expect(mine.session?.isPhoneHost).toBe(true);
    expect(mine.team?.id).toBe(teamId);
    expect(mine.view?.locks.find((l) => l.id === 'catalogue')?.solved).toBe(true);
    const id = await gameIdOf(pin);
    expect(await inRoom(escapeRooms.host(pin), back.id)).toBe(true);
    expect(await inRoom(escapeRooms.team(id, teamId), back.id)).toBe(true);
  });

  /**
   * M8 Task 8.11: under OIDC the reloaded page opens a new socket that the
   * session cookie signs in. The harness's user handshake stands in for the
   * cookie. Unlike the test above (gone past the grace, while running), this
   * one comes back within the grace, still forming, and Start still works.
   */
  it('a phone host back within the grace on a new signed-in socket (OIDC reload) gets both roles back, then starts the run', async () => {
    const { host, pin, playerId, sessionToken, other, teamId } = await groupRoom();
    const left = nextEvent<{ playerId: string }>(other.socket, 'player:left', {
      where: (l) => l.playerId === playerId,
    });
    host.disconnect();
    await left;

    const back = ctx.h.connectHost();
    expect(await back.emitWithAck('host:attach', { pin })).toEqual({ ok: true });
    expect(await back.emitWithAck('player:reconnect', { sessionToken })).toEqual({ ok: true });
    const mine = stateWhere(back, (s) => s.team !== null);
    expect(await back.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    expect(await mine).toMatchObject({ session: { isPhoneHost: true }, team: { id: teamId } });

    const running = stateWhere(other.socket, (s) => s.phase === 'running');
    const phone = stateWhere(back, (s) => s.phase === 'running');
    expect(await back.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect((await running).team?.id).toBe(teamId);
    expect((await phone).session?.isPhoneHost).toBe(true);
  });

  it('in open access (guests only, no account on any player) the signed-in creator is still the phone host, and after a reload', async () => {
    // Two sockets of the host, signed in at their handshake: the first, then the reload.
    const host = ctx.h.connectHost();
    const back = ctx.h.connectHost();
    await Promise.all(
      [host, back].map(
        (s) => new Promise<void>((ok) => (s.connected ? ok() : s.once('connect', () => ok()))),
      ),
    );
    // Open access is for OIDC with guests allowed; the policy is read per event.
    const env = process.env;
    process.env = { ...env, AUTH_MODE: 'oidc', ALLOW_ANONYMOUS_PARTICIPANTS: 'true' };
    try {
      const { pin } = (await host.emitWithAck('escape:create', {
        templateId: library,
        sessionType: 'group',
        participantAccess: 'open',
      })) as { pin: string };
      expect(pin).toMatch(/^\d{6}$/);
      const joined = (await host.emitWithAck('player:join', { pin, nickname: 'Hostess' })) as {
        playerId?: string;
        sessionToken?: string;
      };
      expect(joined.playerId).toBeTruthy();
      const mine = stateWhere(host, (s) => s.team !== null);
      expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      expect((await mine).session?.isPhoneHost).toBe(true);
      // Another guest is not the phone host; the host keeps it on a broadcast state.
      const friend = await joinAndSync(ctx.h, pin, 'Friend');
      expect(friend.states.at(-1)?.session?.isPhoneHost).toBe(false);
      const hostAgain = stateWhere(host, (s) => s.team !== null);
      expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      expect((await hostAgain).session?.isPhoneHost).toBe(true);

      // A reload: the new signed-in socket comes back as the same player.
      host.disconnect();
      expect(
        await back.emitWithAck('player:reconnect', { sessionToken: joined.sessionToken }),
      ).toEqual({ ok: true });
      const after = stateWhere(back, (s) => s.team !== null);
      expect(await back.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
      expect((await after).session?.isPhoneHost).toBe(true);
      expect(await back.emitWithAck('host:attach', { pin })).toEqual({ ok: true });
    } finally {
      process.env = env;
    }
  });

  it('host:attach from a guest socket (a reload under AUTH_MODE=none) is refused (M7 §5 item 12)', async () => {
    const { pin } = await groupRoom();
    const guest = ctx.h.connect();
    const answer: unknown = await guest.emitWithAck('host:attach', { pin });
    expect(answer).toEqual({ ok: false, error: { code: expect.any(String) } });
    expect(await inRoom(escapeRooms.host(pin), guest.id)).toBe(false);
  });

  it('while the phone host is away, the run still times out to a finale', async () => {
    const { host, pin, other } = await groupRoom();
    const running = stateWhere(other.socket, (s) => s.phase === 'running');
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    await running;
    const away = nextEvent<{ state: string }>(other.socket, 'game:state', {
      where: (s) => s.state === GameState.HostDisconnected,
    });
    host.disconnect();
    await away;
    const finale = nextEvent<EscapeFinale>(other.socket, 'escape:finale');
    const store = ctx.h.app.get(EscapeStore);
    const id = await gameIdOf(pin);
    const run = (await store.run(id))!;
    await store.saveRun(id, { ...run, clock: { ...run.clock, limitMs: 1 } });
    expect((await finale).ranking).toHaveLength(1);
  });
}
