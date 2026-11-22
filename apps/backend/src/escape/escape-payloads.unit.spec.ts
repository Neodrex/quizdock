import { leaksIn, stringsIn } from '../../test/escape/leaks';
import type { EscapeRun, EscapeSnapshot, TeamRecord } from './escape-live.types';
import {
  announceOf,
  boardOf,
  finaleOf,
  hintUpdateOf,
  hostStateOf,
  hostTeamOf,
  outlineOf,
  playerStateOf,
  type RoomPlayer,
  type RunView,
  submitUpdateOf,
  timeUpOf,
} from './escape-payloads';
import { awards, newTeam, nextHint, rankTeams, submit, useHint } from './escape-rules';
import type { EscapeTemplate, TeamState } from './escape.types';
import { vaultHeist } from './samples';

const tpl: EscapeTemplate = { ...vaultHeist, id: 'vh' };
const NOW = 1_000_000;

const snap: EscapeSnapshot = { templateId: 'vh', version: 3, template: tpl, takenAt: 0 };
const running: EscapeRun = {
  phase: 'running',
  formation: 'auto',
  maxSize: 0,
  teamIds: ['a', 'b'],
  clock: {
    startedAt: NOW - 120_000,
    pausedAt: 0,
    pausedMs: 0,
    endedElapsedMs: null,
    limitMs: 2_400_000,
  },
};

const players: RoomPlayer[] = [
  { playerId: 'p1', nickname: 'Ann', avatar: 'ann', connected: true },
  { playerId: 'p2', nickname: 'Bob', avatar: null, connected: true },
  { playerId: 'p3', nickname: 'Cy', avatar: 'cy', connected: false },
  { playerId: 'q1', nickname: 'Dee', avatar: 'dee', connected: true },
  { playerId: 'x', nickname: 'Lone', avatar: 'lone', connected: true },
];

const rec = (team: TeamState, extra: Partial<TeamRecord> = {}): TeamRecord => ({
  team,
  lastProgressAt: 0,
  stuck: false,
  timedOut: false,
  ...extra,
});

/** Three roles, one each: p1 hacker, p2 safecracker, p3 lookout. */
const teamA = newTeam(tpl, 'a', 'Crew A', ['p1', 'p2', 'p3']);
const teamB = newTeam(tpl, 'b', 'Crew B', ['q1']);

const view = (a: TeamState = teamA, run: EscapeRun = running): RunView => ({
  id: 'g1',
  snap,
  run,
  teams: [rec(a), rec(teamB)],
  players,
  now: NOW,
});

/** Every text of the stages, titles excepted: what a screen must never show. */
function stageContents(t: EscapeTemplate): Set<string> {
  const out = new Set<string>();
  for (const s of t.stages) {
    out.add(s.intro);
    out.add(s.unlockText);
    for (const c of s.clues) out.add(c.body);
    for (const h of s.hints) out.add(h.text);
    for (const l of s.locks) {
      out.add(l.label);
      if (l.kind === 'code') out.add(l.answer);
      if (l.kind === 'phrase') l.answers.forEach((a) => out.add(a));
      if (l.kind === 'choice') l.options.forEach((o) => out.add(o.label));
      if (l.kind === 'sequence') l.items.forEach((i) => out.add(i.label));
      if (l.kind === 'combined') l.parts.forEach((p) => out.add(p.answer));
    }
  }
  out.delete('');
  return out;
}

