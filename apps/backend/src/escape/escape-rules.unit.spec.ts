import type {
  ChoiceLock,
  CodeLock,
  EscapeTemplate,
  PhraseLock,
  SequenceLock,
  TeamState,
} from './escape.types';
import {
  assignRoles,
  awards,
  checkAnswer,
  hostUnlock,
  newTeam,
  nextHint,
  normalizeCode,
  playerView,
  rankTeams,
  reassignRoles,
  submit,
  useHint,
} from './escape-rules';
import { tpl } from './fixtures';

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
  it('strips diacritics first', () => {
    expect(normalizeCode('été')).toBe('ETE');
  });
});

describe('checkAnswer', () => {
  it('code: ignores case, spaces and punctuation', () => {
    expect(checkAnswer(code, 'a17b')).toBe(true);
    expect(checkAnswer(code, 'A18B')).toBe(false);
  });
  it('code: accents ignored, not dropped', () => {
    const accented = (answer: string): CodeLock => ({ ...code, answer });
    expect(checkAnswer(accented('ÉTÉ'), 'ete')).toBe(true);
    expect(checkAnswer(accented('ÉTÉ'), 'T')).toBe(false);
    expect(checkAnswer(accented('Ä12'), 'a12')).toBe(true);
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

describe('reassignRoles', () => {
  const r3 = ['r1', 'r2', 'r3'];
  const start = assignRoles(['a', 'b', 'c'], r3);

  it('keeps current roles; an orphaned role goes to the least loaded, earlier first', () => {
    expect(reassignRoles(start, ['b', 'c'], r3)).toEqual({ b: ['r2', 'r1'], c: ['r3'] });
  });
  it('a rejoining member shares a role of the most loaded holder', () => {
    const left = reassignRoles(start, ['b', 'c'], r3);
    expect(reassignRoles(left, ['b', 'c', 'a'], r3)).toEqual({
      b: ['r2', 'r1'],
      c: ['r3'],
      a: ['r1'],
    });
  });
  it('a new member shares the first role when everyone holds as many', () => {
    expect(reassignRoles(start, ['a', 'b', 'c', 'd'], r3)).toEqual({
      a: ['r1'],
      b: ['r2'],
      c: ['r3'],
      d: ['r1'],
    });
  });
  it('nobody connected: nobody holds anything', () => {
    expect(reassignRoles(start, [], r3)).toEqual({});
  });
  it('every role keeps a connected holder while anyone is connected', () => {
    const steps = [['b', 'c'], ['c'], ['c', 'a'], ['a', 'd', 'e'], ['e'], [], ['b', 'a'], ['a']];
    let roles = start;
    for (const connected of steps) {
      roles = reassignRoles(roles, connected, r3);
      expect(Object.keys(roles).sort()).toEqual([...connected].sort());
      for (const m of connected) expect(roles[m].length).toBeGreaterThan(0);
      if (connected.length) {
        for (const r of r3) expect(Object.values(roles).flat()).toContain(r);
      }
    }
  });
});

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
    const next = submit(tpl, cleared.team, { playerId: 'p2', lockId: 'word', input: 'OUT' }, 6000);
    expect(next.result).toEqual({ outcome: 'stage-cleared', stageIndex: 1 });
    const out = submit(tpl, next.team, { playerId: 'p1', lockId: 'exit', input: '99' }, 9000);
    expect(out.result).toEqual({ outcome: 'escaped' });
    expect(out.team).toMatchObject({ escapedAt: 9000, stageClearedAt: [3000, 6000, 9000] });
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
      { playerId: 'p1', lockId: 'exit', input: '99' },
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
      tpl.stages[2],
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
      tpl.stages[2],
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
      tplClues.stages[2],
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
  it('choice options in authored order', () => {
    const v = playerView(tplAll, team(), 'p1');
    expect(v.locks.find((l) => l.id === 'pick')?.options?.map((o) => o.id)).toEqual(['o1', 'o2']);
  });
  describe('sequence items', () => {
    const withSeq = (ids: string[], order: string[] = ids): EscapeTemplate => ({
      ...tpl,
      stages: [
        {
          ...tpl.stages[0],
          locks: [
            {
              id: 'seq',
              label: 'Seq',
              kind: 'sequence',
              items: ids.map((id) => ({ id, label: id.toUpperCase() })),
              order,
            },
          ],
        },
      ],
    });
    const shown = (t: EscapeTemplate, teamId: string) =>
      playerView(t, newTeam(t, teamId, teamId, ['p1']), 'p1').locks[0].items?.map((i) => i.id);
    const ids = ['a', 'b', 'c', 'd'];
    const teamIds = Array.from({ length: 20 }, (_, i) => `team-${i}`);

    it('is stable for a team', () => {
      expect(shown(withSeq(ids), 'team-x')).toEqual(shown(withSeq(ids), 'team-x'));
    });
    it('differs between teams', () => {
      const orders = new Set(teamIds.map((id) => JSON.stringify(shown(withSeq(ids), id))));
      expect(orders.size).toBeGreaterThan(1);
    });
    it('does not depend on the authored order', () => {
      for (const id of teamIds) {
        expect(shown(withSeq(['d', 'b', 'a', 'c'], ids), id)).toEqual(shown(withSeq(ids), id));
      }
    });
    it('is not forced away from the answer (that would leak it)', () => {
      for (const id of teamIds) {
        const hashed = shown(withSeq(ids, ['z']), id) ?? [];
        expect(shown(withSeq(ids, hashed), id)).toEqual(hashed);
      }
    });
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

const t = (over: Partial<TeamState>): TeamState => ({ ...team(), ...over });

describe('rankTeams', () => {
  it('escaped teams first by time plus hint penalty, then by stages and time', () => {
    const fast = t({
      id: 'fast',
      escapedAt: 600_000,
      hintPenaltyS: 120,
      stageClearedAt: [1, 600_000],
    }); // 12 min with penalty
    const clean = t({
      id: 'clean',
      escapedAt: 660_000,
      hintPenaltyS: 0,
      stageClearedAt: [1, 660_000],
    }); // 11 min
    const stuck = t({ id: 'stuck', stageIndex: 1, stageClearedAt: [300_000] });
    const slow = t({ id: 'slow', stageIndex: 1, stageClearedAt: [400_000] });
    const none = t({ id: 'none' });
    expect(rankTeams([none, slow, fast, stuck, clean]).map((r) => r.team.id)).toEqual([
      'clean',
      'fast',
      'stuck',
      'slow',
      'none',
    ]);
  });

  it('breaks ties by team id, whatever the input order', () => {
    const x = t({ id: 'x', escapedAt: 500_000 });
    const y = t({ id: 'y', escapedAt: 440_000, hintPenaltyS: 60 });
    const p = t({ id: 'p' });
    const q = t({ id: 'q' });
    const ids = (teams: TeamState[]) => rankTeams(teams).map((r) => r.team.id);
    expect(ids([y, q, x, p])).toEqual(['x', 'y', 'p', 'q']);
    expect(ids([p, x, q, y])).toEqual(['x', 'y', 'p', 'q']);
    expect(rankTeams([y, x]).map((r) => [r.place, r.scoreMs])).toEqual([
      [1, 500_000],
      [2, 500_000],
    ]);
  });
});

describe('awards', () => {
  it('names fastest, fewest hints, teamwork and photo finish', () => {
    const a = t({ id: 'a', escapedAt: 500_000, hintsUsed: ['h1'], solvesBy: { p1: 4, p2: 0 } });
    const b = t({ id: 'b', escapedAt: 503_000, hintsUsed: [], solvesBy: { p1: 2, p2: 2 } });
    expect(awards([a, b])).toEqual({
      fastest: 'a',
      fewestHints: 'b',
      teamwork: 'b',
      photoFinish: ['a', 'b'],
    });
  });

  it('photo finish is the closest consecutive pair', () => {
    const a = t({ id: 'a', escapedAt: 100_000 });
    const b = t({ id: 'b', escapedAt: 200_000 });
    const c = t({ id: 'c', escapedAt: 205_000 });
    const d = t({ id: 'd', escapedAt: 300_000 });
    expect(awards([d, c, b, a]).photoFinish).toEqual(['b', 'c']);
  });

  it('teamwork: one member or no solves never beats genuine spread; ties by id', () => {
    const solo = t({ id: 'a', members: ['p1'], solvesBy: { p1: 5 } });
    const idle = t({ id: 'b', solvesBy: {} });
    const spread = t({ id: 'z', solvesBy: { p1: 3, p2: 1 } });
    expect(awards([solo, idle, spread]).teamwork).toBe('z');
    const even1 = t({ id: 'm', solvesBy: { p1: 1, p2: 1 } });
    const even2 = t({ id: 'k', solvesBy: { p1: 2, p2: 2 } });
    expect(awards([even1, even2]).teamwork).toBe('k');
    expect(awards([even2, even1]).teamwork).toBe('k');
  });

  it('null fields when nobody escaped or nobody solved anything', () => {
    expect(awards([t({ id: 'a' }), t({ id: 'b' })])).toEqual({
      fastest: null,
      fewestHints: null,
      teamwork: null,
      photoFinish: null,
    });
    expect(awards([])).toEqual({
      fastest: null,
      fewestHints: null,
      teamwork: null,
      photoFinish: null,
    });
  });
});
