import { Logger } from '@nestjs/common';
import type { Socket } from 'socket.io-client';
import { EscapeEngine } from '../../src/escape/escape.engine';
import { EscapeStore } from '../../src/escape/escape.store';
import { SiteLicences } from '../../src/escape/licences/site-licences';
import { lostLibrary } from '../../src/escape/samples';
import { gameKeys } from '../../src/game/game.keys';
import { RedisService } from '../../src/redis/redis.service';
import { type EscapeContext, createAs, joinAndSync, seedTemplate } from './escape-harness';
import { type SiteStub, startSiteStub, swapPort } from './site-stub';

const DAY = 86_400_000;

/**
 * M8 Task 8.13: a hosted event under a licence from the Site, through
 * SiteLicences and a real HTTP client, against a stub of the Site's API.
 */
export function siteLicenceTests(ctx: EscapeContext): void {
  let library: string;
  let site: SiteStub;
  let undo: () => void;
  const store = () => ctx.h.app.get(EscapeStore);
  const refused = (code: string) => ({ ok: false, error: expect.objectContaining({ code }) });
  const licence = () => ({
    id: 'site-lic',
    organisationId: 'org-1',
    package: 'bundle',
    participantCap: 12,
    validFrom: null,
    expiresAt: Date.now() + DAY,
    eventsLeft: 3,
    brand: {
      name: 'Acme Ltd',
      logoUrl: 'https://cdn.example.com/acme.png',
      accent: '#c2410c',
      background: null,
      baseTheme: 'classic',
      intro: null,
    },
  });
  const uses = () => site.calls.filter((c) => c.path === '/api/live/licences/use');

  beforeAll(async () => {
    library = await seedTemplate(ctx.h, lostLibrary);
    site = await startSiteStub();
    const port = new SiteLicences(site.client(), new Logger('SiteLicences'));
    undo = swapPort(ctx.h.app.get(EscapeEngine), 'licences', port);
  });

  afterAll(async () => {
    undo?.();
    await site?.close();
  });

  beforeEach(() => {
    site.reset();
    site.answers.set('/api/live/licences/check', () => ({ ok: true, licence: licence() }));
    site.answers.set('/api/live/licences/use', { ok: true });
  });

  /** A hosted room under the Site licence, one player in one team, synced, not started. */
  const readyRoom = async (): Promise<{ host: Socket; pin: string }> => {
    const host = ctx.h.connectHost();
    const { pin, error } = await createAs(host, library, 'hosted', { licenceId: 'site-lic' });
    if (!pin) throw new Error(`create refused: ${error?.code}`);
    expect(await host.emitWithAck('escape:sync', { pin })).toEqual({ ok: true });
    await joinAndSync(ctx.h, pin, 'P0');
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toEqual({
      ok: true,
    });
    return { host, pin };
  };

  it('a hosted event under a Site licence opens with its cap, frozen; the host goes by subject', async () => {
    const host = ctx.h.connectHost();
    const { pin } = await createAs(host, library, 'hosted', { licenceId: 'site-lic' });
    expect(pin).toBeDefined();
    expect(await ctx.h.app.get(RedisService).get(gameKeys.roomCap(pin!))).toBe('12');
    expect((await store().session(pin!))?.licence).toMatchObject({
      id: 'site-lic',
      participantCap: 12,
      brand: { name: 'Acme Ltd' },
    });
    expect(site.calls[0]).toEqual({
      path: '/api/live/licences/check',
      body: {
        host: { subject: 'local:animateur', email: null },
        licenceId: 'site-lic',
      },
    });
  });

  it('the first start records one use on the Site; a second start in the room records none', async () => {
    const { host, pin } = await readyRoom();
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect(uses()).toHaveLength(1);
    expect(uses()[0].body).toMatchObject({
      licenceId: 'site-lic',
      use: { pin, players: 1, useKey: expect.any(String) as unknown },
    });

    expect(await host.emitWithAck('escape:end', { pin })).toEqual({ ok: true });
    expect(await host.emitWithAck('host:back-to-lobby', { pin })).toMatchObject({ ok: true });
    expect(await host.emitWithAck('escape:open', { pin, templateId: library })).toEqual({
      ok: true,
    });
    await joinAndSync(ctx.h, pin, 'P1');
    expect(await host.emitWithAck('escape:teams', { pin, mode: 'auto', count: 1 })).toEqual({
      ok: true,
    });
    expect(await host.emitWithAck('escape:start', { pin })).toEqual({ ok: true });
    expect(uses()).toHaveLength(1);
  });

  it('with the Site down, create and start are refused as unavailable', async () => {
    const { host, pin } = await readyRoom();
    site.down = true;
    expect(await host.emitWithAck('escape:start', { pin })).toMatchObject(
      refused('escape.licence_unavailable'),
    );
    expect((await store().session(pin))?.licenceUsed).toBe(false);

    const other = ctx.h.connectHost();
    expect(await createAs(other, library, 'hosted', { licenceId: 'site-lic' })).toMatchObject(
      refused('escape.licence_unavailable'),
    );
    // Without a licence chosen, the list itself is unavailable.
    expect(await createAs(other, library, 'hosted')).toMatchObject(
      refused('escape.licence_unavailable'),
    );
  });
}
