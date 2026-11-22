import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The host never sees answer values (owner question 1). The console's files get the
 * host outline (no answers) and the template list (no content): none of them may
 * read an answer key, the old outline type, or a template REST call that answers
 * with the content. Comments are left out: they may say "answer" in prose.
 *
 * The guard follows the import graph from the console and picker entry files, so a
 * helper outside `host/` that the console imports is checked too.
 */
const FORBIDDEN: [string, RegExp][] = [
  ['answer keys', /\b(answer|answers|correct)\b/],
  ['the order key', /\.order\b|\border\s*[:?]|['"]order['"]/],
  ['the old outline type', /\bEscapeOutline\b/],
  ['template content types', /\bEscapeTemplate(Detail|Content)Dto\w*/],
];

/** The generated template calls any console file may name: the list only. */
const LIST_CALLS = new Set([
  'useEscapeTemplatesControllerList',
  'getEscapeTemplatesControllerListQueryKey',
]);

/**
 * The template writes, only in `host-templates.ts`, each sent with `view: 'summary'`
 * (which answers list items, never the content).
 */
const SUMMARY_FILE = 'game/escape/host/host-templates.ts';
const SUMMARY_CALLS = new Set([
  'getEscapeTemplatesControllerCreateSamplesUrl',
  'getEscapeTemplatesControllerPublishUrl',
]);

const ENTRIES = ['routes/escape-console-page.tsx', 'routes/escape-rooms-page.tsx'];

const src = resolve(process.cwd(), 'src');

/** The code without its comments (line and block). */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every rule a console file breaks; `rel` is its path under `src/`. */
function violations(rel: string, source: string): string[] {
  const text = code(source);
  const out: string[] = [];
  const keyed = rel.startsWith('game/escape/') || rel.startsWith('routes/escape-');
  if (keyed) for (const [what, re] of FORBIDDEN) if (re.test(text)) out.push(what);
  const allowed = rel === SUMMARY_FILE ? new Set([...LIST_CALLS, ...SUMMARY_CALLS]) : LIST_CALLS;
  for (const m of text.matchAll(/\b\w*[eE]scapeTemplatesController\w*/g)) {
    if (!allowed.has(m[0])) out.push(`call ${m[0]}`);
  }
  for (const m of text.matchAll(/\b(\w*[eE]scapeTemplatesController\w*Url)\s*\(([^)]*)\)/g)) {
    if (SUMMARY_CALLS.has(m[1]) && !/\bview\s*:\s*['"]summary['"]/.test(m[2])) {
      out.push(`${m[1]} without view: 'summary'`);
    }
  }
  // Module paths (`.../generated/escape-templates/...`) are not URLs.
  const strings = text.replace(/\b(from|import)\s*\(?\s*['"][^'"]*['"]/g, '');
  if (/['"`][^'"`\n]*\/escape-templates\b/.test(strings)) out.push('raw /escape-templates/ URL');
  return out;
}

/** The local files `file` imports (relative and `@/` paths), resolved to disk. */
function importsOf(file: string): string[] {
  const text = code(readFileSync(file, 'utf8'));
  const specs = [
    ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ].map((m) => m[1]);
  const out: string[] = [];
  for (const spec of specs) {
    const base = spec.startsWith('@/')
      ? join(src, spec.slice(2))
      : spec.startsWith('.')
        ? resolve(dirname(file), spec)
        : null;
    if (!base) continue;
    const hit = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
      .map((ext) => base + ext)
      .find((p) => existsSync(p) && statSync(p).isFile() && /\.tsx?$/.test(p));
    if (hit) out.push(hit);
  }
  return out;
}

/** Every local file reachable from the entries; generated API files are not walked. */
function graph(entries: string[]): string[] {
  const seen = new Set<string>();
  const todo = [...entries];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.includes(`${join('api', 'generated')}`)) continue;
    todo.push(...importsOf(f));
  }
  return [...seen].filter((f) => !f.includes(join('api', 'generated')));
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('the host console never reads an answer', () => {
  const reachable = graph(ENTRIES.map((e) => resolve(src, e)));
  // Every host file, reached or not yet wired (tests name answer keys to check
  // they are absent; they ship nothing).
  const hostFiles = files(resolve(src, 'game/escape/host')).filter((p) => !/\.test\.tsx?$/.test(p));
  const scanned = [...new Set([...reachable, ...hostFiles])].sort();
  const rel = (p: string) => relative(src, p);

  it('follows the imports from both entries', () => {
    const names = scanned.map(rel);
    expect(names).toContain('routes/escape-rooms-page.tsx');
    expect(names).toContain('routes/escape-console-page.tsx');
    expect(names).toContain(SUMMARY_FILE);
    expect(names).toContain('game/escape/host/use-escape-host.ts');
    expect(names).toContain('game/launch-access-dialog.tsx'); // outside host/
  });

  it('strips comments only', () => {
    expect(code('a // the answer\nb /* answers */ c').trim()).toBe('a \nb  c');
    expect(code("const u = 'http://x';")).toBe("const u = 'http://x';");
  });

  it.each(scanned.map((p) => [rel(p), p]))('%s', (name, path) => {
    expect(violations(name, readFileSync(path, 'utf8'))).toEqual([]);
  });

  describe('catches a planted violation', () => {
    it('a detail read and an answer key', () => {
      const bad = "import { useEscapeTemplatesControllerGet } from 'x';\nconst a = lock.answer;";
      expect(violations('game/escape/host/x.tsx', bad)).toEqual([
        'answer keys',
        'call useEscapeTemplatesControllerGet',
      ]);
    });

    it('a write URL outside host-templates.ts', () => {
      const bad = "const u = getEscapeTemplatesControllerPublishUrl(id, { view: 'summary' });";
      expect(violations('routes/escape-rooms-page.tsx', bad)).toEqual([
        'call getEscapeTemplatesControllerPublishUrl',
      ]);
      expect(violations(SUMMARY_FILE, bad)).toEqual([]);
    });

    it('a write URL without the summary view', () => {
      expect(violations(SUMMARY_FILE, 'getEscapeTemplatesControllerPublishUrl(id)')).toEqual([
        "getEscapeTemplatesControllerPublishUrl without view: 'summary'",
      ]);
      expect(
        violations(SUMMARY_FILE, "getEscapeTemplatesControllerCreateSamplesUrl({ view: 'full' })"),
      ).toEqual(["getEscapeTemplatesControllerCreateSamplesUrl without view: 'summary'"]);
    });

    it('a raw template URL string', () => {
      for (const s of [
        "fetch('/escape-templates/' + id)",
        'fetch(`/api/escape-templates/${id}`)',
      ]) {
        expect(violations('game/escape/host/x.ts', s)).toEqual(['raw /escape-templates/ URL']);
      }
    });

    it('a violation in a file outside host/ that the console imports', () => {
      const dir = mkdtempSync(join(tmpdir(), 'no-answers-'));
      try {
        writeFileSync(join(dir, 'entry.tsx'), "import { helper } from './lib/helper';\n");
        mkdirSync(join(dir, 'lib'));
        writeFileSync(
          join(dir, 'lib/helper.ts'),
          "export const helper = () => fetch('/escape-templates/x');\n",
        );
        const found = graph([join(dir, 'entry.tsx')]).map((p) => relative(dir, p));
        expect(found).toEqual(['entry.tsx', join('lib', 'helper.ts')]);
        expect(
          violations('lib/helper.ts', readFileSync(join(dir, 'lib/helper.ts'), 'utf8')),
        ).toEqual(['raw /escape-templates/ URL']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
