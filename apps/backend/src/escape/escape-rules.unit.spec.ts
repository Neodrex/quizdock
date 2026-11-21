import type {
  ChoiceLock,
  CodeLock,
  EscapeTemplate,
  PhraseLock,
  SequenceLock,
} from './escape.types';
import {
  assignRoles,
  checkAnswer,
  hostUnlock,
  newTeam,
  nextHint,
  normalizeCode,
  playerView,
  submit,
  useHint,
} from './escape-rules';

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

describe('hints', () => {
  const withHints: EscapeTemplate = {
    ...tpl,
    stages: [
      {
        ...tpl.stages[0],
        hints: [
          { id: 'h1', text: 'Look up', penaltyS: 60, releaseAfterS: 300 },
          { id: 'h2', text: 'The clock', penaltyS: 120, releaseAfterS: null },
        ],
      },
      { ...tpl.stages[1], hints: [{ id: 'h3', text: 'Later', penaltyS: 30, releaseAfterS: null }] },
    ],
  };
  it('gives the stage hints in order and adds their penalty', () => {
    let t = team();
    expect(nextHint(withHints, t)?.id).toBe('h1');
    t = useHint(withHints, t, 'h1');
    expect(t).toMatchObject({ hintsUsed: ['h1'], hintPenaltyS: 60 });
    expect(nextHint(withHints, t)?.id).toBe('h2');
    t = useHint(withHints, t, 'h2');
    expect(nextHint(withHints, t)).toBeNull();
    expect(useHint(withHints, t, 'h2')).toBe(t); // used twice: no change
  });
  it('ignores hints of another stage or unknown ids', () => {
    const t = team();
    expect(useHint(withHints, t, 'h3')).toBe(t);
    expect(useHint(withHints, t, 'nope')).toBe(t);
  });
});

describe('hostUnlock', () => {
  it('solves the lock and records that the host did it', () => {
    const r = hostUnlock(tpl, team(), 'safe', 500);
    expect(r.result).toEqual({ outcome: 'lock-solved', lockId: 'safe' });
    expect(r.team.hostUnlocks).toEqual(['safe']);
    expect(r.team.solvesBy).toEqual({});
  });
  it('opens a combined lock whatever parts are in, crediting nobody', () => {
    const t = submit(
      tpl,
      team(),
      { playerId: 'p1', lockId: 'duo', roleId: 'nav', input: 'north' },
      1,
    ).team;
    const r = hostUnlock(tpl, t, 'duo', 2);
    expect(r.result).toEqual({ outcome: 'lock-solved', lockId: 'duo' });
    expect(r.team.solved).toEqual(['duo']);
    expect(r.team.solvesBy).toEqual({ p1: 1 });
    expect(hostUnlock(tpl, team(), 'duo', 3).team.solvesBy).toEqual({});
  });
  it('can clear the stage', () => {
    const t = hostUnlock(tpl, team(), 'safe', 1).team;
    const r = hostUnlock(tpl, t, 'duo', 2);
    expect(r.result).toEqual({ outcome: 'stage-cleared', stageIndex: 0 });
    expect(r.team).toMatchObject({ stageIndex: 1, hostUnlocks: ['safe', 'duo'] });
  });
  it('refuses unknown, solved and escaped', () => {
    expect(hostUnlock(tpl, team(), 'word', 1).result).toEqual({
      outcome: 'refused',
      reason: 'unknown-lock',
    });
    const t = hostUnlock(tpl, team(), 'safe', 1).team;
    expect(hostUnlock(tpl, t, 'safe', 2)).toEqual({
      team: t,
      result: { outcome: 'refused', reason: 'already-solved' },
    });
    expect(hostUnlock(tpl, { ...team(), escapedAt: 5 }, 'safe', 6).result).toEqual({
      outcome: 'refused',
      reason: 'escaped',
    });
  });
});

