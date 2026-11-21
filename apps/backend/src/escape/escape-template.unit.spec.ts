import type { EscapeTemplate, Lock, Stage } from './escape.types';
import { validateTemplate } from './escape-template';
import { tpl } from './fixtures';

const stage = (over: Partial<Stage> = {}): Stage => ({ ...tpl.stages[1], ...over });
const withStage = (over: Partial<Stage>): EscapeTemplate => ({
  ...tpl,
  stages: [tpl.stages[0], stage(over), tpl.stages[2]],
});
const withLock = (lock: Lock) => withStage({ locks: [lock] });
const expectError = (t: EscapeTemplate, text: string) =>
  expect(validateTemplate(t)).toEqual(expect.arrayContaining([expect.stringContaining(text)]));

describe('validateTemplate', () => {
  it('accepts a valid template', () => {
    expect(validateTemplate(tpl)).toEqual([]);
  });

  it('needs at least 3 stages', () => {
    expectError({ ...tpl, stages: [] }, 'at least 3 stages');
    expectError({ ...tpl, stages: tpl.stages.slice(0, 2) }, 'at least 3 stages');
  });

  it('allows at most 8 stages', () => {
    const stages = Array.from({ length: 9 }, (_, i) =>
      stage({ id: `s${i}`, locks: [{ id: `l${i}`, label: 'L', kind: 'code', answer: '1' }] }),
    );
    expectError({ ...tpl, stages }, 'at most 8 stages');
  });

  it('needs a lock in every stage, with the stage title in the message', () => {
    expect(validateTemplate(withStage({ locks: [] }))).toContain('Stage "Two": has no lock');
  });

  it('allows at most 4 locks per stage', () => {
    const locks = Array.from(
      { length: 5 },
      (_, i): Lock => ({ id: `l${i}`, label: 'L', kind: 'code', answer: '1' }),
    );
    expectError(withStage({ locks }), 'at most 4 locks');
  });

  it('rejects duplicate ids across stages, locks, clues and hints', () => {
    expectError(withStage({ id: 's1' }), 'duplicate id');
    expectError(withLock({ id: 'safe', label: 'L', kind: 'code', answer: '1' }), 'duplicate id');
    expectError(
      withStage({
        clues: [{ id: 'word', roleId: null, kind: 'text', body: '' }],
      }),
      'duplicate id',
    );
    expectError(
      withStage({ hints: [{ id: 's2', text: '', penaltyS: 0, releaseAfterS: null }] }),
      'duplicate id',
    );
  });

  it('roles mode needs 2 to 5 roles', () => {
    expectError({ ...tpl, roles: [tpl.roles[0]] }, '2 to 5 roles');
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, name: 'R', description: '' }));
    expectError({ ...tpl, roles: six }, '2 to 5 roles');
  });

  it('rejects combined locks in parallel mode', () => {
    expectError({ ...tpl, mode: 'parallel', roles: [] }, 'combined locks need roles mode');
  });

  it('rejects clues and combined parts naming an unknown role', () => {
    expectError(
      withStage({ clues: [{ id: 'c1', roleId: 'ghost', kind: 'text', body: '' }] }),
      'unknown role',
    );
    expectError(
      withLock({
        id: 'duo2',
        label: 'D',
        kind: 'combined',
        parts: [
          { roleId: 'nav', answer: 'a' },
          { roleId: 'ghost', answer: 'b' },
        ],
      }),
      'unknown role',
    );
  });

  it('combined locks cover at least 2 distinct roles, each with an answer', () => {
    const combined = (parts: { roleId: string; answer: string }[]): Lock => ({
      id: 'duo2',
      label: 'D',
      kind: 'combined',
      parts,
    });
    expectError(withLock(combined([{ roleId: 'nav', answer: 'a' }])), 'at least 2 roles');
    expectError(
      withLock(
        combined([
          { roleId: 'nav', answer: 'a' },
          { roleId: 'nav', answer: 'b' },
        ]),
      ),
      'at least 2 roles',
    );
    expectError(
      withLock(
        combined([
          { roleId: 'nav', answer: 'a' },
          { roleId: 'dec', answer: ' ' },
        ]),
      ),
      'no answer',
    );
  });

  it('choice locks need correct ids that are options', () => {
    const options = [
      { id: 'o1', label: 'A', image: null },
      { id: 'o2', label: 'B', image: null },
    ];
    expectError(withLock({ id: 'c', label: 'C', kind: 'choice', options, correct: [] }), 'choice');
    expectError(
      withLock({ id: 'c', label: 'C', kind: 'choice', options, correct: ['o3'] }),
      'choice',
    );
  });

  it('choice locks need at least 2 options and no duplicate ids', () => {
    const o = (id: string) => ({ id, label: id, image: null });
    const choice = (options: { id: string; label: string; image: null }[], correct: string[]) =>
      withLock({ id: 'c', label: 'C', kind: 'choice', options, correct });
    expectError(choice([o('o1')], ['o1']), 'at least 2 options');
    expectError(choice([o('o1'), o('o1')], ['o1']), 'duplicate option id');
    expectError(choice([o('o1'), o('o2')], ['o1', 'o1']), 'duplicate correct id');
    expect(validateTemplate(choice([o('o1'), o('o2')], ['o2']))).toEqual([]);
  });

  it('sequence locks need at least 2 items', () => {
    expectError(
      withLock({
        id: 'q',
        label: 'Q',
        kind: 'sequence',
        items: [{ id: 'i1', label: 'A' }],
        order: ['i1'],
      }),
      'at least 2 items',
    );
  });

  it('sequence locks need an order that is a permutation of the items', () => {
    const items = [
      { id: 'i1', label: 'A' },
      { id: 'i2', label: 'B' },
    ];
    for (const order of [['i1'], ['i1', 'i1'], ['i1', 'i3'], ['i1', 'i2', 'i3']]) {
      expectError(withLock({ id: 'q', label: 'Q', kind: 'sequence', items, order }), 'sequence');
    }
  });

  it('code and phrase locks need an answer', () => {
    expectError(withLock({ id: 'k', label: 'K', kind: 'code', answer: '' }), 'no answer');
    expectError(withLock({ id: 'k', label: 'K', kind: 'code', answer: ' - ' }), 'no answer');
    expectError(withLock({ id: 'p', label: 'P', kind: 'phrase', answers: [] }), 'no answer');
    expectError(
      withLock({ id: 'p', label: 'P', kind: 'phrase', answers: ['ok', ' '] }),
      'no answer',
    );
  });

  it('code answers use letters, digits, spaces and punctuation only', () => {
    const msg = 'code answers may use letters, digits, spaces and punctuation only';
    expectError(withLock({ id: 'k', label: 'K', kind: 'code', answer: 'кот' }), msg);
    expectError(withLock({ id: 'k', label: 'K', kind: 'code', answer: '12🔑' }), msg);
    expect(
      validateTemplate(withLock({ id: 'k', label: 'K', kind: 'code', answer: 'Été-12 (b)!' })),
    ).toEqual([]);
  });

  it('hint penalties and release times are not negative', () => {
    expectError(
      withStage({ hints: [{ id: 'h', text: '', penaltyS: -1, releaseAfterS: null }] }),
      'penalty',
    );
    expectError(
      withStage({ hints: [{ id: 'h', text: '', penaltyS: 0, releaseAfterS: -5 }] }),
      'release',
    );
    expect(
      validateTemplate(
        withStage({ hints: [{ id: 'h', text: '', penaltyS: 0, releaseAfterS: 0 }] }),
      ),
    ).toEqual([]);
  });

  it('target time is 5 to 180 minutes', () => {
    expectError({ ...tpl, targetMinutes: 4 }, '5 to 180 minutes');
    expectError({ ...tpl, targetMinutes: 181 }, '5 to 180 minutes');
    expect(validateTemplate({ ...tpl, targetMinutes: 5 })).toEqual([]);
    expect(validateTemplate({ ...tpl, targetMinutes: 180 })).toEqual([]);
  });

  it('needs a title', () => {
    expectError({ ...tpl, title: '  ' }, 'title');
  });
});
