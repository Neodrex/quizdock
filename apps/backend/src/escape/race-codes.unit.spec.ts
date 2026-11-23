import { CODE_ALPHABET, CODE_LENGTH, newCode, normaliseCode } from './race-codes';

describe('race codes (M7 §1.7)', () => {
  it('are four letters of the alphabet, without I or O', () => {
    expect(CODE_ALPHABET).not.toMatch(/[IO]/);
    expect(CODE_ALPHABET).toHaveLength(24);
    for (let i = 0; i < 200; i++) {
      const code = newCode(new Set());
      expect(code).toHaveLength(CODE_LENGTH);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('are unique within the run', () => {
    // A random source that gives AAAA first, then BBBB.
    const draws = [0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.05, 0.05, 0.05];
    const random = () => draws.shift() ?? 0.5;
    expect(newCode(new Set(['AAAA']), random)).toBe('BBBB');
    const taken = new Set<string>();
    for (let i = 0; i < 500; i++) taken.add(newCode(taken));
    expect(taken.size).toBe(500);
  });

  it('accept lower case and spaces, and nothing else', () => {
    expect(normaliseCode(' abcd ')).toBe('ABCD');
    expect(normaliseCode('a b c d')).toBe('ABCD');
    expect(normaliseCode('ABCD')).toBe('ABCD');
    for (const bad of ['', 'ABC', 'ABCDE', 'ABIO', 'AB0D', 'AB-D', 'ÀBCD']) {
      expect(normaliseCode(bad)).toBeNull();
    }
  });
});
