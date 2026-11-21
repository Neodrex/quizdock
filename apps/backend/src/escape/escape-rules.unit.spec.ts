import type { ChoiceLock, CodeLock, PhraseLock, SequenceLock } from './escape.types';
import { checkAnswer, normalizeCode } from './escape-rules';

const code: CodeLock = { id: 'l1', label: 'Safe', kind: 'code', answer: 'A-17 b' };
const phrase: PhraseLock = {
  id: 'l2',
  label: 'Word',
  kind: 'phrase',
  answers: ['Crème brûlée', 'flan'],
};
const choice: ChoiceLock = {
  id: 'l3',
  label: 'Who',
  kind: 'choice',
  options: [
    { id: 'a', label: 'A', image: null },
    { id: 'b', label: 'B', image: null },
    { id: 'c', label: 'C', image: null },
  ],
  correct: ['a', 'c'],
};
const sequence: SequenceLock = {
  id: 'l4',
  label: 'Order',
  kind: 'sequence',
  items: [
    { id: 'x', label: 'X' },
    { id: 'y', label: 'Y' },
    { id: 'z', label: 'Z' },
  ],
  order: ['z', 'x', 'y'],
};

describe('normalizeCode', () => {
  it('keeps letters and digits, upper case', () => {
    expect(normalizeCode(' a-17 b ')).toBe('A17B');
  });
});

describe('checkAnswer', () => {
  it('code: ignores case, spaces and punctuation', () => {
    expect(checkAnswer(code, 'a17b')).toBe(true);
    expect(checkAnswer(code, 'A18B')).toBe(false);
  });
  it('phrase: any accepted answer, accents and case ignored', () => {
    expect(checkAnswer(phrase, '  creme   BRULEE ')).toBe(true);
    expect(checkAnswer(phrase, 'Flan')).toBe(true);
    expect(checkAnswer(phrase, 'cake')).toBe(false);
  });
  it('choice: exactly the correct set, any order', () => {
    expect(checkAnswer(choice, ['c', 'a'])).toBe(true);
    expect(checkAnswer(choice, ['a'])).toBe(false);
    expect(checkAnswer(choice, ['a', 'b', 'c'])).toBe(false);
    expect(checkAnswer(choice, ['a', 'a'])).toBe(false);
  });
  it('sequence: exact order', () => {
    expect(checkAnswer(sequence, ['z', 'x', 'y'])).toBe(true);
    expect(checkAnswer(sequence, ['x', 'y', 'z'])).toBe(false);
  });
  it('rejects the wrong input shape', () => {
    expect(checkAnswer(code, ['a17b'])).toBe(false);
    expect(checkAnswer(choice, 'a')).toBe(false);
  });
});
