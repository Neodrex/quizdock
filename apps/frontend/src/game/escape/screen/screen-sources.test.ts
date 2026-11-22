import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
  ['the console code', /from\s+['"][^'"]*\/host\//],
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
  ];

  it('scans the screen files', () => {
    expect(scanned.some((p) => p.endsWith('use-escape-screen.ts'))).toBe(true);
    expect(scanned.some((p) => p.endsWith('screen-reducer.ts'))).toBe(true);
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
    expect(
      screenSourceFindings("on('escape:screen-finale', (f: EscapeScreenFinale) => f)"),
    ).toEqual([]);
  });

  it.each(scanned.map((p) => [p.slice(src.length + 1), p]))('%s', (_, path) => {
    expect(screenSourceFindings(readFileSync(path, 'utf8'))).toEqual([]);
  });
});
