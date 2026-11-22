/**
 * How many lanes the big screen lays out, and in how many columns, so nothing ever
 * scrolls or spills (M6 §1.8). The screen is sized in em on a base of 2.6vmin: about
 * 38 em of height on any 16:9, 16:10 or 4:3 screen, 720p to 4K alike. Under the
 * running header (3 em) and the final-minutes footer (an 8 em clock and its words,
 * 10.3 em), about 19.6 em is left for the race:
 * - a wide lane (name and stage title, 3.3 em) fits 5 times;
 * - a one-line lane (2 em, with its gap 2.3 em) fits 8 rows.
 * The replay, under the finale's title and closing text, has about 20.5 em: the same
 * counts hold.
 */

/** Lanes of their own row, with the stage title under the name. */
export const WIDE_LANES_MAX = 5;
/** Rows of one-line lanes per column. */
export const LANE_ROWS = 8;
/** Up to this many teams every lane shows; above, the leaders and a count. */
export const ALL_LANES_MAX = 30;
/** Lanes shown above ALL_LANES_MAX: two columns, leaving a row for the count. */
export const TOP_LANES = 12;

export interface LanesLayout {
  columns: 1 | 2 | 3 | 4;
  /** How many lanes are drawn: every team, or the leaders. */
  shown: number;
  /** One lane per row with its stage title; else one line each. */
  wide: boolean;
}

export function lanesLayoutOf(teams: number): LanesLayout {
  if (teams <= WIDE_LANES_MAX) return { columns: 1, shown: teams, wide: true };
  if (teams > ALL_LANES_MAX) return { columns: 2, shown: TOP_LANES, wide: false };
  const columns = Math.max(2, Math.ceil(teams / LANE_ROWS)) as LanesLayout['columns'];
  return { columns, shown: teams, wide: false };
}

/** The grid's columns, as whole class names (Tailwind reads them from the source). */
export const COLUMN_CLASS: Record<LanesLayout['columns'], string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
};
