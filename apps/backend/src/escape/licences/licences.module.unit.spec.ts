import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS } from '@quiz-dock/contracts';
import { DEV_LICENCES } from './dev-licences';
import { licencePortFor } from './licences.module';
import { NoLicences } from './no-licences';
import { StaticLicences } from './static-licences';

describe('the licence source (ESCAPE_LICENCE_SOURCE)', () => {
  it('none gives NoLicences, static gives StaticLicences', () => {
    expect(licencePortFor('none', '')).toBeInstanceOf(NoLicences);
    const port = licencePortFor('static', JSON.stringify(DEV_LICENCES));
    expect(port).toBeInstanceOf(StaticLicences);
  });

  it('an invalid static value fails (the boot)', () => {
    expect(() => licencePortFor('static', '[{"id":1}]')).toThrow(/ESCAPE_STATIC_LICENCES/);
  });

  const site = { url: 'https://site.example', token: 't'.repeat(32) };

  it.each([
    ['no URL', { ...site, url: '' }],
    ['no token', { ...site, token: '' }],
    ['neither', { url: '', token: '' }],
  ])('site with %s fails the boot, naming both settings', (_, given) => {
    expect(() => licencePortFor('site', '', given)).toThrow(
      /ESCAPE_LICENCE_SOURCE=site needs ESCAPE_SITE_URL and ESCAPE_SITE_TOKEN/,
    );
  });

  it('site with both set is not built yet (Task 8.13)', () => {
    expect(() => licencePortFor('site', '', site)).toThrow(/SiteLicences: Task 8\.13/);
  });
});

describe('the Site settings', () => {
  it('the source accepts none, static and site, and nothing else', () => {
    const { schema } = SETTINGS.ESCAPE_LICENCE_SOURCE;
    expect(['none', 'static', 'site'].map((v) => schema.safeParse(v).success)).toEqual([
      true,
      true,
      true,
    ]);
    expect(schema.safeParse('internal').success).toBe(false);
  });

  it('a token under 32 characters is refused', () => {
    const { schema } = SETTINGS.ESCAPE_SITE_TOKEN;
    expect(schema.safeParse('t'.repeat(31)).success).toBe(false);
    expect(schema.safeParse('t'.repeat(32)).success).toBe(true);
  });

  it('the token is a secret, and every Site setting is for operators', () => {
    expect(SETTINGS.ESCAPE_SITE_TOKEN.secret).toBe(true);
    for (const def of [
      SETTINGS.ESCAPE_LICENCE_SOURCE,
      SETTINGS.ESCAPE_STATIC_LICENCES,
      SETTINGS.ESCAPE_SITE_URL,
      SETTINGS.ESCAPE_SITE_TOKEN,
    ]) {
      expect(def.internal).toBeFalsy();
      expect(def.category).toBe('access');
    }
  });

  it('the Site URL must be http(s)', () => {
    const { bounds } = SETTINGS.ESCAPE_SITE_URL;
    expect(bounds?.safeParse('https://site.example').success).toBe(true);
    expect(bounds?.safeParse('http://localhost:5173').success).toBe(true);
    expect(bounds?.safeParse('site.example').success).toBe(false);
  });
});

describe('settings only', () => {
  it('no escape source reads process.env', () => {
    const root = join(__dirname, '..');
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) walk(path);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
          if (/process\.env\b/.test(readFileSync(path, 'utf8'))) readers.push(path);
        }
      }
    };
    walk(root);
    expect(readers).toEqual([]);
  });
});
