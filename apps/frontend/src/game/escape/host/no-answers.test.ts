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

/** Where a `/` starts a regex literal rather than a division: after these, or a keyword. */
const BEFORE_REGEX = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
]);
const REGEX_KEYWORDS = /\b(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * The code without its comments (line and block). A small scanner: `//` or `/*` inside
 * a string, a template literal or a regex literal is code, not a comment.
 */
function code(text: string): string {
  let out = '';
  let i = 0;
  // Open template literals: the `${` depth of each, innermost last.
  const templates: number[] = [];
  const last = () => out.trimEnd().slice(-1);
  const quoted = (q: string) => {
    const start = i++;
    while (i < text.length && text[i] !== q && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    i++;
    out += text.slice(start, i);
  };
  /** A template literal's text from `i`, up to its end or a `${`. */
  const templateText = () => {
    const start = i;
    while (i < text.length && text[i] !== '`' && !(text[i] === '$' && text[i + 1] === '{')) {
      i += text[i] === '\\' ? 2 : 1;
    }
    if (text[i] === '`') {
      i++;
      out += text.slice(start, i);
    } else {
      i += 2;
      out += text.slice(start, i);
      templates.push(0);
    }
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === "'" || c === '"') {
      quoted(c);
    } else if (c === '`') {
      out += c;
      i++;
      templateText();
    } else if (c === '/' && (BEFORE_REGEX.has(last()) || REGEX_KEYWORDS.test(out.trimEnd()))) {
      const start = i++;
      let inClass = false;
      while (i < text.length && text[i] !== '\n' && (inClass || text[i] !== '/')) {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        i++;
      }
      i++;
      out += text.slice(start, i);
    } else if (templates.length && (c === '{' || c === '}')) {
      out += c;
      i++;
      if (c === '{') templates[templates.length - 1]++;
      else if (templates[templates.length - 1] > 0) templates[templates.length - 1]--;
      else {
        templates.pop();
        templateText();
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

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

/** Source files a specifier may name: as written, a `.js` one's TypeScript file, an index. */
const CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** The local files `file` imports or re-exports (relative and `@/` paths, `root` = `src`). */
function importsOf(file: string, root: string): string[] {
  const text = code(readFileSync(file, 'utf8'));
  const specs = [
    ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ].map((m) => m[1]);
  const out: string[] = [];
  for (const spec of specs) {
    const base = spec.startsWith('@/')
      ? join(root, spec.slice(2))
      : spec.startsWith('.')
        ? resolve(dirname(file), spec)
        : null;
    if (!base) continue;
    // ESM style: `./x.js` names `./x.ts` (or `.tsx`).
    const bases = /\.jsx?$/.test(base) ? [base, base.replace(/\.jsx?$/, '')] : [base];
    const hit = bases
      .flatMap((b) => CANDIDATES.map((ext) => b + ext))
      .find((p) => existsSync(p) && statSync(p).isFile() && /\.tsx?$/.test(p));
    if (hit) out.push(hit);
  }
  return out;
}

/**
 * Every local file reachable from the entries; generated API files are not walked.
 * `root`: what `@/` stands for.
 */
function graph(entries: string[], root = src): string[] {
  const seen = new Set<string>();
  const todo = [...entries];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (f.includes(`${join('api', 'generated')}`)) continue;
    todo.push(...importsOf(f, root));
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
    // `//` and `/*` inside strings, templates and regexes are code.
    for (const kept of [
      "const u = 'http://x'; lock.answer;",
      'const u = "a // b"; lock.answer;',
      'const u = `x // ${a ? `y /* ${b} */` : 1} // z`; lock.answer;',
      'const re = /[\'"]\\/\\//g; lock.answer;',
      'const a = b / c; lock.answer; // d',
    ]) {
      expect(code(kept)).toContain('lock.answer');
    }
    expect(code("x('//'); y; // the answer")).toBe("x('//'); y; ");
    expect(violations('game/escape/host/x.ts', "const u = 'http://x'; lock.answer;")).toEqual([
      'answer keys',
    ]);
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
        // Every way in: a relative path, a `.js` specifier, `@/`, a folder's index, `export *`.
        writeFileSync(
          join(dir, 'entry.tsx'),
          [
            "import { helper } from './lib/helper';",
            "import { esm } from './lib/esm.js';",
            "import { alias } from '@/lib/alias';",
            "import { indexed } from './folder';",
            '',
          ].join('\n'),
        );
        mkdirSync(join(dir, 'lib'));
        mkdirSync(join(dir, 'folder'));
        writeFileSync(
          join(dir, 'lib/helper.ts'),
          "export const helper = () => fetch('/escape-templates/x');\n",
        );
        writeFileSync(join(dir, 'lib/esm.ts'), 'export const esm = 1;\n');
        writeFileSync(join(dir, 'lib/alias.ts'), 'export const alias = 1;\n');
        writeFileSync(join(dir, 'folder/index.ts'), "export * from './deep';\n");
        writeFileSync(join(dir, 'folder/deep.tsx'), 'export const indexed = 1;\n');
        const found = graph([join(dir, 'entry.tsx')], dir)
          .map((p) => relative(dir, p))
          .sort();
        expect(found).toEqual(
          [
            'entry.tsx',
            join('folder', 'deep.tsx'),
            join('folder', 'index.ts'),
            join('lib', 'alias.ts'),
            join('lib', 'esm.ts'),
            join('lib', 'helper.ts'),
          ].sort(),
        );
        expect(
          violations('lib/helper.ts', readFileSync(join(dir, 'lib/helper.ts'), 'utf8')),
        ).toEqual(['raw /escape-templates/ URL']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
