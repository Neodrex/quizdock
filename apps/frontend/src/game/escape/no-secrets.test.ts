import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The phone draws only what a player is sent. The host's and the board's payloads
 * carry answers (the outline) or every team's progress: no phone file may name them.
 */
const FORBIDDEN = [
  'EscapeOutline',
  'escape:outline',
  'escape:host',
  'EscapeHostTeam',
  'escape:host-batch',
  'EscapeHostBatch',
  'EscapeHostState',
  'escape:board',
  'EscapeBoard',
];

/**
 * Licence details no client is sent (M7 §1.4): the phone files may not name them.
 * The create dialog is the host's: it lists the host's own licences over REST, with
 * the events left, and only the rooms page (the console's) renders it.
 */
const LICENCE_SECRETS = ['eventsLeft', 'organisationId', 'ESCAPE_STATIC_LICENCES'];
const HOST_LICENCE_PICKER = 'game/escape/session/create-dialog.tsx';

const src = resolve(process.cwd(), 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('the phone never names the host or board payloads', () => {
  const host = resolve(src, 'game/escape/host');
  const bigScreen = resolve(src, 'game/escape/screen');
  const scanned = [
    // The host console's files (host/) are the host's: they get these payloads.
    // The player page reaches host/ only through `usePhoneHost` (group play's phone
    // host), which keeps counts only (`phoneHostRoomOf`): no team's details.
    // The big screen's (screen/) get the board: their own guard is in screen/screen-sources.test.ts.
    ...files(resolve(src, 'game/escape')).filter(
      (p) => !p.startsWith(host) && !p.startsWith(bigScreen),
    ),
    resolve(src, 'routes/escape-player-page.tsx'),
    // Tests name them to check they are not listened for; they ship nothing.
  ].filter((p) => !/\.test\.tsx?$/.test(p));

  it('scans the escape phone files', () => {
    expect(scanned.length).toBeGreaterThan(10);
    expect(scanned.some((p) => p.endsWith('use-escape-session.ts'))).toBe(true);
  });

  it.each(scanned.map((p) => [p.slice(src.length + 1), p]))('%s', (_, path) => {
    const text = readFileSync(path, 'utf8');
    const words = _ === HOST_LICENCE_PICKER ? FORBIDDEN : [...FORBIDDEN, ...LICENCE_SECRETS];
    expect(words.filter((word) => text.includes(word))).toEqual([]);
  });

  it('keeps the licence picker the host’s alone', () => {
    const phone = scanned.filter((p) => !p.endsWith(HOST_LICENCE_PICKER));
    for (const p of phone) expect(readFileSync(p, 'utf8')).not.toMatch(/create-dialog/);
  });
});
