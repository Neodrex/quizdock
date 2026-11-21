import type {
  ChoiceLock,
  CodeLock,
  EscapeTemplate,
  PhraseLock,
  SequenceLock,
} from './escape.types';
import { assignRoles, checkAnswer, newTeam, normalizeCode, submit } from './escape-rules';

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

const roles = ['nav', 'dec', 'arc'];

describe('assignRoles', () => {
  it('one role each when the numbers match', () => {
    expect(assignRoles(['p1', 'p2', 'p3'], roles)).toEqual({
      p1: ['nav'],
      p2: ['dec'],
      p3: ['arc'],
    });
  });
  it('fewer players than roles: roles are merged', () => {
    expect(assignRoles(['p1', 'p2'], roles)).toEqual({ p1: ['nav', 'arc'], p2: ['dec'] });
  });
  it('more players than roles: roles are shared', () => {
    expect(assignRoles(['p1', 'p2', 'p3', 'p4'], roles)).toEqual({
      p1: ['nav'],
      p2: ['dec'],
      p3: ['arc'],
      p4: ['nav'],
    });
  });
  it('nobody connected: nobody holds anything', () => {
    expect(assignRoles([], roles)).toEqual({});
  });
});

const tpl: EscapeTemplate = {
  id: 't',
  title: 'T',
  intro: '',
  difficulty: 'standard',
  targetMinutes: 35,
  mode: 'roles',
  roles: [
    { id: 'nav', name: 'Navigator', description: '' },
    { id: 'dec', name: 'Decoder', description: '' },
  ],
  stages: [
    {
      id: 's1',
      title: 'One',
      intro: '',
      clues: [],
      hints: [],
      unlockText: '',
      locks: [
        { id: 'safe', label: 'Safe', kind: 'code', answer: '1234' },
        {
          id: 'duo',
          label: 'Duo',
          kind: 'combined',
          parts: [
            { roleId: 'nav', answer: 'north' },
            { roleId: 'dec', answer: '42' },
          ],
        },
      ],
    },
    {
      id: 's2',
      title: 'Two',
      intro: '',
      clues: [],
      hints: [],
      unlockText: '',
      locks: [{ id: 'word', label: 'Word', kind: 'phrase', answers: ['out'] }],
    },
  ],
  finale: '',
};

const team = () => newTeam(tpl, 'A', 'Alpha', ['p1', 'p2']);

describe('submit', () => {
  it('starts on stage 0 with roles assigned', () => {
    expect(team()).toMatchObject({
      stageIndex: 0,
      roles: { p1: ['nav'], p2: ['dec'] },
      escapedAt: null,
    });
  });

  it('counts a wrong answer', () => {
    const r = submit(tpl, team(), { playerId: 'p1', lockId: 'safe', input: '0000' }, 1000);
    expect(r.result).toEqual({ outcome: 'wrong' });
    expect(r.team.wrong).toBe(1);
  });

  it('solves a lock and credits the player', () => {
    const r = submit(tpl, team(), { playerId: 'p2', lockId: 'safe', input: '1234' }, 1000);
    expect(r.result).toEqual({ outcome: 'lock-solved', lockId: 'safe' });
    expect(r.team.solved).toEqual(['safe']);
    expect(r.team.solvesBy).toEqual({ p2: 1 });
  });

  it('combined lock: each role enters only its own part', () => {
    let t = team();
    expect(
      submit(tpl, t, { playerId: 'p1', lockId: 'duo', roleId: 'dec', input: '42' }, 1).result,
    ).toEqual({ outcome: 'refused', reason: 'not-your-part' });
    let r = submit(tpl, t, { playerId: 'p1', lockId: 'duo', roleId: 'nav', input: 'North' }, 1);
    expect(r.result).toEqual({ outcome: 'part-accepted', lockId: 'duo' });
    t = r.team;
    r = submit(tpl, t, { playerId: 'p2', lockId: 'duo', roleId: 'dec', input: '42' }, 2);
    expect(r.result).toEqual({ outcome: 'lock-solved', lockId: 'duo' });
  });

  it('combined lock: a part already entered is refused and not credited again', () => {
    const t = submit(
      tpl,
      team(),
      { playerId: 'p1', lockId: 'duo', roleId: 'nav', input: 'north' },
      1,
    ).team;
    const r = submit(tpl, t, { playerId: 'p1', lockId: 'duo', roleId: 'nav', input: 'north' }, 2);
    expect(r.result).toEqual({ outcome: 'refused', reason: 'already-solved' });
    expect(r.team.solvesBy).toEqual({ p1: 1 });
  });

  it('clears the stage when every lock is solved, then escapes after the last', () => {
    let t = submit(tpl, team(), { playerId: 'p1', lockId: 'safe', input: '1234' }, 1000).team;
    t = submit(tpl, t, { playerId: 'p1', lockId: 'duo', roleId: 'nav', input: 'north' }, 2000).team;
    const cleared = submit(
      tpl,
      t,
      { playerId: 'p2', lockId: 'duo', roleId: 'dec', input: '42' },
      3000,
    );
    expect(cleared.result).toEqual({ outcome: 'stage-cleared', stageIndex: 0 });
    expect(cleared.team).toMatchObject({
      stageIndex: 1,
      solved: [],
      parts: {},
      stageClearedAt: [3000],
    });
    const out = submit(tpl, cleared.team, { playerId: 'p2', lockId: 'word', input: 'OUT' }, 9000);
    expect(out.result).toEqual({ outcome: 'escaped' });
    expect(out.team.escapedAt).toBe(9000);
  });

  it('refuses locks of other stages, solved locks and escaped teams', () => {
    expect(submit(tpl, team(), { playerId: 'p1', lockId: 'word', input: 'out' }, 1).result).toEqual(
      { outcome: 'refused', reason: 'unknown-lock' },
    );
    const t = submit(tpl, team(), { playerId: 'p1', lockId: 'safe', input: '1234' }, 1).team;
    expect(submit(tpl, t, { playerId: 'p1', lockId: 'safe', input: '1234' }, 2).result).toEqual({
      outcome: 'refused',
      reason: 'already-solved',
    });
    const escaped = { ...team(), escapedAt: 5 };
    expect(
      submit(tpl, escaped, { playerId: 'p1', lockId: 'safe', input: '1234' }, 6).result,
    ).toEqual({ outcome: 'refused', reason: 'escaped' });
  });

  it('never mutates the team it is given', () => {
    let t = team();
    for (const s of [
      { playerId: 'p1', lockId: 'safe', input: '0000' },
      { playerId: 'p1', lockId: 'safe', input: '1234' },
      { playerId: 'p1', lockId: 'duo', roleId: 'nav', input: 'north' },
      { playerId: 'p2', lockId: 'duo', roleId: 'dec', input: '42' },
      { playerId: 'p2', lockId: 'word', input: 'out' },
    ]) {
      const before = structuredClone(t);
      const r = submit(tpl, t, s, 1);
      expect(t).toEqual(before);
      t = r.team;
    }
    expect(t.escapedAt).toBe(1);
  });
});
