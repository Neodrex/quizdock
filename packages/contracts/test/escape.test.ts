import { describe, expect, it } from 'vitest';
import { escapeTemplateContentSchema } from '../src/escape';

const valid = {
  title: 'Vault',
  intro: '',
  difficulty: 'standard',
  targetMinutes: 35,
  mode: 'parallel',
  roles: [],
  finale: 'Out!',
  stages: [1, 2, 3].map((n) => ({
    id: `s${n}`,
    title: `Stage ${n}`,
    intro: '',
    unlockText: '',
    clues: [],
    hints: [],
    locks: [{ id: `l${n}`, label: 'Code', kind: 'code', answer: '1234' }],
  })),
};

describe('escapeTemplateContentSchema', () => {
  it('accepts a template', () => {
    expect(escapeTemplateContentSchema.parse(valid)).toEqual(valid);
  });
  it('accepts every lock kind', () => {
    const locks = [
      { id: 'a', label: 'A', kind: 'phrase', answers: ['x'] },
      {
        id: 'b',
        label: 'B',
        kind: 'choice',
        options: [{ id: 'o1', label: 'O', image: null }],
        correct: ['o1'],
      },
      { id: 'c', label: 'C', kind: 'sequence', items: [{ id: 'i1', label: 'I' }], order: ['i1'] },
      { id: 'd', label: 'D', kind: 'combined', parts: [{ roleId: 'r', answer: 'x' }] },
    ];
    const t = { ...valid, stages: [{ ...valid.stages[0], locks }, ...valid.stages.slice(1)] };
    expect(() => escapeTemplateContentSchema.parse(t)).not.toThrow();
  });
  it('rejects an unknown lock kind and strips unknown fields', () => {
    const bad = {
      ...valid,
      stages: [{ ...valid.stages[0], locks: [{ id: 'x', label: 'X', kind: 'laser' }] }],
    };
    expect(escapeTemplateContentSchema.safeParse(bad).success).toBe(false);
    expect(escapeTemplateContentSchema.parse({ ...valid, extra: 1 })).not.toHaveProperty('extra');
  });
  it('bounds sizes so a stored template stays small', () => {
    const long = { ...valid, intro: 'x'.repeat(20_001) };
    expect(escapeTemplateContentSchema.safeParse(long).success).toBe(false);
  });
});
