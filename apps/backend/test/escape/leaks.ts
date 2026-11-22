/**
 * Leak checker for escape payloads (M3 plan §5): what a phone or a screen must
 * never receive. Structural and by exact value, not by substring: clue bodies
 * may name answers by design ("Key 1 word: FALCON").
 */

import { type EscapePlayerState, normalizeAnswer } from '@quiz-dock/contracts';
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

/**
 * Leaks in what a phone or a screen `record()`ed: a state is checked against
 * its own roles, and hint texts against the hints its team was told of
 * (`escape:team-update {hint}`); screens are told of none. With `me` (the
 * phone's player id), a state's roles are the ones its team lists for `me`,
 * and a `view.roles` that differs is reported: after a role change, a player
 * sees the clues of the roles they now hold and of no role they lost.
 */
export function receivedLeaks(
  seen: [string, unknown][],
  tpl: EscapeTemplate,
  me?: string,
): string[] {
  const released = new Set<string>();
  for (const [event, p] of seen) {
    const u = p as { kind?: string; hintId?: string };
    if (event === 'escape:team-update' && u.kind === 'hint' && u.hintId) released.add(u.hintId);
  }
  return seen.flatMap(([event, p]) => {
    if (event !== 'escape:state') {
      return leaksIn(p, tpl, { released }).map((line) => `${event} ${line}`);
    }
    const s = p as EscapePlayerState;
    const shown = s.view?.roles ?? [];
    const held =
      me === undefined ? shown : (s.team?.members.find((m) => m.playerId === me)?.roles ?? []);
    const found = leaksIn(p, tpl, { released, roles: held }).map((line) => `${event} ${line}`);
    if (s.view && [...shown].sort().join() !== [...held].sort().join()) {
      found.push(`${event} view.roles ${shown.join()} but the team lists ${held.join()}`);
    }
    return found;
  });
}

/**
 * Leaks in what the host console `record()`ed (M5 owner question 1): it may read
 * every hint and every role's clues, but no answer, in any frame.
 */
export function hostLeaks(seen: [string, unknown][], tpl: EscapeTemplate): string[] {
  const scope: LeakScope = {
    released: tpl.stages.flatMap((s) => s.hints.map((h) => h.id)),
    roles: tpl.roles.map((r) => r.id),
  };
  return seen.flatMap(([event, p]) => leaksIn(p, tpl, scope).map((line) => `${event} ${line}`));
}

/** Frames only phones or the host console get (M6 §1.4). */
const NOT_FOR_SCREENS = new Set([
  'escape:state',
  'escape:team-update',
  'escape:host',
  'escape:host-team',
  'escape:outline',
  'escape:finale',
]);

/** Keys of host columns and story lines (M6 §1.4). */
const SCREEN_SECRET_KEYS = new Set(['unlockText', 'adjustMs', 'hostUnlocks', 'paidHints']);

/**
 * Leaks in what a screen `record()`ed (M6 §1.4): `leaksIn` with no role and no
 * released hint (the host's hints included), plus any frame only phones or the
 * host get, any key of a host column, a story line or a player id, and any
 * string equal to a stage's unlock text, intro or a clue body (shared ones
 * too). Nicknames are allowed (owner answer 1) and not checked.
 *
 * A `playerId` key counts in escape frames only: upstream's lobby frames
 * (`game:roster`, `player:joined`, `player:left`) give every socket of the PIN
 * room the player ids, screens included, as they do for a quiz. That is
 * GameEngine's, outside the escape files (M6 §1.3); noted in progress.md.
 */
export function screenLeaksIn(frames: [string, unknown][], tpl: EscapeTemplate): string[] {
  const texts = new Map<string, string>();
  for (const stage of tpl.stages) {
    texts.set(stage.unlockText, `unlock text of stage ${stage.id}`);
    texts.set(stage.intro, `intro of stage ${stage.id}`);
    for (const c of stage.clues) texts.set(c.body, `clue ${c.id}`);
  }
  texts.delete('');
  return frames.flatMap(([event, p]) => {
    if (NOT_FOR_SCREENS.has(event)) return [`${event}: a frame for phones or the host`];
    const found = leaksIn(p, tpl).map((line) => `${event} ${line}`);
    const escape = event.startsWith('escape:');
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') {
        const what = texts.get(value);
        if (what) found.push(`${event} ${path}: ${what}`);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (SCREEN_SECRET_KEYS.has(k) || (escape && k === 'playerId')) {
            found.push(`${event} ${path}.${k}: not for a screen`);
          }
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(p, '$');
    return found;
  });
}

/** Every typed answer of a template, as written: code, phrase and combined parts. */
export function answersOf(tpl: EscapeTemplate): string[] {
  return tpl.stages.flatMap((s) =>
    s.locks.flatMap((l) =>
      l.kind === 'code'
        ? [l.answer]
        : l.kind === 'phrase'
          ? l.answers
          : l.kind === 'combined'
            ? l.parts.map((p) => p.answer)
            : [],
    ),
  );
}
