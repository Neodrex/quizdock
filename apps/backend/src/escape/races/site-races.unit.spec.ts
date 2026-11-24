import type { z } from 'zod';
import type { SiteClient, SiteResult } from '../site/site-client';
import type { RaceResults } from './race.port';
import { SITE_PIN, SiteRaces } from './site-races';

const host = { userId: 'u1', email: 'dev@example.com', oidcSubject: 'sub-1' };
const RACE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const brand = {
  name: 'Channel 4',
  logoUrl: 'https://cdn.example.com/c4.png',
  accent: '#1d4ed8',
  background: null,
  baseTheme: 'classic',
  intro: null,
};

type Reply = SiteResult<unknown> | { raw: unknown };
const down: Reply = { ok: false, reason: 'unavailable', cause: 'network' };

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
  return { races: new SiteRaces(site, log), calls, log, post };
}

const results = (rows: number): RaceResults => ({
  pin: '123456',
  endedAt: 1_800_000_000_000,
  totalTeams: rows,
  top: Array.from({ length: rows }, (_, i) => ({
    place: i + 1,
    name: `Team ${i + 1}`,
    escaped: i < 3,
    timeMs: i < 3 ? 60_000 * (i + 10) : null,
    stages: 2,
  })),
});

describe('SiteRaces', () => {
  it('claim posts the host by subject and gives the race, its brand checked', async () => {
    const race = { title: 'Friday race', startsAt: 1_800_000_000_000, format: 'teams', brand };
    const { races, calls } = fakeSite({ raw: { ok: true, race } });
    expect(await races.claim(host, RACE)).toEqual({ ok: true, race });
    expect(calls).toEqual([
      {
        path: `/api/live/races/${RACE}/claim`,
        body: { host: { subject: 'sub-1', email: 'dev@example.com' } },
      },
    ]);
  });

  it('claim drops a logo that is not https, with a warning', async () => {
    const race = {
      title: 'R',
      startsAt: 1_800_000_000_000,
      format: 'solo',
      brand: { ...brand, logoUrl: 'http://127.0.0.1:54321/c4.png' },
    };
    const { races, log } = fakeSite({ raw: { ok: true, race } });
    expect(await races.claim(host, RACE)).toMatchObject({
      ok: true,
      race: { brand: { logoUrl: null } },
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it.each(['not-found', 'not-allowed', 'not-open'])(
    'claim passes the refusal %s on',
    async (reason) => {
      const { races } = fakeSite({ raw: { ok: false, reason } });
      expect(await races.claim(host, RACE)).toEqual({ ok: false, reason });
    },
  );

  it.each([down, { raw: { ok: false, reason: 'teapot' } }, { raw: { ok: true } }])(
    'claim with the Site down or odd is unavailable',
    async (reply) => {
      const { races } = fakeSite(reply);
      expect(await races.claim(host, RACE)).toEqual({ ok: false, reason: 'unavailable' });
    },
  );

  it('the race id is escaped in the path', async () => {
    const { races, calls } = fakeSite({ raw: { ok: false, reason: 'not-found' } });
    await races.claim(host, '../licences/usable');
    expect(calls[0].path).toBe('/api/live/races/..%2Flicences%2Fusable/claim');
  });

  it('opened sends the PIN and gives the Site’s answer; a refusal is logged, not thrown', async () => {
    const { races, calls, log } = fakeSite(
      { raw: { ok: true } },
      { raw: { ok: false, reason: 'not-open' } },
      { raw: { ok: false, reason: 'not-found' } },
    );
    expect(await races.opened(RACE, '123456')).toEqual({ ok: true });
    expect(calls[0]).toEqual({ path: `/api/live/races/${RACE}/opened`, body: { pin: '123456' } });
    expect(await races.opened(RACE, '123456')).toEqual({ ok: false, reason: 'not-open' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not-open'));
    expect(await races.opened(RACE, '123456')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('opened with the Site down or an unknown refusal is unavailable', async () => {
    const { races } = fakeSite(down, { raw: { ok: false, reason: 'later' } });
    expect(await races.opened(RACE, '123456')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await races.opened(RACE, '123456')).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('Live PINs (6 digits) match what the Site takes; anything else is not sent, never retried', async () => {
    expect(SITE_PIN.test('012345')).toBe(true);
    const { races, post, log } = fakeSite({ raw: { ok: true } });
    // A retry cannot fix the PIN: not-found, like a race the Site does not know.
    expect(await races.opened(RACE, 'a b')).toEqual({ ok: false, reason: 'not-found' });
    expect(post).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('finished sends the PIN and at most 20 rows', async () => {
    const { races, calls } = fakeSite({ raw: { ok: true } });
    await races.finished(RACE, results(25));
    const body = calls[0].body as RaceResults;
    expect(calls[0].path).toBe(`/api/live/races/${RACE}/results`);
    expect(body.pin).toBe('123456');
    expect(body.totalTeams).toBe(25);
    expect(body.top).toHaveLength(20);
  });

  it('finished retries once when the Site cannot answer, then logs; never throws', async () => {
    const twice = fakeSite(down);
    await expect(twice.races.finished(RACE, results(2))).resolves.toBeUndefined();
    expect(twice.post).toHaveBeenCalledTimes(2);
    expect(twice.log.warn).toHaveBeenCalledTimes(1);
    const again = fakeSite(down, { raw: { ok: true } });
    await again.races.finished(RACE, results(2));
    expect(again.post).toHaveBeenCalledTimes(2);
    expect(again.log.warn).not.toHaveBeenCalled();
  });

  it('a refused result is logged and not retried', async () => {
    const { races, post, log } = fakeSite({ raw: { ok: false, reason: 'not-open' } });
    await races.finished(RACE, results(2));
    expect(post).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not-open'));
  });
});