describe('playerStateOf', () => {
  it('leaks nothing, for every stage and every member of a three-role team', () => {
    expect(teamA.roles).toEqual({ p1: ['hacker'], p2: ['safecracker'], p3: ['lookout'] });
    for (let stageIndex = 0; stageIndex < tpl.stages.length; stageIndex++) {
      const team = { ...teamA, stageIndex };
      for (const id of team.members) {
        const state = playerStateOf(view(team), id);
        expect(state.view?.stageIndex).toBe(stageIndex);
        expect(leaksIn(state, tpl, { roles: team.roles[id] })).toEqual([]);
      }
    }
  });

  it('leaks nothing with a combined lock half entered', () => {
    const team = { ...teamA, stageIndex: 1 };
    const { team: half } = submit(
      tpl,
      team,
      { playerId: 'p1', lockId: 'security-switch', roleId: 'hacker', input: 'falcon' },
      5_000,
    );
    expect(half.parts['security-switch']).toEqual(['hacker']);
    for (const id of half.members) {
      expect(leaksIn(playerStateOf(view(half), id), tpl, { roles: half.roles[id] })).toEqual([]);
    }
  });

  it('shows a used hint, and not the next one', () => {
    const used = useHint(tpl, teamA, 'lobby-h1');
    const state = playerStateOf(view(used), 'p1');
    expect(state.view?.hints).toEqual([{ id: 'lobby-h1', text: tpl.stages[0].hints[0].text }]);
    expect(leaksIn(state, tpl, { roles: ['hacker'], released: used.hintsUsed })).toEqual([]);
    expect(stringsIn(state)).not.toContain(tpl.stages[0].hints[1].text);
  });

  it("gives a player only their roles' clues and the shared ones", () => {
    const team = { ...teamA, stageIndex: 1 };
    const ids = (pid: string) => playerStateOf(view(team), pid).view?.clues.map((c) => c.id);
    expect(ids('p1')).toEqual(['security-shared', 'security-hacker']);
    expect(ids('p2')).toEqual(['security-shared', 'security-safecracker']);
    expect(ids('p3')).toEqual(['security-shared', 'security-lookout']);
  });

  it("the checker catches another role's clue and an unreleased hint", () => {
    const used = { ...useHint(tpl, teamA, 'lobby-h1'), stageIndex: 0 };
    const lookout = playerStateOf(view(used), 'p3');
    expect(leaksIn(lookout, tpl, { roles: ['hacker'], released: used.hintsUsed })).toEqual([
      expect.stringContaining('clue lobby-guard'),
    ]);
    expect(leaksIn(lookout, tpl, { roles: ['lookout'] })).toEqual([
      expect.stringContaining('hint lobby-h1'),
    ]);
  });

  it('gives the next hint as id and penalty only', () => {
    const state = playerStateOf(view(), 'p1');
    expect(state.nextHint).toEqual({ id: 'lobby-h1', penaltyS: 30 });
    expect(Object.keys(state.nextHint!).sort()).toEqual(['id', 'penaltyS']);
    const done = { ...teamA, escapedAt: 9_000 };
    expect(playerStateOf(view(done), 'p1').nextHint).toBeNull();
  });

  it('describes the team, its members and its clock', () => {
    const state = playerStateOf(view(), 'p2');
    expect(state.gameId).toBe('g1');
    expect(state.phase).toBe('running');
    expect(state.clock).toEqual({
      serverNow: NOW,
      paused: false,
      elapsedMs: 120_000,
      limitMs: 2_400_000,
    });
    expect(state.team).toMatchObject({
      id: 'a',
      name: 'Crew A',
      stageIndex: 0,
      stageCount: 4,
      escaped: false,
      timedOut: false,
      hintPenaltyS: 0,
      remainingMs: 2_280_000,
      deadlineAt: NOW + 2_280_000,
    });
    expect(state.team?.members).toEqual([
      { playerId: 'p1', nickname: 'Ann', avatar: 'ann', connected: true, roles: ['hacker'] },
      { playerId: 'p2', nickname: 'Bob', avatar: null, connected: true, roles: ['safecracker'] },
      { playerId: 'p3', nickname: 'Cy', avatar: 'cy', connected: false, roles: ['lookout'] },
    ]);
    expect(state.roles.map((r) => r.id)).toEqual(['hacker', 'safecracker', 'lookout']);
    expect(state.formation.teams).toEqual([
      { id: 'a', name: 'Crew A', memberCount: 3 },
      { id: 'b', name: 'Crew B', memberCount: 1 },
    ]);
  });

  it('has no view before the start or without a team', () => {
    const forming: EscapeRun = {
      ...running,
      phase: 'forming',
      clock: { ...running.clock, startedAt: 0 },
    };
    const before = playerStateOf(view(teamA, forming), 'p1');
    expect(before.view).toBeNull();
    expect(before.nextHint).toBeNull();
    expect(before.team?.deadlineAt).toBeNull();
    const lone = playerStateOf(view(), 'x');
    expect(lone.team).toBeNull();
    expect(lone.view).toBeNull();
    expect(leaksIn(lone, tpl)).toEqual([]);
  });

  it('has a null deadline while paused', () => {
    const paused: EscapeRun = { ...running, clock: { ...running.clock, pausedAt: NOW - 20_000 } };
    const state = playerStateOf(view(teamA, paused), 'p1');
    expect(state.clock.paused).toBe(true);
    expect(state.team?.deadlineAt).toBeNull();
    expect(state.team?.remainingMs).toBe(2_300_000);
  });
});

