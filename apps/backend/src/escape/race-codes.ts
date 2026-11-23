/**
 * Team codes of a team race (M7 §1.7, owner question 2): four letters a friend
 * types in. No I or O, so nobody reads a 1 or a 0. Pure.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 4;
/** Players a team of a race holds at most. */
export const RACE_TEAM_MAX = 3;
/** Wrong codes one player may type in a window before it has to wait. */
export const CODE_ATTEMPTS_MAX = 5;
export const CODE_ATTEMPTS_WINDOW_S = 60;

const VALID = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** A code as typed (any case, spaces anywhere), or null when it cannot be one. */
export function normaliseCode(input: string): string | null {
  const code = input.replace(/\s+/g, '').toUpperCase();
  return VALID.test(code) ? code : null;
}

/** Draws before newCode gives up (a run holds at most a few hundred of 331 776 codes). */
export const CODE_TRIES_MAX = 1000;

/** A code no team of the run has. `random` in [0, 1), for the tests. */
export function newCode(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (let tries = 0; tries < CODE_TRIES_MAX; tries++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
    }
    if (!taken.has(code)) return code;
  }
  throw new Error('no free team code');
}
