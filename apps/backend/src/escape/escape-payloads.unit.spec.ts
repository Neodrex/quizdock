import { leaksIn, stringsIn } from '../../test/escape/leaks';
import { type EscapeFinale, toolsOf } from '@quiz-dock/contracts';
import type { EscapeRun, EscapeSession, EscapeSnapshot, TeamRecord } from './escape-live.types';
import { ACME_LICENCE } from './licences/dev-licences';
import type { LicenceBrand } from './licences/licence.port';
import {
  announceOf,
  boardOf,
  finaleFor,
  finaleOf,
  raceResultsOf,
  hintUpdateOf,
  hostSessionOf,
  hostStateOf,
  hostTeamOf,
  hostOutlineOf,
  lookOf,
  playerSessionOf,
  placesOf,
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
import { RACE_BOARD_TEAMS, RACE_FINALE_TOP } from './escape-session';
import { brandThemeOf } from './brand-theme';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared with the frontend's lanesOf test: both sides rank teams the same way. */
const placesFixture = JSON.parse(
  readFileSync(
    join(__dirname, '../../../../packages/contracts/test/fixtures/escape-places.json'),
    'utf8',
  ),
) as {
  teams: {
    id: string;
    stageIndex: number;
    locksSolved: number;
    escapedAtMs: number | null;
    adjustMs: number;
  }[];
  places: [string, number][];
};

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
  { playerId: 'p1', nickname: 'Ann', avatar: 'ann', connected: true, userId: 'u-ann' },
  { playerId: 'p2', nickname: 'Bob', avatar: null, connected: true, userId: null },
  { playerId: 'p3', nickname: 'Cy', avatar: 'cy', connected: false, userId: null },
  { playerId: 'q1', nickname: 'Dee', avatar: 'dee', connected: true, userId: 'u-dee' },
  { playerId: 'x', nickname: 'Lone', avatar: 'lone', connected: true, userId: null },
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
  session: null,
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

  it('has no session for a room opened before session types', () => {
    expect(hostStateOf(view()).session).toBeNull();
  });

  it('gives the session: type, cap, seats taken, tools, and the licence without its id or uses', () => {
    const session: EscapeSession = {
      type: 'hosted',
      cap: 8,
      race: null,
      licence: {
        id: 'acme',
        organisationId: 'acme-org',
        participantCap: 8,
        expiresAt: ACME_LICENCE.expiresAt,
        package: 'bundle',
        brand: ACME_LICENCE.brand,
      },
      licenceUsed: false,
      phoneHostUserId: null,
    };
    const out = hostSessionOf({ ...view(), session });
    expect(out).toEqual({
      type: 'hosted',
      cap: 8,
      joined: players.length,
      race: null,
      licence: { organisationName: 'Acme', expiresAt: ACME_LICENCE.expiresAt, package: 'bundle' },
      tools: [...toolsOf('hosted')],
    });
    expect(JSON.stringify(out)).not.toMatch(/acme-org|"id"|eventsLeft|hosts|logoUrl/);
    const race = hostSessionOf({
      ...view(),
      session: {
        ...session,
        type: 'race',
        cap: 500,
        licence: null,
        race: { format: 'teams', startsAt: 5, started: false, siteRaceId: 'site-1', brand: null },
      },
    });
    expect(race).toMatchObject({
      type: 'race',
      licence: null,
      race: { format: 'teams', startsAt: 5, started: false },
      tools: [...toolsOf('race')],
    });
    expect(JSON.stringify(race)).not.toMatch(/site-1|siteRaceId/);
  });

  it('hostSessionOf: a Site race says whether the Site knows the room; another race says nothing', () => {
    const raceSession = (race: Partial<NonNullable<EscapeSession['race']>>) =>
      hostSessionOf({
        ...view(),
        session: {
          type: 'race',
          cap: 500,
          licence: null,
          licenceUsed: false,
          phoneHostUserId: null,
          race: {
            format: 'solo',
            startsAt: null,
            started: false,
            siteRaceId: null,
            brand: null,
            ...race,
          },
        },
      })?.race;
    expect(raceSession({})).toEqual({ format: 'solo', startsAt: null, started: false });
    // Stored before M9: linked.
    expect(raceSession({ siteRaceId: 's' })).toMatchObject({ siteLinked: true });
    expect(raceSession({ siteRaceId: 's' })).not.toHaveProperty('siteLost');
    expect(raceSession({ siteRaceId: 's', siteLinked: false })).toMatchObject({
      siteLinked: false,
    });
    expect(raceSession({ siteRaceId: 's', siteLinked: false, siteLost: true })).toMatchObject({
      siteLinked: false,
      siteLost: true,
    });
    expect(raceSession({ siteRaceId: 's', siteLinked: false, siteMissing: true })).toMatchObject({
      siteLinked: false,
      siteMissing: true,
    });
    expect(raceSession({ siteRaceId: 's', siteLinked: false })).not.toHaveProperty('siteMissing');
  });

  it('the template itself trips the checker (positive control)', () => {
    const leaks = leaksIn(tpl, tpl);
    expect(leaks).toEqual(expect.arrayContaining([expect.stringContaining('secret key')]));
    expect(leaks).toEqual(
      expect.arrayContaining([expect.stringContaining('answer of lock lobby-door')]),
    );
  });
});

