import { NoRaces } from './no-races';
import type { RacePort } from './race.port';
import { racePortFor } from './races.module';
import { SiteRaces } from './site-races';

describe('the race port (ESCAPE_SITE_URL)', () => {
  const token = 't'.repeat(32);

  it('no Site URL gives NoRaces, whatever the token', () => {
    expect(racePortFor({ url: '', token: '' })).toBeInstanceOf(NoRaces);
    expect(racePortFor({ url: '  ', token })).toBeInstanceOf(NoRaces);
  });

  it('a Site URL and a token give SiteRaces', () => {
    expect(racePortFor({ url: 'https://site.example', token })).toBeInstanceOf(SiteRaces);
  });

  it('an invalid URL or a blank token fails the boot', () => {
    expect(() => racePortFor({ url: 'site.example', token })).toThrow(/ESCAPE_SITE_URL/);
    expect(() => racePortFor({ url: 'https://site.example', token: '' })).toThrow(
      /ESCAPE_SITE_TOKEN/,
    );
    expect(() => racePortFor({ url: 'https://site.example', token: ' '.repeat(32) })).toThrow(
      /ESCAPE_SITE_TOKEN/,
    );
  });

  it('NoRaces finds no race and reports nothing', async () => {
    const none: RacePort = new NoRaces();
    const host = { userId: 'u1', email: null, oidcSubject: 's' };
    expect(await none.claim(host, 'r1')).toEqual({ ok: false, reason: 'not-found' });
    await expect(none.opened('r1', '123456')).resolves.toBeUndefined();
  });
});
