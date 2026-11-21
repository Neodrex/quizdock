import { normalizeAnswer } from '@quiz-dock/contracts';
import type { Lock, LockInput } from './escape.types';

/** Codes compare on letters and digits only, upper case: "a-17 b" is "A17B". */
export function normalizeCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Same elements, no duplicates in `a`, order ignored. */
const sameSet = (a: string[], b: string[]) => {
  const set = new Set(a);
  return set.size === a.length && a.length === b.length && b.every((x) => set.has(x));
};

/** Whether `input` opens `lock`. Combined locks are checked per part by `submit`. */
export function checkAnswer(lock: Lock, input: LockInput): boolean {
  switch (lock.kind) {
    case 'code':
      return typeof input === 'string' && normalizeCode(input) === normalizeCode(lock.answer);
    case 'phrase':
      return (
        typeof input === 'string' &&
        lock.answers.some((a) => normalizeAnswer(a) === normalizeAnswer(input))
      );
    case 'choice':
      return Array.isArray(input) && sameSet(input, lock.correct);
    case 'sequence':
      return (
        Array.isArray(input) &&
        input.length === lock.order.length &&
        input.every((id, i) => id === lock.order[i])
      );
    case 'combined':
      return false;
  }
}

/**
 * Round-robin over the connected members. Fewer members than roles: some hold
 * several. More: some roles are shared. Called again when someone leaves, so a
 * role is never left without a player.
 */
export function assignRoles(memberIds: string[], roleIds: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!memberIds.length) return out;
  for (const id of memberIds) out[id] = [];
  const slots = Math.max(memberIds.length, roleIds.length);
  for (let i = 0; i < slots; i++) {
    const member = memberIds[i % memberIds.length];
    const role = roleIds[i % roleIds.length];
    if (role && !out[member].includes(role)) out[member].push(role);
  }
  return out;
}
