import { describe, expect, it } from 'vitest';
import { SAMPLE_ANSWERS, finaleOf } from './host-fixtures';
import {
  BOM,
  type ResultsCsvLabels,
  resultsCsv,
  resultsFilename,
  resultsRows,
} from './results-csv';

const labels: ResultsCsvLabels = {
  place: 'Place',
  team: 'Team',
  escaped: 'Escaped',
  score: 'Score',
  stagesCleared: 'Stages cleared',
  stage: (n) => `Stage ${n}`,
  hints: 'Hints',
  paidHints: 'Paid hints',
  penaltyS: 'Hint penalty (s)',
  extraS: 'Extra time (s)',
  hostUnlocks: 'Host unlocks',
  members: 'Members',
  yes: 'yes',
  no: 'no',
};

describe('results CSV', () => {
  it('a header and a row per team, in ranking order', () => {
    const [header, red, blue] = resultsRows(finaleOf(), labels, 3);
    expect(header).toEqual([
      'Place',
      'Team',
      'Escaped',
      'Score',
      'Stages cleared',
      'Stage 1',
      'Stage 2',
      'Stage 3',
      'Hints',
      'Paid hints',
      'Hint penalty (s)',
      'Extra time (s)',
      'Host unlocks',
      'Members',
    ]);
    // Score and stage times as m:ss; the stage times are each stage's own.
    expect(red).toEqual([
      1,
      'Team Red',
      'yes',
      '32:12',
      3,
      '4:12',
      '10:48',
      '16:12',
      2,
      1,
      60,
      120,
      1,
      'Ana, Ben',
    ]);
    // Not escaped: no score, its stages after the last cleared are empty.
    expect(blue).toEqual([
      2,
      '=HYPERLINK("http://x")',
      'no',
      '',
      1,
      '5:00',
      '',
      '',
      1,
      0,
      0,
      0,
      0,
      '@Cy, Dee',
    ]);
  });

  it('starts with a BOM; quotes are doubled; a formula-like name gets a leading quote', () => {
    const csv = resultsCsv(finaleOf(), labels, 3);
    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.slice(BOM.length).split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      'Place;Team;Escaped;Score;Stages cleared;Stage 1;Stage 2;Stage 3;Hints;Paid hints;Hint penalty (s);Extra time (s);Host unlocks;Members',
    );
    expect(lines[2]).toBe(`2;"'=HYPERLINK(""http://x"")";no;;1;5:00;;;1;0;0;0;0;'@Cy, Dee`);
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
    'a name starting %j is not a formula',
    (name) => {
      const finale = finaleOf();
      finale.ranking[0] = { ...finale.ranking[0], name, members: [name] };
      const [, row] = resultsCsv(finale, labels, 3)
        .slice(BOM.length)
        .split(/\r\n(?=\d)/);
      const cells = row.split(';');
      expect(cells[1].replace(/^"/, '').startsWith(`'`)).toBe(true);
      expect(cells.at(-1)!.replace(/^"/, '').startsWith(`'`)).toBe(true);
    },
  );

  it('numbers stay numbers (a negative extra time is no formula)', () => {
    const finale = finaleOf();
    finale.ranking[0] = { ...finale.ranking[0], adjustMs: -60_000 };
    expect(resultsRows(finale, labels, 3)[1][11]).toBe(-60);
    expect(resultsCsv(finale, labels, 3)).toContain(';-60;');
  });

  it('holds no answer value', () => {
    const csv = resultsCsv(finaleOf(), labels, 3).toLowerCase();
    for (const a of SAMPLE_ANSWERS) expect(csv).not.toContain(a.toLowerCase());
  });

  it('is named <title>-<yyyy-mm-dd>.csv', () => {
    expect(resultsFilename('Vault Heist', new Date(2026, 10, 2, 23, 30))).toBe(
      'vault-heist-2026-11-02.csv',
    );
  });
});