describe('boardOf', () => {
  it('holds no clue body, lock label, option, answer or hint text', () => {
    const contents = stageContents(tpl);
    for (let stageIndex = 0; stageIndex < tpl.stages.length; stageIndex++) {
      const team = useHint(tpl, { ...teamA, stageIndex }, tpl.stages[stageIndex].hints[0].id);
      const board = boardOf(view(team));
      expect(stringsIn(board).filter((s) => contents.has(s))).toEqual([]);
      expect(leaksIn(board, tpl)).toEqual([]);
    }
  });

  it('counts teams, members and unassigned players', () => {
    const board = boardOf(view());
    expect(board.title).toBe('Vault Heist');
    expect(board.unassigned).toBe(1);
    expect(board.teams[0]).toEqual({
      id: 'a',
      name: 'Crew A',
      memberCount: 3,
      connectedCount: 2,
      stageIndex: 0,
      stageCount: 4,
      stageTitle: 'The Lobby',
      locksSolved: 0,
      locksTotal: 2,
      hintsUsed: 0,
      escaped: false,
      timedOut: false,
      remainingMs: 2_280_000,
      deadlineAt: NOW + 2_280_000,
    });
  });

  it('announces with names and counts only', () => {
    const cleared = { ...teamA, stageIndex: 1, stageClearedAt: [60_000] };
    expect(announceOf('stage-cleared', cleared)).toEqual({
      kind: 'stage-cleared',
      teamId: 'a',
      teamName: 'Crew A',
      stageIndex: 0,
    });
    expect(announceOf('hint', cleared).stageIndex).toBe(1);
  });
});

