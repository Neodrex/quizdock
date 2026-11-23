import { ServiceUnavailableException } from '@nestjs/common';
import type { z } from 'zod';
import type { SiteClient, SiteResult } from '../site/site-client';
import type { LicenceHost } from './licence.port';
import { SiteLicences, USABLE_CACHE_MS } from './site-licences';

const NOW = Date.UTC(2026, 10, 23);
const host: LicenceHost = { userId: 'u1', email: 'ann@example.com', oidcSubject: 'sub-1' };

const brand = {
  name: 'Acme Ltd',
  logoUrl: 'https://cdn.example.com/acme.png',
  accent: '#c2410c',
  background: null,
  baseTheme: 'classic',
  intro: 'Welcome',
};
const licence = {
  id: 'lic-1',
  organisationId: 'org-1',
  package: 'bundle',
  participantCap: 30,
  validFrom: null,
  expiresAt: NOW + 86_400_000,
  eventsLeft: 2,
  brand,
};

type Reply = SiteResult<unknown> | { raw: unknown };

/** A fake Site: each reply is either a raw body (parsed with the caller's schema) or a failure. */
function fakeSite(...replies: Reply[]) {
  const calls: { path: string; body: unknown }[] = [];
  const post = jest.fn((path: string, body: unknown, schema: z.ZodType) => {
    calls.push({ path, body });
    const r = replies.length > 1 ? replies.shift()! : replies[0];
    if ('raw' in r) {
      const parsed = schema.safeParse(r.raw);
      return Promise.resolve<SiteResult<unknown>>(
        parsed.success
          ? { ok: true, value: parsed.data }
          : { ok: false, reason: 'unavailable', cause: 'answer' },
      );
    }
    return Promise.resolve(r as SiteResult<unknown>);
  });
  const log = { warn: jest.fn() };
  const site = { post: post as unknown as SiteClient['post'] };
  return { port: new SiteLicences(site, log), calls, log, post };
}

const down = (cause: 'network' | 'timeout' | 'status' | 'answer' = 'network'): Reply => ({
  ok: false,
  reason: 'unavailable',
  cause,
});

