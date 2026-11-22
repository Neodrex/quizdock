import { DEV_LICENCES } from './dev-licences';
import type { LicenceHost } from './licence.port';
import { StaticLicences, type StaticLicence, parseStaticLicences } from './static-licences';

const NOW = Date.UTC(2026, 10, 22);
const DAY = 86_400_000;

const lic = (over: Partial<StaticLicence> = {}): StaticLicence => ({
  id: 'lic-1',
  organisationId: 'org-1',
  package: 'bundle',
  participantCap: 30,
  validFrom: null,
  expiresAt: NOW + 30 * DAY,
  eventsLeft: 2,
  brand: null,
  hosts: ['*'],
  ...over,
});

const brand = {
  name: 'Acme Ltd',
  logoUrl: 'https://cdn.example.com/acme.png',
  accent: '#c2410c',
  background: null,
  baseTheme: 'classic',
  intro: 'Welcome',
};

const host: LicenceHost = { userId: 'u1', email: 'Ann@Example.com', oidcSubject: 'sub-1' };
const other: LicenceHost = { userId: 'u2', email: 'bob@example.com', oidcSubject: 'sub-2' };

describe('parseStaticLicences (ESCAPE_STATIC_LICENCES)', () => {
  it('an empty value is no licence', () => {
    expect(parseStaticLicences('')).toEqual([]);
    expect(parseStaticLicences('  ')).toEqual([]);
  });

  it('reads a valid array', () => {
    const list = [lic(), lic({ id: 'lic-2', brand: { ...brand } as StaticLicence['brand'] })];
    expect(parseStaticLicences(JSON.stringify(list))).toEqual(list);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseStaticLicences('[{')).toThrow(/ESCAPE_STATIC_LICENCES/);
  });

  it('refuses a schema miss, naming its path', () => {
    const bad = JSON.stringify([lic(), { ...lic(), participantCap: 0 }]);
    expect(() => parseStaticLicences(bad)).toThrow(/1\.participantCap/);
    expect(() => parseStaticLicences(JSON.stringify([{ ...lic(), hosts: undefined }]))).toThrow(
      /0\.hosts/,
    );
    expect(() => parseStaticLicences(JSON.stringify([lic({ participantCap: 2001 })]))).toThrow();
  });

  it('checks the brand: https logo (or localhost), hex colours, a short intro', () => {
    const withBrand = (b: Record<string, unknown>) =>
      JSON.stringify([{ ...lic(), brand: { ...brand, ...b } }]);
    expect(() => parseStaticLicences(withBrand({}))).not.toThrow();
    expect(() => parseStaticLicences(withBrand({ logoUrl: null }))).not.toThrow();
    expect(() =>
      parseStaticLicences(withBrand({ logoUrl: 'http://localhost:5173/escape-dev/acme-logo.png' })),
    ).not.toThrow();
    expect(() => parseStaticLicences(withBrand({ logoUrl: 'http://example.com/a.png' }))).toThrow(
      /brand\.logoUrl/,
    );
    expect(() => parseStaticLicences(withBrand({ logoUrl: 'javascript:alert(1)' }))).toThrow();
    expect(() => parseStaticLicences(withBrand({ accent: 'red' }))).toThrow(/brand\.accent/);
    expect(() => parseStaticLicences(withBrand({ background: '#12345' }))).toThrow();
    expect(() => parseStaticLicences(withBrand({ intro: 'x'.repeat(281) }))).toThrow(
      /brand\.intro/,
    );
    expect(() => parseStaticLicences(withBrand({ intro: 'x'.repeat(280) }))).not.toThrow();
    expect(() => parseStaticLicences(withBrand({ baseTheme: 'nope' }))).toThrow();
  });

  it('the dev licences parse', () => {
    expect(parseStaticLicences(JSON.stringify(DEV_LICENCES))).toEqual(DEV_LICENCES);
  });
});

