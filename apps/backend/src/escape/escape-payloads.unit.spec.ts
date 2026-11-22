import { leaksIn, stringsIn } from '../../test/escape/leaks';
import type { EscapeFinale } from '@quiz-dock/contracts';
import type { EscapeRun, EscapeSnapshot, TeamRecord } from './escape-live.types';
import {
  announceOf,
  boardOf,
  finaleOf,
  hintUpdateOf,
  hostStateOf,
  hostTeamOf,
  hostOutlineOf,
  playerStateOf,
  type RoomPlayer,
  type RunView,
  screenFinaleOf,
  submitUpdateOf,
  timeUpOf,
} from './escape-payloads';
import {
  adjustTime,
  awards,
  hashOrder,
  hostUnlock,
  newTeam,
  nextHint,
  rankTeams,
  submit,
  useHint,
} from './escape-rules';
import type { EscapeTemplate, Same, TeamState } from './escape.types';
import { lostLibrary, vaultHeist } from './samples';

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
      escapedMs: null,
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

  it('gives an escaped team its run time at the escape, which later states keep', () => {
    const done = { ...teamA, escapedAt: 90_000 };
    const state = playerStateOf(view(done), 'p1');
    expect(state.team).toMatchObject({ escaped: true, escapedMs: 90_000, deadlineAt: null });
    expect(state.clock.elapsedMs).toBe(120_000);
    expect(leaksIn(state, tpl, { roles: done.roles.p1 })).toEqual([]);
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
      escapedAtMs: null,
      timedOut: false,
      remainingMs: 2_280_000,
      deadlineAt: NOW + 2_280_000,
    });
  });

  it('gives an escaped team its escape run time, extra time left out (the live places)', () => {
    const escaped: TeamState = { ...teamA, escapedAt: 900_000, adjustMs: 120_000 };
    expect(boardOf(view(escaped)).teams[0]).toMatchObject({ escaped: true, escapedAtMs: 900_000 });
  });

  it('says the run and how teams form (M6 Task 6.2)', () => {
    const forming: EscapeRun = { ...running, phase: 'forming', formation: 'self', maxSize: 4 };
    expect(boardOf(view(teamA, forming))).toMatchObject({
      gameId: 'g1',
      formation: { mode: 'self', maxSize: 4 },
    });
    expect(boardOf(view()).formation).toEqual({ mode: 'auto', maxSize: null });
    expect(boardOf(view()).gameId).toBe('g1');
  });

  it('lists the forming roster by nickname, in join order, and nothing once running', () => {
    const forming: EscapeRun = { ...running, phase: 'forming' };
    const board = boardOf(view(teamA, forming));
    expect(board.roster).toEqual([
      { teamId: 'a', nickname: 'Ann', connected: true },
      { teamId: 'a', nickname: 'Bob', connected: true },
      { teamId: 'a', nickname: 'Cy', connected: false },
      { teamId: 'b', nickname: 'Dee', connected: true },
      { teamId: null, nickname: 'Lone', connected: true },
    ]);
    const keys = keysIn(board);
    for (const k of ['playerId', 'roles', 'avatar']) expect(keys).not.toContain(k);
    expect(stringsIn(board)).not.toContain('ann');
    expect(boardOf(view()).roster).toEqual([]);
    expect(boardOf(view(teamA, { ...running, phase: 'finale' })).roster).toEqual([]);
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
    const team = {
      ...teamA,
      stageIndex: 1,
      stageClearedAt: [60_000],
      hintsUsed: ['lobby-h1', 'lobby-h2'],
      paidHints: ['lobby-h2'],
    };
    const host = hostTeamOf(view(team), rec(team, { lastProgressAt: 60_000, stuck: true }));
    expect(host).toMatchObject({
      id: 'a',
      hintIds: ['lobby-h1', 'lobby-h2'],
      // Which hints cost their penalty, so the console shows it after a reload.
      paidHintIds: ['lobby-h2'],
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
    // The run's id: the host record's key for escape:results after the room closed.
    expect(state.gameId).toBe(view().id);
    expect(state.teams.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('the template itself trips the checker (positive control)', () => {
    const leaks = leaksIn(tpl, tpl);
    expect(leaks).toEqual(expect.arrayContaining([expect.stringContaining('secret key')]));
    expect(leaks).toEqual(
      expect.arrayContaining([expect.stringContaining('answer of lock lobby-door')]),
    );
  });
});

describe('hostOutlineOf (owner question 1: no answers to the host)', () => {
  const secret = new Set(['answer', 'answers', 'correct', 'order', 'parts']);
  const keysIn = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(keysIn);
    if (value && typeof value === 'object') {
      return Object.entries(value).flatMap(([k, v]) => [k, ...keysIn(v)]);
    }
    return [];
  };

  it.each([
    ['Vault Heist', vaultHeist],
    ['Lost Library', lostLibrary],
  ])('%s: no answer key at any depth, and no answer value', (_name, content) => {
    const t: EscapeTemplate = { ...content, id: 's' };
    const outline = hostOutlineOf({ ...snap, template: t }, 'g1');
    expect(keysIn(outline).filter((k) => secret.has(k))).toEqual([]);
    // Every hint and clue may show (the host's view): only answers count as leaks.
    const all = {
      released: t.stages.flatMap((s) => s.hints.map((h) => h.id)),
      roles: t.roles.map((r) => r.id),
    };
    expect(leaksIn(outline, t, all)).toEqual([]);
  });

  it('keeps what the host needs: locks, part roles, labels, hints and unlock texts', () => {
    const outline = hostOutlineOf(snap, 'g1');
    expect(outline).toMatchObject({
      templateId: 'vh',
      version: 3,
      title: tpl.title,
      intro: tpl.intro,
      mode: tpl.mode,
      difficulty: tpl.difficulty,
      targetMinutes: tpl.targetMinutes,
      roles: tpl.roles,
    });
    expect(outline.stages).toHaveLength(tpl.stages.length);
    for (const [i, stage] of tpl.stages.entries()) {
      const out = outline.stages[i];
      expect(out).toMatchObject({
        id: stage.id,
        title: stage.title,
        intro: stage.intro,
        unlockText: stage.unlockText,
        clues: stage.clues,
        hints: stage.hints,
      });
      for (const [j, lock] of stage.locks.entries()) {
        const got = out.locks[j];
        expect(got).toMatchObject({ id: lock.id, label: lock.label, kind: lock.kind });
        if (lock.kind === 'combined') {
          expect(got.partRoles).toEqual(lock.parts.map((p) => p.roleId));
        }
        if (lock.kind === 'choice') expect(got.options).toEqual(lock.options);
        if (lock.kind === 'sequence')
          expect(got.items).toEqual(hashOrder(lock.items, `g1:${lock.id}`));
      }
    }
    const kinds = tpl.stages.flatMap((s) => s.locks.map((l) => l.kind));
    expect(new Set(kinds)).toEqual(new Set(['code', 'phrase', 'choice', 'sequence', 'combined']));
  });

  it('sends sequence items in a per-run hash order, not as authored (solution order)', () => {
    // An author who wrote the items in solution order, with ids and labels in order too.
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i + 1}`,
      label: `Step ${i + 1}`,
    }));
    const ordered: EscapeTemplate = {
      ...tpl,
      stages: [
        {
          ...tpl.stages[0],
          locks: [
            {
              id: 'seq',
              label: 'In order',
              kind: 'sequence',
              items,
              order: items.map((i) => i.id),
            },
          ],
        },
      ],
    };
    const sent = (gameId: string) =>
      hostOutlineOf({ ...snap, template: ordered }, gameId).stages[0].locks[0].items!;
    const solution = items.map((i) => i.id).join();
    expect(
      sent('g1')
        .map((i) => i.id)
        .join(),
    ).not.toBe(solution);
    expect(sent('g1')).toEqual(hashOrder(items, 'g1:seq'));
    // Stable for a run (a reload sees the same order), and not one fixed order across runs.
    expect(sent('g1')).toEqual(sent('g1'));
    const runs = new Set(
      ['g1', 'g2', 'g3', 'g4', 'g5'].map((g) =>
        sent(g)
          .map((i) => i.id)
          .join(),
      ),
    );
    expect(runs.size).toBeGreaterThan(1);
    // Never a sort by id or label: both were authored in order.
    expect([...runs]).not.toContain(solution);
    expect(new Set(sent('g1').map((i) => i.id))).toEqual(new Set(items.map((i) => i.id)));
    // By chance only (1 in 720 for six items): plain FNV-1a gave it one seed in eight.
    const hits = Array.from({ length: 500 }, (_, g) => sent(`run-${g}`))
      .map((o) => o.map((i) => i.id).join())
      .filter((o) => o === solution).length;
    expect(hits).toBeLessThanOrEqual(5);
  });

  it('copies, and drops keys the template type does not have', () => {
    const extra = {
      ...tpl,
      secret: 'x',
      stages: [{ ...tpl.stages[0], note: 'y' }],
    } as unknown as EscapeTemplate;
    const out = hostOutlineOf({ ...snap, template: extra }, 'g1');
    expect(stringsIn(out)).not.toContain('x');
    expect(stringsIn(out)).not.toContain('y');
    expect(out.roles).not.toBe(tpl.roles);
  });

  it('has exactly the host outline type', () => {
    interface Expected {
      templateId: string;
      version: number;
      title: string;
      intro: string;
      mode: 'roles' | 'parallel';
      difficulty: 'standard' | 'hard';
      targetMinutes: number;
      roles: { id: string; name: string; description: string }[];
      stages: {
        id: string;
        title: string;
        intro: string;
        unlockText: string;
        locks: {
          id: string;
          label: string;
          kind: 'code' | 'phrase' | 'choice' | 'sequence' | 'combined';
          partRoles?: string[];
          options?: { id: string; label: string; image: string | null }[];
          items?: { id: string; label: string }[];
        }[];
        clues: {
          id: string;
          roleId: string | null;
          kind: 'text' | 'image' | 'audio' | 'document';
          body: string;
        }[];
        hints: { id: string; text: string; penaltyS: number; releaseAfterS: number | null }[];
      }[];
    }
    const same: Same<ReturnType<typeof hostOutlineOf>, Expected> = true;
    expect(same).toBe(true);
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

/** Every key of `value`, at any depth. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysIn(v)]);
  }
  return [];
}

describe('screenFinaleOf (M6 §1.4: no host columns on a screen)', () => {
  /** b escaped with a paid hint, a host unlock and extra time; a timed out. */
  const finaleView = (): RunView => {
    let fast = useHint(tpl, teamB, 'lobby-h1');
    fast = adjustTime(hostUnlock(tpl, fast, tpl.stages[0].locks[0].id, 1_000).team, 60_000);
    fast = { ...fast, escapedAt: 900_000, stageIndex: 3, stageClearedAt: [1, 2, 3, 900_000] };
    const slow = { ...teamA, stageIndex: 2, stageClearedAt: [10, 20] };
    return {
      ...view(),
      run: { ...running, phase: 'finale' },
      teams: [rec(slow, { timedOut: true }), rec(fast)],
    };
  };

  it('copies the ranking, split times, hints and nicknames, and adds what the replay needs', () => {
    const v = finaleView();
    const finale = finaleOf(v, 'g1');
    const screen = screenFinaleOf(finale, v);
    expect(screen.gameId).toBe('g1');
    expect(screen.title).toBe('Vault Heist');
    expect(screen.finale).toBe(tpl.finale);
    expect(screen.limitMs).toBe(2_400_000);
    expect(screen.stages).toEqual(tpl.stages.map((s) => ({ title: s.title })));
    expect(screen.awards).toEqual(finale.awards);
    expect(screen.ranking).toEqual(
      finale.ranking.map((r) => ({
        teamId: r.teamId,
        name: r.name,
        place: r.place,
        scoreMs: r.scoreMs,
        escaped: r.escaped,
        timedOut: r.teamId === 'a',
        stagesCleared: r.stagesCleared,
        stageClearedAt: r.stageClearedAt,
        hintsUsed: r.hintsUsed,
        hintPenaltyS: r.hintPenaltyS,
        members: r.members,
      })),
    );
    expect(screen.ranking[0]).toMatchObject({ teamId: 'b', members: ['Dee'], hintPenaltyS: 30 });
    expect(screen.ranking[1]).toMatchObject({ members: ['Ann', 'Bob', 'Cy'], timedOut: true });
    expect(screen.ranking[0].stageClearedAt).not.toBe(finale.ranking[0].stageClearedAt);
    expect(screen.ranking[0].members).not.toBe(finale.ranking[0].members);
    expect(leaksIn(screen, tpl)).toEqual([]);
  });

  it("carries the run's real end, so the replay stops where the run did", () => {
    const v = finaleView();
    const finale = finaleOf(v, 'g1');
    const ended = { ...v, run: { ...v.run, clock: { ...v.run.clock, endedElapsedMs: 1_234_000 } } };
    expect(screenFinaleOf(finale, ended).endedMs).toBe(1_234_000);
    expect(screenFinaleOf(finale, v).endedMs).toBeNull();
  });

  it('has no host column and no player id, at any depth', () => {
    const v = finaleView();
    const finale = finaleOf(v, 'g1');
    expect(finale.ranking[0]).toMatchObject({ paidHints: 1, hostUnlocks: 1, adjustMs: 60_000 });
    const keys = keysIn(JSON.parse(JSON.stringify(screenFinaleOf(finale, v))));
    for (const k of ['adjustMs', 'hostUnlocks', 'paidHints', 'playerId', 'unlockText']) {
      expect(keys).not.toContain(k);
    }
    expect(stringsIn(screenFinaleOf(finale, v))).not.toContain(tpl.stages[0].unlockText);
  });

  it('drops extra keys a stored finale may carry', () => {
    const v = finaleView();
    const finale = finaleOf(v, 'g1');
    const extra = {
      ...finale,
      secret: 'x',
      ranking: finale.ranking.map((r) => ({ ...r, playerIds: ['p1'] })),
    } as EscapeFinale;
    const out = screenFinaleOf(extra, v);
    expect(stringsIn(out)).not.toContain('x');
    expect(keysIn(out)).not.toContain('playerIds');
  });

  it('has exactly the screen finale type', () => {
    interface Expected {
      gameId: string;
      title: string;
      finale: string;
      limitMs: number;
      endedMs: number | null;
      stages: { title: string }[];
      ranking: {
        teamId: string;
        name: string;
        place: number;
        scoreMs: number | null;
        escaped: boolean;
        timedOut: boolean;
        stagesCleared: number;
        stageClearedAt: number[];
        hintsUsed: number;
        hintPenaltyS: number;
        members: string[];
      }[];
      awards: {
        fastest: string | null;
        fewestHints: string | null;
        teamwork: string | null;
        photoFinish: [string, string] | null;
      };
    }
    const same: Same<ReturnType<typeof screenFinaleOf>, Expected> = true;
    expect(same).toBe(true);
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
