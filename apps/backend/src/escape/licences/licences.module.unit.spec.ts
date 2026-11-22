import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
