/**
 * Leak checker for escape payloads (M3 plan §5): what a phone or a screen must
 * never receive. Structural and by exact value, not by substring: clue bodies
 * may name answers by design ("Key 1 word: FALCON").
 */

import { normalizeAnswer } from '@quiz-dock/contracts';
import { normalizeCode } from '../../src/escape/escape-rules';
import type { EscapeTemplate } from '../../src/escape/escape.types';

/** Keys that only answer-bearing template objects have. */
const SECRET_KEYS = new Set(['answer', 'answers', 'correct', 'order', 'parts']);

export interface LeakScope {
  /** Hint ids the receiver may see (released to its team). Default: none. */
  released?: Iterable<string>;
  /** Role ids the receiver holds: other roles' clues are leaks. Default: none. */
  roles?: Iterable<string>;
}

/**
 * Every leak found in `payload`, as readable lines (empty when clean):
 * - a key `answer`, `answers`, `correct`, `order` or `parts`, at any depth;
 * - a string equal (after normalizeAnswer, or normalizeCode for codes) to a
 *   code, phrase or combined-part answer;
 * - the text of a hint not in `released`;
 * - the body of a clue for a role not in `roles`.
 */
export function leaksIn(payload: unknown, tpl: EscapeTemplate, scope: LeakScope = {}): string[] {
  const released = new Set(scope.released ?? []);
  const roles = new Set(scope.roles ?? []);
  const answers = new Map<string, string>();
  const codes = new Map<string, string>();
  const hidden = new Map<string, string>();
  for (const stage of tpl.stages) {
    for (const lock of stage.locks) {
      if (lock.kind === 'code') {
        answers.set(normalizeAnswer(lock.answer), lock.id);
        if (normalizeCode(lock.answer)) codes.set(normalizeCode(lock.answer), lock.id);
      }
      if (lock.kind === 'phrase')
        for (const a of lock.answers) answers.set(normalizeAnswer(a), lock.id);
      if (lock.kind === 'combined') {
        for (const p of lock.parts) answers.set(normalizeAnswer(p.answer), lock.id);
      }
    }
    for (const h of stage.hints) if (!released.has(h.id)) hidden.set(h.text, `hint ${h.id}`);
    for (const c of stage.clues) {
      if (c.roleId !== null && !roles.has(c.roleId))
        hidden.set(c.body, `clue ${c.id} (role ${c.roleId})`);
    }
  }

  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const lock = answers.get(normalizeAnswer(value)) ?? codes.get(normalizeCode(value) || '\0');
      if (lock) found.push(`${path}: answer of lock ${lock}`);
      const what = hidden.get(value);
      if (what) found.push(`${path}: ${what}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (SECRET_KEYS.has(k)) found.push(`${path}.${k}: secret key`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(payload, '$');
  return found;
}

/** Every string anywhere in `value` (keys excluded). */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}
