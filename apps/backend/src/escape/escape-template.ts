import { normalizeAnswer } from '@quiz-dock/contracts';
import type { EscapeTemplate, Lock } from './escape.types';
import { normalizeCode } from './escape-rules';

const MIN_STAGES = 3;
const MAX_STAGES = 8;
const MAX_LOCKS = 4;

/** Problems with one lock, without the stage prefix. */
function lockProblems(lock: Lock, t: EscapeTemplate, roleIds: Set<string>): string[] {
  const out: string[] = [];
  const name = `lock "${lock.label}"`;
  switch (lock.kind) {
    case 'code':
      if (!normalizeCode(lock.answer)) out.push(`${name} has no answer`);
      break;
    case 'phrase':
      if (!lock.answers.length || lock.answers.some((a) => !normalizeAnswer(a))) {
        out.push(`${name} has no answer`);
      }
      break;
    case 'choice': {
      const options = new Set(lock.options.map((o) => o.id));
      if (lock.options.length < 2) out.push(`${name}: choice needs at least 2 options`);
      if (options.size !== lock.options.length) out.push(`${name}: duplicate option id`);
      // A repeated correct id can never be matched by a set of distinct picks.
      if (new Set(lock.correct).size !== lock.correct.length) {
        out.push(`${name}: duplicate correct id`);
      }
      if (!lock.correct.length || lock.correct.some((id) => !options.has(id))) {
        out.push(`${name}: choice needs correct options from its own options`);
      }
      break;
    }
    case 'sequence': {
      if (lock.items.length < 2) out.push(`${name}: sequence needs at least 2 items`);
      const items = new Set(lock.items.map((i) => i.id));
      const order = new Set(lock.order);
      const permutation =
        items.size === lock.items.length &&
        order.size === lock.order.length &&
        order.size === items.size &&
        lock.order.every((id) => items.has(id));
      if (!permutation) out.push(`${name}: sequence order must use each item exactly once`);
      break;
    }
    case 'combined': {
      if (t.mode !== 'roles') out.push(`${name}: combined locks need roles mode`);
      const parts = lock.parts.map((p) => p.roleId);
      if (new Set(parts).size !== parts.length || parts.length < 2) {
        out.push(`${name}: combined lock needs at least 2 roles, one part each`);
      }
      for (const p of lock.parts) {
        if (!roleIds.has(p.roleId)) out.push(`${name}: part for unknown role "${p.roleId}"`);
        if (!normalizeAnswer(p.answer)) out.push(`${name}: part "${p.roleId}" has no answer`);
      }
      break;
    }
  }
  return out;
}

/** Everything wrong with an authored template; empty when it can be run. */
export function validateTemplate(t: EscapeTemplate): string[] {
  const out: string[] = [];
  if (!t.title.trim()) out.push('The template needs a title.');
  if (!(t.targetMinutes >= 5 && t.targetMinutes <= 180)) {
    out.push('The target time must be 5 to 180 minutes.');
  }
  if (t.stages.length < MIN_STAGES) out.push(`A template needs at least ${MIN_STAGES} stages.`);
  if (t.stages.length > MAX_STAGES) out.push(`A template has at most ${MAX_STAGES} stages.`);

  const roleIds = new Set(t.roles.map((r) => r.id));
  if (t.mode === 'roles' && (t.roles.length < 2 || t.roles.length > 5)) {
    out.push('Roles mode needs 2 to 5 roles.');
  }
  if (roleIds.size !== t.roles.length) out.push('Roles have a duplicate id.');

  const seen = new Set<string>();
  const dup = (id: string) => {
    const again = seen.has(id);
    seen.add(id);
    return again;
  };

  for (const s of t.stages) {
    const stage = (problem: string) => out.push(`Stage "${s.title}": ${problem}`);
    if (dup(s.id)) stage(`duplicate id "${s.id}"`);
    if (!s.locks.length) stage('has no lock');
    if (s.locks.length > MAX_LOCKS) stage(`at most ${MAX_LOCKS} locks`);
    for (const lock of s.locks) {
      if (dup(lock.id)) stage(`duplicate id "${lock.id}"`);
      lockProblems(lock, t, roleIds).forEach(stage);
    }
    for (const c of s.clues) {
      if (dup(c.id)) stage(`duplicate id "${c.id}"`);
      if (c.roleId !== null && !roleIds.has(c.roleId)) {
        stage(`clue for unknown role "${c.roleId}"`);
      }
    }
    for (const h of s.hints) {
      if (dup(h.id)) stage(`duplicate id "${h.id}"`);
      if (!(h.penaltyS >= 0)) stage(`hint penalty must not be negative`);
      if (h.releaseAfterS !== null && !(h.releaseAfterS >= 0)) {
        stage(`hint release time must not be negative`);
      }
    }
  }
  return out;
}