describe('host payloads', () => {
  it('gives the host the team detail', () => {
    const team = { ...teamA, stageIndex: 1, stageClearedAt: [60_000], hintsUsed: ['lobby-h1'] };
    const host = hostTeamOf(view(team), rec(team, { lastProgressAt: 60_000, stuck: true }));
    expect(host).toMatchObject({
      id: 'a',
      hintIds: ['lobby-h1'],
      lastProgressAt: 60_000,
      stuck: true,
      timeOnStageMs: 60_000,
      solved: [],
      partsDone: {},
    });
    expect(host.members).toHaveLength(3);
  });

  it('lists unassigned players and the template version', () => {
    const state = hostStateOf(view());
    expect(state.unassigned).toEqual([{ playerId: 'x', nickname: 'Lone', connected: true }]);
    expect(state.templateVersion).toBe(3);
    expect(state.teams.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('outline carries the answers (positive control of the checker)', () => {
    const outline = outlineOf(snap);
    expect(outline.template).toEqual(tpl);
    expect(outline.template).not.toBe(tpl);
    const leaks = leaksIn(outline, tpl);
    expect(leaks).toEqual(expect.arrayContaining([expect.stringContaining('secret key')]));
    expect(leaks).toEqual(
      expect.arrayContaining([expect.stringContaining('answer of lock lobby-door')]),
    );
  });

  it('outline drops keys the template type does not have', () => {
    const extra = {
      ...tpl,
      secret: 'x',
      stages: [{ ...tpl.stages[0], note: 'y' }],
    } as unknown as EscapeTemplate;
    const out = outlineOf({ ...snap, template: extra });
    expect(stringsIn(out)).not.toContain('x');
    expect(stringsIn(out)).not.toContain('y');
  });
});

describe('finaleOf', () => {
  it('orders teams as rankTeams and copies awards', () => {
    const fast = {
      ...teamB,
      escapedAt: 900_000,
      stageIndex: 3,
      stageClearedAt: [1, 2, 3, 900_000],
    };
    const slow = { ...teamA, stageIndex: 2, stageClearedAt: [1, 2] };
    const v: RunView = {
      ...view(),
      run: { ...running, phase: 'finale' },
      teams: [rec(slow), rec(fast)],
    };
    const finale = finaleOf(v, 'g1');
    expect(finale.gameId).toBe('g1');
    const ranked = rankTeams([slow, fast]);
    expect(finale.ranking.map((r) => r.teamId)).toEqual(ranked.map((r) => r.team.id));
    expect(finale.ranking.map((r) => r.place)).toEqual([1, 2]);
    expect(finale.awards).toEqual(awards([slow, fast]));
    expect(finale.ranking[0]).toMatchObject({
      teamId: 'b',
      scoreMs: 900_000,
      escaped: true,
      stagesCleared: 4,
      members: ['Dee'],
    });
    expect(finale.ranking[1]).toMatchObject({
      escaped: false,
      stagesCleared: 2,
      members: ['Ann', 'Bob', 'Cy'],
    });
    expect(finale.title).toBe('Vault Heist');
    expect(finale.finale).toBe(tpl.finale);
    expect(leaksIn(finale, tpl)).toEqual([]);
  });

  it('counts free and paid hints apart', () => {
    let t = useHint(tpl, teamA, 'lobby-h1', { free: true });
    t = useHint(tpl, t, nextHint(tpl, t)!.id);
    const finale = finaleOf({ ...view(), teams: [rec(t)] }, 'g1');
    expect(finale.ranking[0]).toMatchObject({ hintsUsed: 2, paidHints: 1, hintPenaltyS: 60 });
  });
});

describe('team updates', () => {
  it('maps each submit outcome to its update, with the cleared stage’s unlock text', () => {
    expect(submitUpdateOf(tpl, 'a', { outcome: 'wrong' }, 'p1')).toEqual({
      teamId: 'a',
      kind: 'wrong',
      by: 'p1',
    });
    expect(
      submitUpdateOf(
        tpl,
        'a',
        { outcome: 'part-accepted', lockId: 'security-switch' },
        'p1',
        'hacker',
      ),
    ).toEqual({
      teamId: 'a',
      kind: 'part-accepted',
      lockId: 'security-switch',
      roleId: 'hacker',
      by: 'p1',
    });
    expect(
      submitUpdateOf(tpl, 'a', { outcome: 'lock-solved', lockId: 'lobby-door' }, null),
    ).toEqual({ teamId: 'a', kind: 'lock-solved', lockId: 'lobby-door', by: null });
    expect(submitUpdateOf(tpl, 'a', { outcome: 'stage-cleared', stageIndex: 1 }, 'p2')).toEqual({
      teamId: 'a',
      kind: 'stage-cleared',
      stageIndex: 1,
      unlockText: tpl.stages[1].unlockText,
      by: 'p2',
    });
    expect(submitUpdateOf(tpl, 'a', { outcome: 'escaped' }, 'p2')).toEqual({
      teamId: 'a',
      kind: 'escaped',
      unlockText: tpl.stages[3].unlockText,
      by: 'p2',
    });
    expect(
      submitUpdateOf(tpl, 'a', { outcome: 'refused', reason: 'already-solved' }, 'p1'),
    ).toBeNull();
  });

  it('hint and time-up updates carry ids only', () => {
    const hint = hintUpdateOf('a', 'lobby-h1', 'timer');
    expect(hint).toEqual({ teamId: 'a', kind: 'hint', hintId: 'lobby-h1', source: 'timer' });
    expect(leaksIn(hint, tpl)).toEqual([]);
    expect(timeUpOf('a')).toEqual({ teamId: 'a', kind: 'time-up' });
  });
});