describe('SiteLicences', () => {
  it('usableBy posts the host by subject and gives the licences', async () => {
    const { port, calls } = fakeSite({ raw: [licence] });
    expect(await port.usableBy(host, NOW)).toEqual([licence]);
    expect(calls).toEqual([
      {
        path: '/api/live/licences/usable',
        body: { host: { subject: 'sub-1', email: 'ann@example.com' } },
      },
    ]);
  });

  it('usableBy is cached 10 s per host', async () => {
    const { port, post } = fakeSite({ raw: [licence] });
    await port.usableBy(host, NOW);
    await port.usableBy(host, NOW + USABLE_CACHE_MS - 1);
    expect(post).toHaveBeenCalledTimes(1);
    await port.usableBy({ ...host, oidcSubject: 'sub-2' }, NOW);
    expect(post).toHaveBeenCalledTimes(2);
    await port.usableBy(host, NOW + USABLE_CACHE_MS);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('usableBy with the Site down throws escape.licence_unavailable, and is not cached', async () => {
    const { port, post } = fakeSite(down(), { raw: [] });
    const err = await port.usableBy(host, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as Error).message).toBe('escape.licence_unavailable');
    expect(await port.usableBy(host, NOW)).toEqual([]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('a logo that is not https becomes null, with a warning; the licence stays usable', async () => {
    const { port, log } = fakeSite({
      raw: [{ ...licence, brand: { ...brand, logoUrl: 'http://localhost:54321/acme.png' } }],
    });
    const [got] = await port.usableBy(host, NOW);
    expect(got.brand).toEqual({ ...brand, logoUrl: null });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('brands go through licenceBrandSchema: a licence with an unknown theme is dropped, with a warning', async () => {
    const { port, log } = fakeSite({
      raw: [{ ...licence, id: 'bad', brand: { ...brand, baseTheme: 'neon' } }, licence],
    });
    expect(await port.usableBy(host, NOW)).toEqual([licence]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('#0'));
  });

  it('one bad licence never fails the list; an answer that is not a list is unavailable', async () => {
    const { port, log } = fakeSite({ raw: [{ id: 'x' }, licence, 'nope'] });
    expect(await port.usableBy(host, NOW)).toEqual([licence]);
    expect(log.warn).toHaveBeenCalledTimes(2);
    const notList = fakeSite({ raw: { licences: [licence] } });
    await expect(notList.port.usableBy(host, NOW)).rejects.toThrow('escape.licence_unavailable');
  });

  it('usableBy evicts expired hosts when it keeps a new answer', async () => {
    const { port } = fakeSite({ raw: [licence] });
    const kept = (port as unknown as { usable: Map<string, unknown> }).usable;
    await port.usableBy(host, NOW);
    await port.usableBy({ ...host, oidcSubject: 'sub-2' }, NOW + 1);
    expect(kept.size).toBe(2);
    await port.usableBy({ ...host, oidcSubject: 'sub-3' }, NOW + USABLE_CACHE_MS);
    expect([...kept.keys()]).toEqual(['sub-2', 'sub-3']);
  });

  it('check posts host and licenceId, never cached, and passes refusals on', async () => {
    const { port, calls, post } = fakeSite(
      { raw: { ok: true, licence } },
      { raw: { ok: false, reason: 'not-a-facilitator' } },
    );
    expect(await port.check(host, 'lic-1')).toEqual({ ok: true, licence });
    expect(await port.check(host, 'lic-1')).toEqual({ ok: false, reason: 'not-a-facilitator' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(calls[0]).toEqual({
      path: '/api/live/licences/check',
      body: { host: { subject: 'sub-1', email: 'ann@example.com' }, licenceId: 'lic-1' },
    });
  });

  it.each([down('timeout'), down('status'), { raw: { ok: false, reason: 'later' } }])(
    'check with the Site down or odd is unavailable',
    async (reply) => {
      const { port } = fakeSite(reply);
      expect(await port.check(host, 'lic-1')).toEqual({ ok: false, reason: 'unavailable' });
    },
  );

  const use = { useKey: 'room-1', pin: '123456', gameId: 'g1', startedAt: NOW, players: 12 };

  it('recordUse posts the use and passes the answer on, never cached', async () => {
    const { port, calls } = fakeSite(
      { raw: { ok: true } },
      { raw: { ok: false, reason: 'no-events-left' } },
    );
    expect(await port.recordUse('lic-1', use)).toEqual({ ok: true });
    expect(await port.recordUse('lic-1', use)).toEqual({ ok: false, reason: 'no-events-left' });
    expect(calls).toEqual([
      { path: '/api/live/licences/use', body: { licenceId: 'lic-1', use } },
      { path: '/api/live/licences/use', body: { licenceId: 'lic-1', use } },
    ]);
  });

  it.each(['network', 'timeout'] as const)(
    'recordUse retries once after a %s failure (idempotent by useKey)',
    async (cause) => {
      const { port, post } = fakeSite(down(cause), { raw: { ok: true } });
      expect(await port.recordUse('lic-1', use)).toEqual({ ok: true });
      expect(post).toHaveBeenCalledTimes(2);
    },
  );

  it('recordUse gives up after the retry, and does not retry other failures', async () => {
    const twice = fakeSite(down('network'));
    expect(await twice.port.recordUse('lic-1', use)).toEqual({ ok: false, reason: 'unavailable' });
    expect(twice.post).toHaveBeenCalledTimes(2);
    const once = fakeSite(down('status'));
    expect(await once.port.recordUse('lic-1', use)).toEqual({ ok: false, reason: 'unavailable' });
    expect(once.post).toHaveBeenCalledTimes(1);
  });
});
