import { type EscapeHostState, toolsOf } from '@quiz-dock/contracts';
import type { Socket } from 'socket.io-client';
import { lostLibrary } from '../../src/escape/samples';
import { EscapeStore } from '../../src/escape/escape.store';
import {
  ACME_LICENCE,
  DEV_LICENCE,
  DEV_LICENCES,
  EXPIRED_LICENCE,
} from '../../src/escape/licences/dev-licences';
import { gameKeys } from '../../src/game/game.keys';
import { RedisService } from '../../src/redis/redis.service';
import {
  type EscapeContext,
  createAs,
  createEscape,
  joinAndSync,
  seedTemplate,
  stateWhere,
  useLicences,
} from './escape-harness';
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
    });
    const out = refused('escape.race_start_out_of_range');
    for (const at of [Date.now() + 240 * MIN, Date.now() - MIN, Date.now() + 10_000]) {
      expect(
        await createAs(host, library, 'race', { race: { format: 'teams', startsAt: at } }),
      ).toMatchObject(out);
    }
    // No start time: the host starts it.
    const hosted = await createAs(host, library, 'race', { race: { format: 'teams' } });
    expect((await store().session(hosted.pin!))?.race).toEqual({
      format: 'teams',
      startsAt: null,
      started: false,
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
}