describe('playerView', () => {
  const tplClues: EscapeTemplate = {
    ...tpl,
    stages: [
      {
        ...tpl.stages[0],
        clues: [
          { id: 'c1', roleId: null, kind: 'text', body: 'Shared' },
          { id: 'c2', roleId: 'nav', kind: 'text', body: 'North is 1' },
          { id: 'c3', roleId: 'dec', kind: 'text', body: 'Forty-two' },
        ],
      },
      tpl.stages[1],
    ],
  };
  // Every lock kind and hints in one stage, so no secret is absent by accident.
  const tplAll: EscapeTemplate = {
    ...tplClues,
    stages: [
      {
        ...tplClues.stages[0],
        locks: [
          ...tplClues.stages[0].locks,
          {
            id: 'pick',
            label: 'Pick',
            kind: 'choice',
            options: [
              { id: 'o1', label: 'One', image: null },
              { id: 'o2', label: 'Two', image: null },
            ],
            correct: ['o2'],
          },
          {
            id: 'seq',
            label: 'Seq',
            kind: 'sequence',
            items: [
              { id: 'i3', label: 'Third' },
              { id: 'i1', label: 'First' },
              { id: 'i2', label: 'Second' },
            ],
            order: ['i3', 'i1', 'i2'],
          },
          { id: 'say', label: 'Say', kind: 'phrase', answers: ['xyzzy'] },
        ],
        hints: [
          { id: 'h1', text: 'Used hint', penaltyS: 60, releaseAfterS: null },
          { id: 'h2', text: 'Unused hint', penaltyS: 60, releaseAfterS: null },
        ],
      },
      tplClues.stages[1],
    ],
  };

  it('shows shared clues and the player role clues only', () => {
    const v = playerView(tplClues, team(), 'p1');
    expect(v.clues.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(v.roles).toEqual(['nav']);
  });
  it('never contains an answer', () => {
    const json = JSON.stringify(playerView(tplClues, team(), 'p1'));
    for (const secret of ['1234', 'north', '"42"', '"answer"', '"correct"', '"order"']) {
      expect(json).not.toContain(secret);
    }
  });
  it('never contains an answer, other roles clues or unused hints, for any lock kind', () => {
    const t = useHint(tplAll, team(), 'h1');
    for (const p of ['p1', 'p2']) {
      const json = JSON.stringify(playerView(tplAll, t, p));
      for (const secret of [
        '1234',
        'north',
        '"42"',
        'xyzzy',
        '"answer"',
        '"answers"',
        '"correct"',
        '"order"',
        '"parts"',
        'Unused hint',
        p === 'p1' ? 'Forty-two' : 'North is 1',
      ]) {
        expect(json).not.toContain(secret);
      }
      expect(json).toContain('Used hint');
    }
  });
  it('choice options in authored order; sequence items by id, not the answer order', () => {
    const v = playerView(tplAll, team(), 'p1');
    expect(v.locks.find((l) => l.id === 'pick')?.options?.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(v.locks.find((l) => l.id === 'seq')?.items?.map((i) => i.id)).toEqual([
      'i1',
      'i2',
      'i3',
    ]);
  });
  it('copies only known fields, so stray authored data cannot leak', () => {
    const leaky = structuredClone(tplAll);
    const pick = leaky.stages[0].locks[2] as ChoiceLock;
    Object.assign(pick.options[0], { isCorrect: true });
    Object.assign(leaky.stages[0].clues[0], { note: 'secret' });
    const json = JSON.stringify(playerView(leaky, team(), 'p1'));
    expect(json).not.toContain('isCorrect');
    expect(json).not.toContain('secret');
  });
  it('combined locks show only the parts the player can enter', () => {
    const v = playerView(tplClues, team(), 'p2');
    expect(v.locks.find((l) => l.id === 'duo')).toMatchObject({
      kind: 'combined',
      myParts: ['dec'],
    });
  });
});
