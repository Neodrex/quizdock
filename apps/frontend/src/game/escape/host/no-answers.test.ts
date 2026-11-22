import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The host never sees answer values (owner question 1). The console's files get the
 * host outline (no answers) and the template list (no content): none of them may
 * read an answer key, the old outline type, or a template REST call that answers
 * with the content. Comments are left out: they may say "answer" in prose.
 */
const FORBIDDEN: [string, RegExp][] = [
  ['answer keys', /\b(answer|answers|correct)\b/],
  ['the order key', /\.order\b|\border\s*[:?]|['"]order['"]/],
  ['the old outline type', /\bEscapeOutline\b/],
  ['template content types', /\bEscapeTemplate(Detail|Content)Dto\w*/],
];

/**
 * The only generated template calls the console may name: the list, and the URLs of
 * publish and samples (sent with `?view=summary`, which answers list items only).
 */
const ALLOWED_CALLS = new Set([
  'useEscapeTemplatesControllerList',
  'getEscapeTemplatesControllerListQueryKey',
  'getEscapeTemplatesControllerCreateSamplesUrl',
  'getEscapeTemplatesControllerPublishUrl',
]);

const src = resolve(process.cwd(), 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

/** The code without its comments (line and block). */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the host console never reads an answer', () => {
  const scanned = [
    ...files(resolve(src, 'game/escape/host')),
    resolve(src, 'routes/escape-console-page.tsx'),
    resolve(src, 'routes/escape-rooms-page.tsx'),
    // Tests name answer keys to check they are absent; they ship nothing.
  ].filter((p) => !/\.test\.tsx?$/.test(p));

  it('scans the console files', () => {
    expect(scanned.some((p) => p.endsWith('use-escape-host.ts'))).toBe(true);
    expect(scanned.some((p) => p.endsWith('escape-rooms-page.tsx'))).toBe(true);
  });

  it('strips comments only', () => {
    expect(code('a // the answer\nb /* answers */ c').trim()).toBe('a \nb  c');
    expect(code("const u = 'http://x';")).toBe("const u = 'http://x';");
  });

  it.each(scanned.map((p) => [p.slice(src.length + 1), p]))('%s', (_, path) => {
    const text = code(readFileSync(path, 'utf8'));
    expect(FORBIDDEN.filter(([, re]) => re.test(text)).map(([what]) => what)).toEqual([]);
    const calls = [...text.matchAll(/\b\w*[eE]scapeTemplatesController\w*/g)].map((m) => m[0]);
    expect(calls.filter((c) => !ALLOWED_CALLS.has(c))).toEqual([]);
  });

  it('catches a detail read and an answer key', () => {
    const bad = code(
      "import { useEscapeTemplatesControllerGet } from 'x';\nconst a = lock.answer;",
    );
    expect(FORBIDDEN.some(([, re]) => re.test(bad))).toBe(true);
    expect(bad.match(/\b\w*[eE]scapeTemplatesController\w*/)?.[0]).toBe(
      'useEscapeTemplatesControllerGet',
    );
  });
});
