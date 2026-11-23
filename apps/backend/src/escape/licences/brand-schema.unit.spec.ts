import { ACME_LICENCE } from './dev-licences';
import { licenceBrandSchema } from './brand-schema';

describe('licenceBrandSchema (every licence source, M7 §1.2)', () => {
  const brand = ACME_LICENCE.brand!;
  const ok = (b: Record<string, unknown>) =>
    licenceBrandSchema.safeParse({ ...brand, ...b }).success;
  const env = process.env;
  const was = env.NODE_ENV;
  afterEach(() => {
    if (was === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = was;
  });

  it('https logos, hex colours, a shipped base theme, a short intro', () => {
    expect(ok({})).toBe(true);
    expect(ok({ logoUrl: 'https://cdn.example.com/a.png' })).toBe(true);
    expect(ok({ logoUrl: null })).toBe(true);
    expect(ok({ logoUrl: 'http://example.com/a.png' })).toBe(false);
    expect(ok({ logoUrl: 'javascript:alert(1)' })).toBe(false);
    expect(ok({ accent: 'red' })).toBe(false);
    expect(ok({ background: '#12345' })).toBe(false);
    expect(ok({ baseTheme: 'nope' })).toBe(false);
    expect(ok({ intro: 'x'.repeat(281) })).toBe(false);
  });

  it('http://localhost logos outside production only', () => {
    const local = { logoUrl: 'http://localhost:5173/escape-dev/acme-logo.png' };
    env.NODE_ENV = 'test';
    expect(ok(local)).toBe(true);
    delete env.NODE_ENV;
    expect(ok(local)).toBe(true);
    env.NODE_ENV = 'production';
    expect(ok(local)).toBe(false);
    expect(ok({ logoUrl: 'https://cdn.example.com/a.png' })).toBe(true);
  });
});