describe('StaticLicences', () => {
  const port = (list: StaticLicence[]) => new StaticLicences(list);

  it('usableBy matches hosts by user id, email (any case) or *', async () => {
    const p = port([
      lic({ id: 'by-id', hosts: ['u1'] }),
      lic({ id: 'by-email', hosts: ['ann@example.COM'] }),
      lic({ id: 'anyone', hosts: ['*'] }),
      lic({ id: 'someone-else', hosts: ['u9', 'x@y.z'] }),
    ]);
    expect((await p.usableBy(host, NOW)).map((l) => l.id)).toEqual(['by-id', 'by-email', 'anyone']);
    expect((await p.usableBy(other, NOW)).map((l) => l.id)).toEqual(['anyone']);
  });

  it('usableBy leaves out expired, not yet valid and used up licences', async () => {
    const p = port([
      lic({ id: 'ok' }),
      lic({ id: 'expired', expiresAt: NOW - 1 }),
      lic({ id: 'later', validFrom: NOW + DAY }),
      lic({ id: 'used', eventsLeft: 0 }),
      lic({ id: 'annual', package: 'annual', eventsLeft: null }),
    ]);
    expect((await p.usableBy(host, NOW)).map((l) => l.id)).toEqual(['ok', 'annual']);
  });

  it('never gives the hosts list out', async () => {
    const p = port([lic({ hosts: ['u1'] })]);
    const [l] = await p.usableBy(host, NOW);
    expect(l).not.toHaveProperty('hosts');
    const c = await p.check(host, 'lic-1', NOW);
    expect(c.ok && c.licence).not.toHaveProperty('hosts');
  });

  it('check gives each refusal in turn', async () => {
    const p = port([
      lic({ id: 'mine', hosts: ['u1'] }),
      lic({ id: 'theirs', hosts: ['u2'] }),
      lic({ id: 'later', validFrom: NOW + DAY }),
      lic({ id: 'expired', expiresAt: NOW }),
      lic({ id: 'used', eventsLeft: 0 }),
    ]);
    expect(await p.check(host, 'mine', NOW)).toMatchObject({ ok: true, licence: { id: 'mine' } });
    expect(await p.check(host, 'nope', NOW)).toEqual({ ok: false, reason: 'not-found' });
    expect(await p.check(host, 'theirs', NOW)).toEqual({ ok: false, reason: 'not-a-facilitator' });
    expect(await p.check(host, 'later', NOW)).toEqual({ ok: false, reason: 'not-yet-valid' });
    expect(await p.check(host, 'expired', NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(await p.check(host, 'used', NOW)).toEqual({ ok: false, reason: 'no-events-left' });
  });

  const use = (useKey: string) => ({
    useKey,
    pin: '123456',
    gameId: useKey,
    startedAt: NOW,
    players: 4,
  });

  it('recordUse counts once per use key', async () => {
    const p = port([lic({ eventsLeft: 2 })]);
    expect(await p.recordUse('lic-1', use('room-a'))).toEqual({ ok: true });
    expect(await p.recordUse('lic-1', use('room-a'))).toEqual({ ok: true });
    expect(
      (await p.check(host, 'lic-1', NOW)).ok && (await p.usableBy(host, NOW))[0].eventsLeft,
    ).toBe(1);
    expect(await p.recordUse('lic-1', use('room-b'))).toEqual({ ok: true });
    expect(await p.check(host, 'lic-1', NOW)).toEqual({ ok: false, reason: 'no-events-left' });
    expect(await p.recordUse('lic-1', use('room-c'))).toEqual({
      ok: false,
      reason: 'no-events-left',
    });
    // A use already counted stays fine.
    expect(await p.recordUse('lic-1', use('room-b'))).toEqual({ ok: true });
  });

  it('an annual licence counts no events', async () => {
    const p = port([lic({ package: 'annual', eventsLeft: null })]);
    expect(await p.recordUse('lic-1', use('room-a'))).toEqual({ ok: true });
    expect(await p.recordUse('lic-1', use('room-b'))).toEqual({ ok: true });
    const c = await p.check(host, 'lic-1', NOW);
    expect(c.ok && c.licence.eventsLeft).toBeNull();
  });

  it('recordUse of an unknown licence is not-found', async () => {
    expect(await port([]).recordUse('lic-1', use('room-a'))).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('replace swaps the licences and forgets the uses; the list given stays untouched', async () => {
    const list = [lic({ eventsLeft: 1 })];
    const p = port([]);
    p.replace(list);
    await p.recordUse('lic-1', use('room-a'));
    expect(list[0].eventsLeft).toBe(1);
    p.replace(list);
    expect(await p.recordUse('lic-1', use('room-a'))).toEqual({ ok: true });
    expect(await p.check(host, 'lic-1', NOW)).toEqual({ ok: false, reason: 'no-events-left' });
  });

  it('what check gives is a copy: changing it changes nothing', async () => {
    const p = port([lic()]);
    const c = await p.check(host, 'lic-1', NOW);
    if (c.ok) c.licence.participantCap = 999;
    const again = await p.check(host, 'lic-1', NOW);
    expect(again.ok && again.licence.participantCap).toBe(30);
  });
});
