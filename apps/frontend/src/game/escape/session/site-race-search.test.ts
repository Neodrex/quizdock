import { describe, expect, it } from 'vitest';
import { SITE_RACE_TITLE_MAX, siteRaceSearch, siteRaceWhen } from './site-race-search';

describe('siteRaceSearch (/escape?siteRace=&title=&startsAt=)', () => {
  it('keeps a race id, a title and a start in ms', () => {
    expect(
      siteRaceSearch({ siteRace: 'r1', title: 'Friday', startsAt: 1_900_000_000_000 }),
    ).toEqual({ siteRace: 'r1', title: 'Friday', startsAt: 1_900_000_000_000 });
    expect(siteRaceSearch({ startsAt: '1900000000000' })).toEqual({ startsAt: 1_900_000_000_000 });
  });

  it.each([1e20, null, 0, -5, 1.5, 8.64e15 + 1, Number.NaN, '', 'soon', undefined])(
    'drops the start %p',
    (startsAt) => {
      expect(siteRaceSearch({ siteRace: 'r1', startsAt })).toEqual({ siteRace: 'r1' });
    },
  );

  it('accepts the last valid date', () => {
    expect(siteRaceSearch({ startsAt: 8.64e15 })).toEqual({ startsAt: 8.64e15 });
  });

  it('caps a title that is too long at 200 characters', () => {
    const title = siteRaceSearch({ title: 'x'.repeat(5000) }).title;
    expect(SITE_RACE_TITLE_MAX).toBe(200);
    expect(title).toBe('x'.repeat(200));
  });

  it('drops an empty race id and values that are not strings', () => {
    expect(siteRaceSearch({ siteRace: '', title: 42 })).toEqual({});
  });
});

describe('siteRaceWhen', () => {
  it('formats a start in the language, and never throws', () => {
    expect(siteRaceWhen(Date.UTC(2026, 11, 31, 18), 'en')).toMatch(/2026/);
    expect(siteRaceWhen(1e20, 'en')).toBeNull();
    expect(siteRaceWhen(Date.UTC(2026, 11, 31), 'not a language!!')).toBeNull();
  });
});
