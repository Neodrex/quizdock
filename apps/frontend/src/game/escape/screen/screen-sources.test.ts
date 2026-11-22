import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { supportedLngs } from '../../../i18n/languages';

/**
 * The big screen draws only what a screen is sent (M6 §1.4): the board, the announces
 * and the screen finale. No screen file may name the phone's, the host's or the
 * answers' payloads, listen for their events, or import the console's code.
 * (The phone's guard, no-secrets.test.ts, skips screen/: these files get the board.)
 */
const FORBIDDEN: [string, RegExp][] = [
  [
    'host, phone or answer types',
    /\b(EscapeOutline|EscapeHostOutline|EscapeHostState|EscapeHostTeam|EscapePlayerState|EscapePlayerView|EscapeTeamUpdate|EscapeFinale|EscapeTemplate\w*)\b/,
  ],
  [
    'events not for a screen',
    /['"]escape:(state|host|host-team|outline|finale|team-update|results)['"]/,
  ],
  ['story lines or player ids', /\b(unlockText|playerId)\b/],
  ['the console code', /(from\s+|import\(\s*|require\(\s*)['"][^'"]*\/host\//],
  [
    // The phone's modules hold a player's view: clues, hints, unlock texts, the full
    // finale. The screen may share its sync, announcer, reducer types and clocks only.
    "the phone's state or panels",
    /['"][^'"]*\/escape\/(use-escape-session|escape-record|escape-finale|escape-lobby|clue-list|hint-panel|role-card|unlock-moment|use-team-clock|locks\/)[^'"]*['"]|['"]\.\.\/(use-escape-session|escape-record|escape-finale|escape-lobby|clue-list|hint-panel|role-card|unlock-moment|use-team-clock|locks\/)[^'"]*['"]/,
  ],
];

const src = resolve(process.cwd(), 'src');
const dir = resolve(src, 'game/escape/screen');

function screenSourceFindings(text: string): string[] {
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([what]) => what);
}

describe('the big screen never names the phone, host or answer payloads', () => {
  const scanned = [
    ...readdirSync(dir)
      // Tests and their fixtures ship nothing.
      .filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$|-fixtures\.tsx?$/.test(n))
      .map((n) => join(dir, n)),
    resolve(src, 'routes/escape-screen-page.tsx'),
    // The projection's seam: what it hands the screen.
    resolve(src, 'routes/escape-or-quiz.tsx'),
  ];

  it('scans the screen files', () => {
    expect(scanned.some((p) => p.endsWith('use-escape-screen.ts'))).toBe(true);
    expect(scanned.some((p) => p.endsWith('screen-reducer.ts'))).toBe(true);
    expect(scanned.some((p) => p.endsWith('screen-palette.ts'))).toBe(true);
    expect(scanned.some((p) => p.endsWith('escape-or-quiz.tsx'))).toBe(true);
  });

  it('catches what it is meant to, and lets the screen finale through', () => {
    expect(screenSourceFindings("on('escape:finale', f)")).toEqual(['events not for a screen']);
    expect(screenSourceFindings("on('escape:host', f)")).toEqual(['events not for a screen']);
    expect(screenSourceFindings('type X = EscapeHostTeam')).toEqual([
      'host, phone or answer types',
    ]);
    expect(screenSourceFindings('t.unlockText')).toEqual(['story lines or player ids']);
    expect(screenSourceFindings("import { a } from '../host/host-client'")).toEqual([
      'the console code',
    ]);
    expect(screenSourceFindings("await import('../host/host-client')")).toEqual([
      'the console code',
    ]);
    expect(
      screenSourceFindings("import { useEscapeSession } from '../use-escape-session'"),
    ).toEqual(["the phone's state or panels"]);
    expect(screenSourceFindings("import { HintPanel } from '../game/escape/hint-panel'")).toEqual([
      "the phone's state or panels",
    ]);
    expect(screenSourceFindings("import { CodeLock } from '../locks/code-lock'")).toEqual([
      "the phone's state or panels",
    ]);
    // What the screen does share with the phone.
    expect(
      screenSourceFindings(
        "import { useEscapeSync } from '../escape-sync';\nimport { formatClock } from '../team-timer';",
      ),
    ).toEqual([]);
    expect(
      screenSourceFindings("on('escape:screen-finale', (f: EscapeScreenFinale) => f)"),
    ).toEqual([]);
  });

  it.each(scanned.map((p) => [p.slice(src.length + 1), p]))('%s', (_, path) => {
    expect(screenSourceFindings(readFileSync(path, 'utf8'))).toEqual([]);
  });
});

/**
 * Every text the big screen and its console panel draw exists in each shipped language
 * (M6 Task 6.18): `pnpm i18n:check` compares the locales with English, this checks the
 * code's keys against them. Keys built at run time (`award.${key}`) are listed by hand.
 */
describe('the big screen texts exist in every shipped language', () => {
  const screenFiles = [
    ...readdirSync(dir)
      .filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$|-fixtures\.tsx?$/.test(n))
      .map((n) => join(dir, n)),
    resolve(src, 'routes/escape-screen-page.tsx'),
  ];
  const BUILT = ['fastest', 'fewestHints', 'teamwork', 'photoFinish'].map(
    (k) => `screen.finale.award.${k}`,
  );
  /** `escape` keys by default, `ns:key` for another namespace. */
  const keysIn = (text: string) =>
    [...text.matchAll(/\bt\(\s*['"]([\w.:-]+)['"]/g)].map((m) => m[1]);
  const flat = (o: Record<string, unknown>, p = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`],
    );
  const has = (keys: Set<string>, key: string) =>
    keys.has(key) || [...keys].some((k) => k.startsWith(`${key}_`));
  const load = (lng: string, ns: string) =>
    new Set(flat(JSON.parse(readFileSync(resolve(src, `i18n/locales/${lng}/${ns}.json`), 'utf8'))));

  const used = [
    ...new Set([...screenFiles.flatMap((p) => keysIn(readFileSync(p, 'utf8'))), ...BUILT]),
  ];
  // The console's screen panel reads upstream's `live:` keys, plus the escape ones.
  const panel = readFileSync(resolve(src, 'game/escape/host/screen-panel.tsx'), 'utf8');
  const panelKeys = keysIn(panel).map((k) => (k.includes(':') ? k : `live:${k}`));

  it('finds the keys it checks', () => {
    expect(used).toContain('screen.track.label');
    expect(used).toContain('live:screen.qrLabel');
    expect(panelKeys).toContain('live:control.pairCodeLabel');
  });

  it.each([...supportedLngs])('%s', (lng) => {
    const missing = [...used, ...panelKeys].filter((key) => {
      const [ns, k] = key.includes(':') ? key.split(':') : ['escape', key];
      return !has(load(lng, ns), k);
    });
    expect(missing).toEqual([]);
  });
});
