import type { EscapeTemplate } from './escape.types';
import { newTeam } from './escape-rules';
import {
  dealPlayers,
  makeTeams,
  moveMember,
  nextTeamId,
  rolesFor,
  smallestTeam,
  teamOf,
} from './escape-teams';
import { tpl } from './fixtures';

const sizes = (teams: { members: string[] }[]) => teams.map((t) => t.members.length);

describe('nextTeamId', () => {
  it('follows the highest t<n>, t1 for none', () => {
    expect(nextTeamId([])).toBe('t1');
    expect(nextTeamId(['t1', 't2'])).toBe('t3');
    expect(nextTeamId(['t3', 't1'])).toBe('t4');
    expect(nextTeamId(['x', 't9', 'tt'])).toBe('t10');
  });
});

describe('makeTeams', () => {
  it('gives ids t1..tN and names Team 1..N', () => {
    expect(makeTeams(3)).toEqual([
      { id: 't1', name: 'Team 1', members: [] },
      { id: 't2', name: 'Team 2', members: [] },
      { id: 't3', name: 'Team 3', members: [] },
    ]);
  });

  it('uses the given names, and the default past their end', () => {
    expect(makeTeams(3, ['Owls', 'Foxes']).map((t) => t.name)).toEqual(['Owls', 'Foxes', 'Team 3']);
  });
});

describe('dealPlayers', () => {
  it('deals 7 players into 3 teams as 3, 2, 2, in join order', () => {
    const ids = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const teams = dealPlayers(makeTeams(3), ids);
    expect(sizes(teams)).toEqual([3, 2, 2]);
    expect(teams[0].members).toEqual(['p0', 'p3', 'p6']);
    expect(teams[1].members).toEqual(['p1', 'p4']);
    expect(teams[2].members).toEqual(['p2', 'p5']);
  });

  it('fills the smallest teams first and skips players already placed', () => {
    const teams = [
      { id: 't1', name: 'A', members: ['x', 'y'] },
      { id: 't2', name: 'B', members: [] },
    ];
    expect(dealPlayers(teams, ['x', 'p0', 'p1']).map((t) => t.members)).toEqual([
      ['x', 'y'],
      ['p0', 'p1'],
    ]);
  });
});

describe('smallestTeam', () => {
  const teams = [
    { id: 't1', name: 'A', members: ['a', 'b'] },
    { id: 't2', name: 'B', members: ['c'] },
    { id: 't3', name: 'C', members: ['d'] },
  ];

  it('breaks ties by team order', () => {
    expect(smallestTeam(teams)?.id).toBe('t2');
  });

  it('skips full teams, and gives null when all are at maxSize', () => {
    expect(smallestTeam(teams, 2)?.id).toBe('t2');
    expect(smallestTeam(teams, 1)).toBeNull();
  });

  it('treats 0 as no cap', () => {
    expect(smallestTeam(teams, 0)?.id).toBe('t2');
  });

  it('gives null without teams', () => {
    expect(smallestTeam([])).toBeNull();
  });
});

describe('moveMember and teamOf', () => {
  const teams = [
    { id: 't1', name: 'A', members: ['a', 'b'] },
    { id: 't2', name: 'B', members: ['c'] },
  ];

  it('removes the player from the old team and appends to the new one', () => {
    const moved = moveMember(teams, 'a', 't2');
    expect(moved.map((t) => t.members)).toEqual([['b'], ['c', 'a']]);
    expect(teams[0].members).toEqual(['a', 'b']);
  });

  it('is a no-op for the same team', () => {
    expect(moveMember(teams, 'a', 't1')).toBe(teams);
  });

  it('unassigns with null, and adds an unassigned player', () => {
    expect(moveMember(teams, 'c', null).map((t) => t.members)).toEqual([['a', 'b'], []]);
    expect(moveMember(teams, 'z', 't1').map((t) => t.members)).toEqual([['a', 'b', 'z'], ['c']]);
  });

  it('leaves the teams unchanged for an unknown team', () => {
    expect(moveMember(teams, 'a', 'nope')).toBe(teams);
  });

  it('finds the team of a player, or null', () => {
    expect(teamOf(teams, 'c')?.id).toBe('t2');
    expect(teamOf(teams, 'z')).toBeNull();
  });
});

describe('rolesFor', () => {
  const three: EscapeTemplate = {
    ...tpl,
    roles: [
      { id: 'r1', name: 'One', description: '' },
      { id: 'r2', name: 'Two', description: '' },
      { id: 'r3', name: 'Three', description: '' },
    ],
  };
  const team = newTeam(three, 'a', 'A', ['p1', 'p2', 'p3']);

  it('gives one role each to three connected members and three roles', () => {
    expect(rolesFor(three, team, new Set(['p1', 'p2', 'p3']))).toEqual({
      p1: ['r1'],
      p2: ['r2'],
      p3: ['r3'],
    });
  });

  it("gives a disconnected member's role to the least-loaded connected member", () => {
    const loaded = { ...team, roles: { p1: ['r1', 'r3'], p2: ['r2'], p3: [] } };
    const fresh = { ...team, roles: { p1: ['r1'], p2: ['r2'], p3: ['r3'] } };
    expect(rolesFor(three, fresh, new Set(['p1', 'p2']))).toEqual({ p1: ['r1', 'r3'], p2: ['r2'] });
    expect(rolesFor(three, loaded, new Set(['p2', 'p3']))).toEqual({
      p2: ['r2', 'r3'],
      p3: ['r1'],
    });
  });

  it('keeps members in team order, whatever the set order', () => {
    expect(Object.keys(rolesFor(three, team, new Set(['p3', 'p1'])))).toEqual(['p1', 'p3']);
  });

  it('gives {} in parallel mode', () => {
    const parallel: EscapeTemplate = { ...three, mode: 'parallel', roles: [] };
    expect(rolesFor(parallel, team, new Set(['p1', 'p2', 'p3']))).toEqual({});
  });
});
