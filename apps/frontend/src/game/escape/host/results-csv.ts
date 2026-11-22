import type { EscapeFinale } from '@quiz-dock/contracts';
import { csvFilename, toCsv } from '@/lib/csv';
import { formatClock } from '../team-timer';

/**
 * The run's results as CSV (M5 §1.8), built on the client from `EscapeFinale`: what
 * the ranking holds, never an answer. Cells go through the app's CSV writer (`;`,
 * RFC 4180 quotes, and a `'` before a text cell that starts with `= + - @`, a tab or a
 * carriage return, so a team or player name cannot run as a formula). Saved with
 * `downloadCsv`, which adds the UTF-8 BOM for Excel.
 */

/** The column titles, in the console's language. */
export interface ResultsCsvLabels {
  place: string;
  team: string;
  escaped: string;
  score: string;
  stagesCleared: string;
  /** One per stage: the time spent on it. */
  stage: (n: number) => string;
  hints: string;
  paidHints: string;
  penaltyS: string;
  extraS: string;
  hostUnlocks: string;
  members: string;
  yes: string;
  no: string;
}

/** Each stage's own time (its split), m:ss; empty for a stage not cleared. */
const splits = (cleared: number[], stageCount: number): string[] =>
  Array.from({ length: stageCount }, (_, i) =>
    cleared[i] === undefined ? '' : formatClock(cleared[i] - (cleared[i - 1] ?? 0)),
  );

/** The rows: the header, then one per team in ranking order. */
export function resultsRows(
  finale: EscapeFinale,
  labels: ResultsCsvLabels,
  stageCount: number,
): (string | number)[][] {
  const stages = Math.max(stageCount, ...finale.ranking.map((r) => r.stageClearedAt.length), 0);
  const header = [
    labels.place,
    labels.team,
    labels.escaped,
    labels.score,
    labels.stagesCleared,
    ...Array.from({ length: stages }, (_, i) => labels.stage(i + 1)),
    labels.hints,
    labels.paidHints,
    labels.penaltyS,
    labels.extraS,
    labels.hostUnlocks,
    labels.members,
  ];
  const rows = finale.ranking.map((r) => [
    r.place,
    r.name,
    r.escaped ? labels.yes : labels.no,
    r.escaped && r.scoreMs !== null ? formatClock(r.scoreMs) : '',
    r.stagesCleared,
    ...splits(r.stageClearedAt, stages),
    r.hintsUsed,
    r.paidHints,
    r.hintPenaltyS,
    Math.round(r.adjustMs / 1000),
    r.hostUnlocks,
    r.members.join(', '),
  ]);
  return [header, ...rows];
}

/** The file's text (no BOM: `downloadCsv` adds it). */
export function resultsCsv(
  finale: EscapeFinale,
  labels: ResultsCsvLabels,
  stageCount: number,
): string {
  return toCsv(resultsRows(finale, labels, stageCount));
}

/** `<title>-<yyyy-mm-dd>.csv`, the date in the host's own time zone. */
export function resultsFilename(title: string, day: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  return csvFilename(title, date);
}