describe('playerSessionOf (M7 §1.4)', () => {
  const group: EscapeSession = {
    type: 'group',
    cap: 6,
    race: null,
    licence: null,
    licenceUsed: false,
    phoneHostUserId: 'u-ann',
  };

  it('marks the phone host by its account, and nobody else', () => {
    const v = { ...view(), session: group };
    expect(playerSessionOf(v, 'p1')).toEqual({
      type: 'group',
      raceFormat: null,
      startsAt: null,
      isPhoneHost: true,
    });
    for (const id of ['p2', 'q1', 'x', 'nobody']) {
      expect(playerSessionOf(v, id)?.isPhoneHost).toBe(false);
    }
    // A guest never matches a session without a phone host.
    const hosted = { ...v, session: { ...group, type: 'hosted' as const, phoneHostUserId: null } };
    expect(playerSessionOf(hosted, 'p2')?.isPhoneHost).toBe(false);
    expect(playerStateOf(v, 'p1').session?.isPhoneHost).toBe(true);
  });

  it('marks the phone host by its player in open access, where no player has an account', () => {
    const v = view();
    const guests = { ...v, players: v.players.map((p) => ({ ...p, userId: null })) };
    const open = { ...guests, session: { ...group, phoneHostPlayerId: 'p2' } };
    expect(playerSessionOf(open, 'p2')?.isPhoneHost).toBe(true);
    for (const id of ['p1', 'q1', 'nobody']) {
      expect(playerSessionOf(open, id)?.isPhoneHost).toBe(false);
    }
    // Not yet seen: nobody is.
    expect(playerSessionOf({ ...guests, session: group }, 'p1')?.isPhoneHost).toBe(false);
  });

  it('gives a race its format and start, and nothing for a room without a session', () => {
    const race = {
      ...view(),
      session: {
        ...group,
        type: 'race' as const,
        phoneHostUserId: null,
        race: {
          format: 'solo' as const,
          startsAt: 123,
          started: false,
          siteRaceId: null,
          brand: null,
        },
      },
    };
    expect(playerSessionOf(race, 'p1')).toEqual({
      type: 'race',
      raceFormat: 'solo',
      startsAt: 123,
      isPhoneHost: false,
    });
    expect(playerStateOf(view(), 'p1').session).toBeNull();
  });

  it('never sends a player’s account', () => {
    expect(JSON.stringify(playerStateOf({ ...view(), session: group }, 'p1'))).not.toContain(
      'u-ann',
    );
    expect(JSON.stringify(hostStateOf(view()))).not.toContain('u-ann');
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

describe('race scale (M7 §1.7)', () => {
  const raceSession: EscapeSession = {
    type: 'race',
    cap: 500,
    race: { format: 'solo', startsAt: null, started: true, siteRaceId: null, brand: null },
    licence: null,
    licenceUsed: false,
    phoneHostUserId: null,
  };
  /** `n` solo teams t1…tn, team k having solved k mod 4 locks of the first stage. */
  const soloView = (n: number, session: EscapeSession | null = raceSession): RunView => {
    const teams = Array.from({ length: n }, (_, i) => {
      const t = newTeam(tpl, `t${i + 1}`, `Player number ${i + 1}`, [`p${i + 1}`]);
      const solved = tpl.stages[0].locks.slice(0, (i + 1) % 4).map((l) => l.id);
      return rec({ ...t, solved: solved.slice(0, tpl.stages[0].locks.length - 1) });
    });
    return {
      ...view(),
      run: { ...running, teamIds: teams.map((r) => r.team.id) },
      teams,
      players: teams.map((r, i) => ({
        playerId: r.team.members[0],
        nickname: `Player number ${i + 1}`,
        avatar: null,
        connected: true,
        userId: null,
      })),
      session,
    };
  };

  it('a Site race the Site does not know: only the host state says so (M9 Task 9.6)', () => {
    const v = soloView(3, {
      ...raceSession,
      race: {
        ...raceSession.race!,
        siteRaceId: 'site-1',
        siteLinked: false,
        siteLost: true,
        siteMissing: true,
      },
    });
    const outside = JSON.stringify([
      playerSessionOf(v, 'p1'),
      playerStateOf(v, 'p1'),
      boardOf(v),
      lookOf(v.session),
    ]);
    expect(outside).not.toMatch(/siteLinked|siteLost|siteMissing|site-1/);
    expect(hostStateOf(v).session?.race).toMatchObject({
      siteLinked: false,
      siteLost: true,
      siteMissing: true,
    });
  });

  it('a host state walks the players and the teams a few times, not once per team (M9 Task 9.4)', () => {
    /** The array, counting each whole walk (map, filter, find, some, a for…of…). */
    const counted = <T>(xs: T[]) => {
      const walks = { n: 0 };
      const walkers = new Set([
        'map',
        'filter',
        'find',
        'findIndex',
        'some',
        'every',
        'forEach',
        'flatMap',
        'reduce',
      ]);
      const proxy = new Proxy(xs, {
        get(target, key, receiver) {
          if (key === Symbol.iterator || walkers.has(key as string)) walks.n++;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      return { proxy, walks };
    };
    for (const session of [raceSession, null]) {
      const base = soloView(500, session);
      const players = counted(base.players);
      const teams = counted(base.teams);
      const v = { ...base, players: players.proxy, teams: teams.proxy };
      hostStateOf(v);
      expect(players.walks.n).toBeLessThan(10);
      expect(teams.walks.n).toBeLessThan(20);
    }
  });

  it('a player listed in two teams: the index gives the first team, as a find over the teams (M9 fix round)', () => {
    const base = soloView(3, null);
    const [t1, t2, t3] = base.teams;
    // p2 listed by t1 as well as t2: the first team wins.
    const twice = rec({ ...t1.team, members: ['p1', 'p2'] });
    const v: RunView = { ...base, teams: [twice, t2, t3] };
    const found = (id: string) => v.teams.find((r) => r.team.members.includes(id))?.team.id;
    for (const id of ['p1', 'p2', 'p3']) {
      expect(playerStateOf(v, id).team?.id).toBe(found(id));
    }
    expect(playerStateOf(v, 'p2').team?.id).toBe('t1');
    const lobby: RunView = { ...v, run: { ...v.run, phase: 'forming' } };
    expect(boardOf(lobby).roster.map((p) => p.teamId)).toEqual(['t1', 't1', 't3']);
    expect(hostStateOf(v).unassigned).toEqual([]);
  });

  it('placesOf ranks as the screen’s lanesOf (the shared fixture)', () => {
    const v: RunView = {
      ...view(),
      teams: placesFixture.teams.map((t) =>
        rec(
          {
            ...newTeam(tpl, t.id, t.id, []),
            stageIndex: t.stageIndex,
            solved: tpl.stages[t.stageIndex].locks.slice(0, t.locksSolved).map((l) => l.id),
            escapedAt: t.escapedAtMs,
            adjustMs: t.adjustMs,
          },
          { timedOut: false },
        ),
      ),
      run: { ...running, teamIds: placesFixture.teams.map((t) => t.id) },
    };
    expect(placesOf(v).map((p) => [p.summary.id, p.place])).toEqual(placesFixture.places);
  });

  it('a race board of 500 teams holds the top 30 by place and the totals, under 12 KB', () => {
    const v = soloView(500);
    const board = boardOf(v);
    expect(board.teams).toHaveLength(RACE_BOARD_TEAMS);
    expect(board.teams.map((t) => t.id)).toEqual(
      placesOf(v)
        .slice(0, RACE_BOARD_TEAMS)
        .map((p) => p.summary.id),
    );
    expect(board.session).toEqual({
      type: 'race',
      startsAt: null,
      totals: { teams: 500, players: 500, escaped: 0 },
    });
    expect(JSON.stringify(board).length).toBeLessThan(12 * 1024);
  });

  it('a race phone’s state lists its own team only, and stays small with 500 teams', () => {
    const v = soloView(500);
    const state = playerStateOf(v, 'p7');
    expect(state.formation.teams).toEqual([{ id: 't7', name: 'Player number 7', memberCount: 1 }]);
    expect(JSON.stringify(state).length).toBeLessThan(4 * 1024);
    // A phone without a team yet: none listed.
    const free = { ...v, players: [...v.players, { ...v.players[0], playerId: 'free' }] };
    expect(playerStateOf(free, 'free').formation.teams).toEqual([]);
    // Other session types list every team.
    const hosted = soloView(40, { ...raceSession, type: 'hosted', race: null });
    expect(playerStateOf(hosted, 'p1').formation.teams).toHaveLength(40);
  });

  it('a forming race sends no roster: the count is in the totals', () => {
    const v = soloView(500);
    const forming = { ...v, run: { ...v.run, phase: 'forming' as const } };
    expect(boardOf(forming).roster).toEqual([]);
    expect(boardOf(forming).session?.totals.players).toBe(500);
    const hosted = { ...forming, session: { ...raceSession, type: 'hosted' as const, race: null } };
    expect(boardOf(hosted).roster).toHaveLength(500);
  });

  it('other session types keep every team on the board', () => {
    const board = boardOf(soloView(40, { ...raceSession, type: 'hosted', race: null }));
    expect(board.teams).toHaveLength(40);
    expect(boardOf(soloView(40, null)).teams).toHaveLength(40);
  });

  it('a race phone’s finale: the top 20, its own row beyond them, and the total', () => {
    const v = { ...soloView(500), run: { ...running, phase: 'finale' as const } };
    const finale = finaleOf(v, 'g1');
    expect(finale.ranking).toHaveLength(500);
    const limits = { boardTeams: 30, boardEveryMs: 1000, finaleTop: RACE_FINALE_TOP };
    const last = finale.ranking.at(-1)!;
    const far = finaleFor(finale, last.teamId, limits);
    expect(far.ranking).toHaveLength(RACE_FINALE_TOP + 1);
    expect(far.ranking.at(-1)).toEqual(last);
    expect(far.totalTeams).toBe(500);
    const near = finaleFor(finale, finale.ranking[3].teamId, limits);
    expect(near.ranking).toEqual(finale.ranking.slice(0, RACE_FINALE_TOP));
    expect(finaleFor(finale, null, limits).ranking).toHaveLength(RACE_FINALE_TOP);
    // No limits (group, hosted): the stored finale as it is.
    expect(finaleFor(finale, last.teamId, null)).toBe(finale);
    // The screen's: the top 20.
    const screen = screenFinaleOf(finale, v);
    expect(screen.ranking).toHaveLength(RACE_FINALE_TOP);
    expect(screen.totalTeams).toBe(500);
    expect(screenFinaleOf(finale, { ...v, session: null }).ranking).toHaveLength(500);
  });

  it('raceResultsOf (M8): the finale’s top 20 for the Site, names only, the total and the PIN', () => {
    const v = { ...soloView(500), run: { ...running, phase: 'finale' as const } };
    const finale = finaleOf(v, 'g1');
    const out = raceResultsOf(finale, '123456', 42);
    expect(out).toMatchObject({ pin: '123456', endedAt: 42, totalTeams: 500 });
    expect(out.top).toHaveLength(20);
    expect(out.top[0]).toEqual({
      place: finale.ranking[0].place,
      name: finale.ranking[0].name,
      escaped: false,
      timeMs: null,
      stages: finale.ranking[0].stagesCleared,
    });
    expect(out.top.map((r) => r.place)).toEqual(finale.ranking.slice(0, 20).map((r) => r.place));
    expect(JSON.stringify(out)).not.toMatch(/"p\d+"|"t\d+"|playerId|teamId|members/);
    const escaped = {
      ...finale,
      ranking: [{ ...finale.ranking[0], escaped: true, scoreMs: 600_000 }],
    };
    expect(raceResultsOf(escaped, '1', 1).top[0]).toMatchObject({ escaped: true, timeMs: 600_000 });
  });
});

describe('lookOf (M7 §1.9)', () => {
  const hosted = (licence: EscapeSession['licence']): EscapeSession => ({
    type: 'hosted',
    cap: 8,
    race: null,
    licence,
    licenceUsed: false,
    phoneHostUserId: null,
  });
  const acme = {
    id: 'acme',
    organisationId: 'acme-org',
    participantCap: 8,
    expiresAt: ACME_LICENCE.expiresAt,
    package: 'bundle' as const,
    brand: ACME_LICENCE.brand,
  };

  it('a branded licence: its theme and its name, logo and intro, nothing else', () => {
    const look = lookOf(hosted(acme));
    expect(look).toEqual({
      theme: brandThemeOf(ACME_LICENCE.brand!),
      brand: {
        name: 'Acme',
        logoUrl: ACME_LICENCE.brand!.logoUrl,
        intro: ACME_LICENCE.brand!.intro,
      },
    });
    expect(look.theme?.accent).toBe('#c2410c');
    expect(JSON.stringify(look)).not.toMatch(/acme-org|"id"|eventsLeft|hosts|"acme"/);
  });

  it('no brand, no licence, group play, a race, no session: unbranded', () => {
    const none = { theme: null, brand: null };
    expect(lookOf(hosted({ ...acme, brand: null }))).toEqual(none);
    expect(lookOf(hosted(null))).toEqual(none);
    expect(lookOf({ ...hosted(acme), type: 'group' })).toEqual(none);
    expect(lookOf({ ...hosted(acme), type: 'race' })).toEqual(none);
    expect(lookOf(null)).toEqual(none);
  });

  const raceOf = (brand: LicenceBrand | null): EscapeSession => ({
    type: 'race',
    cap: 500,
    race: { format: 'solo', startsAt: null, started: false, siteRaceId: 'site-1', brand },
    licence: null,
    licenceUsed: false,
    phoneHostUserId: null,
  });
  const channel: LicenceBrand = {
    name: 'Channel 4',
    logoUrl: 'https://cdn.example.com/c4.png',
    accent: '#1d4ed8',
    background: '#ffff00',
    baseTheme: 'classic',
    intro: 'Tonight’s race',
  };

  it('a race with its channel’s brand (M8): the same look as a hosted event’s', () => {
    const look = lookOf(raceOf(channel));
    expect(look).toEqual({
      theme: brandThemeOf(channel),
      brand: { name: 'Channel 4', logoUrl: channel.logoUrl, intro: channel.intro },
    });
    expect(JSON.stringify(look)).not.toMatch(/site-1|siteRaceId/);
    expect(lookOf(raceOf(null))).toEqual({ theme: null, brand: null });
  });

  it('a race brand gets the hosted contrast fallback', () => {
    // A pale background with a pale accent fails a check: the background is dropped.
    const pale = { ...channel, accent: '#fde68a', background: '#fffbeb' };
    expect(lookOf(raceOf(pale)).theme).toEqual(brandThemeOf(pale));
    expect(lookOf(raceOf(pale)).theme).toEqual(lookOf(hosted({ ...acme, brand: pale })).theme);
  });

  it('a race brand never shows in group play or a hosted room', () => {
    const s = raceOf(channel);
    expect(lookOf({ ...s, type: 'group' })).toEqual({ theme: null, brand: null });
    expect(lookOf({ ...s, type: 'hosted', licence: null })).toEqual({ theme: null, brand: null });
  });
});
