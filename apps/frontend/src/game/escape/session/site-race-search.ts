/** The `/escape` search of a Site race link (M8 Task 8.17): display values only. */
export interface SiteRaceSearch {
  siteRace?: string;
  title?: string;
  startsAt?: number;
}

/** The Site's own cap on a race title. */
export const SITE_RACE_TITLE_MAX = 200;
/** The last ms epoch a `Date` holds. */
const MAX_DATE_MS = 8.64e15;

/**
 * Parses the link's search. The values come from a URL anyone can write: a
 * start that is not a whole positive ms epoch a `Date` holds is dropped, a
 * title is cut at 200 characters. The server claims the race and uses the Site's.
 */
export function siteRaceSearch(s: Record<string, unknown>): SiteRaceSearch {
  const n =
    typeof s.startsAt === 'number' || typeof s.startsAt === 'string' ? Number(s.startsAt) : NaN;
  // Every key is set, `undefined` when dropped: the router merges the raw search under this one.
  return {
    siteRace: typeof s.siteRace === 'string' && s.siteRace ? s.siteRace : undefined,
    title: typeof s.title === 'string' ? s.title.slice(0, SITE_RACE_TITLE_MAX) : undefined,
    startsAt:
      s.startsAt !== '' && Number.isSafeInteger(n) && n > 0 && n <= MAX_DATE_MS ? n : undefined,
  };
}

/** The start as the host reads it, or null when it cannot be shown (never throws). */
export function siteRaceWhen(startsAt: number, lang: string): string | null {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(startsAt),
    );
  } catch {
    return null;
  }
}
