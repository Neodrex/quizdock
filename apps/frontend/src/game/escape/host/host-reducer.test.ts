import type { EscapeTeamUpdate } from '@quiz-dock/contracts';
import { describe, expect, it } from 'vitest';
import { GAME } from '../test-fixtures';
import { boardOf, hostStateOf, hostTeamOf, outlineOf } from './host-fixtures';
import {
  type EscapeHostAction,
  type EscapeHostUi,
  coverageOf,
  escapeHostReducer,
  FEED_KEPT,
  initialEscapeHostUi,
  nextHintOf,
  readinessOf,
  stageOf,
  timeOnStageAt,
} from './host-reducer';

const NOW = 1_000_000_000;
const outline = outlineOf();

/** A console with the outline and the host state in. */
const ready = (state = hostStateOf()): EscapeHostUi =>
  [
    { type: 'outline', outline },
    { type: 'host', state, now: NOW },
  ].reduce(escapeHostReducer as never, initialEscapeHostUi) as EscapeHostUi;

const run = (ui: EscapeHostUi, ...actions: EscapeHostAction[]) =>
  actions.reduce(escapeHostReducer, ui);
const update = (u: EscapeTeamUpdate, now = NOW): EscapeHostAction => ({
  type: 'teamUpdate',
  update: u,
  now,
});
const lastLine = (ui: EscapeHostUi) => ui.feed.at(-1);

describe('escapeHostReducer: state', () => {
  it('host replaces the state, and the board with it', () => {
    const ui = ready();
    const next = hostStateOf({
      unassigned: [{ playerId: 'x', nickname: 'Lone', connected: true }],
    });
    const out = run(ui, { type: 'host', state: next, now: NOW });
    expect(out.host).toBe(next);
    expect(out.board).toBe(next.board);
  });

  it('notes the run time each team was heard at; time on stage runs on from there', () => {
    const ui = ready();
    expect(ui.heardAt).toEqual({ t1: 0, t2: 0 });
    // A minute later (run time 60 s), one team's payload.
    const later = run(ui, { type: 'hostTeam', team: hostTeamOf(), now: NOW + 60_000 });
    expect(later.heardAt).toEqual({ t1: 60_000, t2: 0 });
    const team = hostTeamOf({ timeOnStageMs: 30_000 });
    expect(timeOnStageAt(team, later.heardAt, later.board!.clock, NOW + 90_000)).toBe(60_000);
    // Paused: it holds.
    const clock = { ...later.board!.clock, paused: true, elapsedMs: 60_000 };
    expect(timeOnStageAt(team, later.heardAt, clock, NOW + 600_000)).toBe(30_000);
    // Never heard of: as sent.
    expect(timeOnStageAt(team, {}, later.board!.clock, NOW + 90_000)).toBe(30_000);
  });

  it('hostTeam replaces one team by id; an unknown id changes nothing', () => {
    const ui = ready();
    const moved = hostTeamOf({ stageIndex: 1, stageTitle: 'The Security Room' });
    const out = run(ui, { type: 'hostTeam', team: moved, now: NOW });
    expect(out.host!.teams[0]).toBe(moved);
    expect(out.host!.teams[1]).toBe(ui.host!.teams[1]);
    const stranger = run(ui, { type: 'hostTeam', team: hostTeamOf({ id: 'zz' }), now: NOW });
    expect(stranger).toBe(ui);
  });

  it('hostBatch (a race or a hosted event, M9 Task 9.3): the updates in order, then each team', () => {
    const ui = ready();
    const solved = hostTeamOf({ wrong: 2, solved: ['lobby-door'] });
    const out = run(ui, {
      type: 'hostBatch',
      batch: {
        updates: [
          { teamId: 't1', kind: 'wrong', by: 'p1' },
          { teamId: 't1', kind: 'time-up' },
        ],
        teams: [solved],
      },
      now: NOW,
    });
    // The team's detail as sent, after the updates (its true wrong count wins).
    expect(out.host!.teams[0]).toBe(solved);
    expect(out.host!.teams[1]).toBe(ui.host!.teams[1]);
    expect(out.feed.at(-1)?.key).toBe('host.feed.timeUp');
    // An empty batch changes nothing.
    expect(run(ui, { type: 'hostBatch', batch: { updates: [], teams: [] }, now: NOW })).toBe(ui);
  });

  it('a hosted event’s batch (M9 fix round): the same console as its frames one by one', () => {
    const ui = ready();
    const updates: EscapeTeamUpdate[] = [
      { teamId: 't1', kind: 'roles' },
      {
        teamId: 't1',
        kind: 'part-accepted',
        lockId: 'security-switch',
        roleId: 'hacker',
        by: 'p1',
      },
      { teamId: 't1', kind: 'hint', hintId: 'lobby-h1', source: 'host' },
      { teamId: 't2', kind: 'time', deltaMs: 120_000 },
      { teamId: 't1', kind: 'lock-solved', lockId: 'lobby-door', by: null },
    ];
    const teams = [
      hostTeamOf({ solved: ['lobby-door'], hostUnlocks: ['lobby-door'] }),
      hostTeamOf({ id: 't2', name: 'Team Blue', adjustMs: 120_000 }),
    ];
    const batched = run(ui, { type: 'hostBatch', batch: { updates, teams }, now: NOW });
    const single = run(
      ui,
      ...updates.map((u) => update(u)),
      ...teams.map((team): EscapeHostAction => ({ type: 'hostTeam', team, now: NOW })),
    );
    expect(batched.feed).toEqual(single.feed);
    expect(batched.hintSources).toEqual(single.hintSources);
    expect(batched.host).toEqual(single.host);
    expect(batched.heardAt).toEqual(single.heardAt);
    expect(batched.feed.map((l) => l.key)).toEqual([
      'host.feed.roles',
      'host.feed.partAccepted',
      'host.feed.hintGiven',
      'host.feed.time',
      'host.feed.lockSolvedByHost',
    ]);
  });

  it('board moves the clock and the summaries, and keeps solved, parts and members', () => {
    const ui = ready(
      hostStateOf({
        teams: [hostTeamOf({ solved: ['lobby-door'], partsDone: { x: ['hacker'] } })],
      }),
    );
    const clock = { serverNow: NOW + 5000, paused: true, elapsedMs: 5000, limitMs: 2_400_000 };
    // A summary has the board's fields only (EscapeTeamSummary).
    const { id, name, memberCount, connectedCount, stageIndex, stageCount, stageTitle } =
      hostTeamOf();
    const summary = {
      ...{ id, name, memberCount, connectedCount, stageIndex, stageCount, stageTitle },
      ...{ locksSolved: 1, locksTotal: 2, hintsUsed: 0, escaped: false, escapedAtMs: null },
      timedOut: false,
      ...{ remainingMs: 1000, deadlineAt: null },
    };
    const board = boardOf({ clock, teams: [summary] });
    const out = run(ui, { type: 'board', board });
    const team = out.host!.teams[0];
    expect(out.board!.clock).toEqual(clock);
    expect(out.host!.board.clock).toEqual(clock);
    expect(team).toMatchObject({ locksSolved: 1, remainingMs: 1000, solved: ['lobby-door'] });
    expect(team.partsDone).toEqual({ x: ['hacker'] });
    expect(team.members).toHaveLength(2);
  });

  it('a new run in the room starts afresh, keeping the outline', () => {
    const ui = run(ready(), update({ teamId: 't1', kind: 'time-up' }));
    expect(ui.feed).toHaveLength(1);
    const out = run(ui, { type: 'host', state: hostStateOf({ gameId: 'f'.repeat(32) }), now: NOW });
    expect(out.feed).toEqual([]);
    expect(out.outline).toBe(outline);
    expect(out.seq).toBeGreaterThanOrEqual(ui.seq);
  });

  it('finale sets the results; one of another run is dropped; closed is read-only', () => {
    const finale = {
      gameId: GAME,
      title: 'Vault Heist',
      finale: 'Well done.',
      ranking: [],
      awards: { fastest: null, fewestHints: null, teamwork: null, photoFinish: null },
    };
    expect(run(ready(), { type: 'finale', finale }).finale).toBe(finale);
    expect(
      run(ready(), { type: 'finale', finale: { ...finale, gameId: 'a'.repeat(32) } }).finale,
    ).toBeNull();
    const closed = run(initialEscapeHostUi, { type: 'closed', finale });
    expect(closed).toMatchObject({ finale, ended: 'final' });
  });

  it('pending sets and clears one command', () => {
    const on = run(ready(), { type: 'pending', key: 'hint', on: true });
    expect(on.pending.hint).toBe(true);
    expect(run(on, { type: 'pending', key: 'hint', on: false }).pending.hint).toBe(false);
  });
});

describe('escapeHostReducer: the feed', () => {
  it('lock-solved by the host says so; by a player names them', () => {
    const ui = ready();
    expect(
      lastLine(
        run(ui, update({ teamId: 't1', kind: 'lock-solved', lockId: 'lobby-door', by: null })),
      ),
    ).toMatchObject({
      key: 'host.feed.lockSolvedByHost',
      teamId: 't1',
      params: { team: 'Team Red', lock: 'Staff door keypad' },
    });
    expect(
      lastLine(
        run(ui, update({ teamId: 't1', kind: 'lock-solved', lockId: 'lobby-door', by: 'p2' })),
      ),
    ).toMatchObject({
      key: 'host.feed.lockSolved',
      params: { team: 'Team Red', lock: 'Staff door keypad', by: 'Ben' },
    });
  });

  it('a combined part names the player, the role and the lock', () => {
    const out = run(
      ready(),
      update({
        teamId: 't1',
        kind: 'part-accepted',
        lockId: 'security-switch',
        roleId: 'hacker',
        by: 'p1',
      }),
    );
    expect(lastLine(out)?.params).toEqual({
      team: 'Team Red',
      by: 'Ana',
      role: 'Hacker',
      lock: 'Camera master switch',
    });
  });

  it('stage-cleared names the stage, and is said', () => {
    const out = run(
      ready(),
      update({ teamId: 't1', kind: 'stage-cleared', stageIndex: 0, unlockText: 'x', by: 'p1' }),
    );
    expect(lastLine(out)).toMatchObject({
      key: 'host.feed.stageCleared',
      params: { team: 'Team Red', stage: 'The Lobby' },
    });
    expect(out.polite.at(-1)?.key).toBe('host.feed.stageCleared');
  });

  it('escaped gives the run time: "Team Red escaped in 31:12"', () => {
    const clock = { serverNow: NOW, paused: false, elapsedMs: 31 * 60_000, limitMs: 2_400_000 };
    const ui = ready(hostStateOf({ board: boardOf({ clock }) }));
    const out = run(
      ui,
      update({ teamId: 't1', kind: 'escaped', unlockText: 'x', by: 'p1' }, NOW + 12_000),
    );
    expect(lastLine(out)).toMatchObject({
      key: 'host.feed.escaped',
      params: { team: 'Team Red', time: '31:12' },
      atMs: 31 * 60_000 + 12_000,
    });
    expect(out.polite.at(-1)?.key).toBe('host.feed.escaped');
  });

  it('a timed hint is free; an asked or given one costs its penalty from the outline', () => {
    const ui = ready();
    expect(
      lastLine(
        run(ui, update({ teamId: 't1', kind: 'hint', hintId: 'lobby-h2', source: 'timer' })),
      ),
    ).toMatchObject({
      key: 'host.feed.hintFree',
    });
    expect(
      lastLine(
        run(ui, update({ teamId: 't1', kind: 'hint', hintId: 'lobby-h2', source: 'request' })),
      ),
    ).toMatchObject({
      key: 'host.feed.hintAsked',
      params: { team: 'Team Red', seconds: 60 },
    });
    expect(
      lastLine(run(ui, update({ teamId: 't1', kind: 'hint', hintId: 'lobby-h1', source: 'host' }))),
    ).toMatchObject({
      key: 'host.feed.hintGiven',
      params: { team: 'Team Red', seconds: 30 },
    });
  });

  it('keeps how each hint was released, per team; a new run forgets it', () => {
    const ui = run(
      ready(),
      update({ teamId: 't1', kind: 'hint', hintId: 'lobby-h1', source: 'host' }),
      update({ teamId: 't1', kind: 'hint', hintId: 'lobby-h2', source: 'timer' }),
      update({ teamId: 't2', kind: 'hint', hintId: 'lobby-h1', source: 'request' }),
    );
    expect(ui.hintSources).toEqual({
      t1: { 'lobby-h1': 'host', 'lobby-h2': 'timer' },
      t2: { 'lobby-h1': 'request' },
    });
    const next = hostStateOf({ gameId: 'f'.repeat(32) });
    expect(run(ui, { type: 'host', state: next, now: NOW }).hintSources).toEqual({});
  });

  it('time gives "+2:00" or "−1:00"; time-up is said', () => {
    const ui = ready();
    expect(
      lastLine(run(ui, update({ teamId: 't1', kind: 'time', deltaMs: 120_000 })))?.params?.delta,
    ).toBe('+2:00');
    expect(
      lastLine(run(ui, update({ teamId: 't1', kind: 'time', deltaMs: -60_000 })))?.params?.delta,
    ).toBe('−1:00');
    const up = run(ui, update({ teamId: 't1', kind: 'time-up' }));
    expect(lastLine(up)?.key).toBe('host.feed.timeUp');
    expect(up.polite.at(-1)?.key).toBe('host.feed.timeUp');
  });

  it('wrong raises the counter and adds no line', () => {
    const out = run(ready(), update({ teamId: 't1', kind: 'wrong', by: 'p1' }));
    expect(out.host!.teams[0].wrong).toBe(1);
    expect(out.feed).toEqual([]);
    expect(out.polite).toEqual([]);
  });

  it('an update of an unknown team changes nothing', () => {
    const ui = ready();
    expect(run(ui, update({ teamId: 'zz', kind: 'time-up' }))).toBe(ui);
  });

  it('stuck going true gives one line, once', () => {
    const ui = ready();
    const stuck = hostTeamOf({ stuck: true, timeOnStageMs: 6 * 60_000 + 5000 });
    const out = run(
      ui,
      { type: 'hostTeam', team: stuck, now: NOW },
      { type: 'hostTeam', team: { ...stuck }, now: NOW },
    );
    const lines = out.feed.filter((l) => l.key === 'host.feed.stuck');
    expect(lines).toHaveLength(1);
    expect(lines[0].params).toEqual({ team: 'Team Red', stage: 'The Lobby', minutes: 6 });
    expect(out.polite.map((m) => m.key)).toEqual(['host.feed.stuck']);
  });

  it('a member going offline is said, from the member diff (host or host-team)', () => {
    const ui = ready();
    const [ana, ben] = hostTeamOf().members;
    const gone = hostTeamOf({ members: [{ ...ana, connected: false }, ben] });
    const out = run(ui, { type: 'hostTeam', team: gone, now: NOW });
    expect(out.polite.at(-1)).toMatchObject({
      key: 'host.feed.disconnected',
      params: { name: 'Ana', team: 'Team Red' },
    });
    const viaHost = run(ui, { type: 'host', state: hostStateOf({ teams: [gone] }), now: NOW });
    expect(viaHost.polite.map((m) => m.key)).toEqual(['host.feed.disconnected']);
  });

  it('announce adds nothing: the team update said it', () => {
    const ui = ready();
    const out = run(ui, {
      type: 'announce',
      announce: { kind: 'escaped', teamId: 't1', teamName: 'Team Red', stageIndex: 2 },
    });
    expect(out).toBe(ui);
  });

  it(`keeps the last ${FEED_KEPT} lines`, () => {
    let ui = ready();
    for (let i = 0; i < FEED_KEPT + 5; i++) ui = run(ui, update({ teamId: 't1', kind: 'roles' }));
    expect(ui.feed).toHaveLength(FEED_KEPT);
    expect(new Set(ui.feed.map((l) => l.id)).size).toBe(FEED_KEPT);
  });

  it('a line is stamped with the run time, frozen while paused', () => {
    const clock = { serverNow: NOW, paused: true, elapsedMs: 90_000, limitMs: 2_400_000 };
    const ui = ready(hostStateOf({ board: boardOf({ clock }) }));
    expect(lastLine(run(ui, update({ teamId: 't1', kind: 'roles' }, NOW + 60_000)))?.atMs).toBe(
      90_000,
    );
  });
});

describe('selectors', () => {
  it('stageOf marks solved locks, host unlocks and combined parts done', () => {
    const team = hostTeamOf({
      stageIndex: 1,
      solved: ['security-override'],
      hostUnlocks: ['security-override'],
      partsDone: { 'security-switch': ['hacker'] },
    });
    const view = stageOf(outline, team)!;
    expect(view.stage.id).toBe('security');
    expect(view.locks).toEqual([
      expect.objectContaining({
        id: 'security-switch',
        solved: false,
        byHost: false,
        partsDone: ['hacker'],
      }),
      expect.objectContaining({
        id: 'security-override',
        solved: true,
        byHost: true,
        partsDone: [],
      }),
    ]);
    expect(stageOf(outline, hostTeamOf({ escaped: true }))).toBeNull();
  });

  it('nextHintOf skips released hints and gives null when none is left', () => {
    expect(nextHintOf(outline, hostTeamOf())?.id).toBe('lobby-h1');
    expect(nextHintOf(outline, hostTeamOf({ hintIds: ['lobby-h1'] }))).toEqual({
      id: 'lobby-h2',
      text: 'The year is the code.',
      penaltyS: 60,
      releaseAfterS: 600,
    });
    expect(nextHintOf(outline, hostTeamOf({ hintIds: ['lobby-h1', 'lobby-h2'] }))).toBeNull();
    expect(nextHintOf(outline, hostTeamOf({ stageIndex: 2 }))).toBeNull();
  });

  it('coverageOf: 2 members for 3 roles is shared; an empty team; parallel mode has none', () => {
    const c = coverageOf(outline, hostTeamOf())!;
    expect(c).toMatchObject({ shared: true, empty: false, unheld: [] });
    expect(c.roles.map((r) => [r.id, r.holders])).toEqual([
      ['hacker', ['Ana']],
      ['safecracker', ['Ben']],
      ['lookout', ['Ana']],
    ]);
    expect(coverageOf(outline, hostTeamOf({ members: [] }))).toMatchObject({
      empty: true,
      shared: false,
    });
    const [ana] = hostTeamOf().members;
    expect(
      coverageOf(outline, hostTeamOf({ members: [{ ...ana, roles: ['hacker'] }] }))!.unheld,
    ).toEqual(['safecracker', 'lookout']);
    expect(coverageOf(outlineOf({ mode: 'parallel' }), hostTeamOf())).toBeNull();
  });

  it('readinessOf counts the connected members', () => {
    const [ana, ben] = hostTeamOf().members;
    expect(readinessOf(hostTeamOf({ members: [ana, { ...ben, connected: false }] }))).toEqual({
      connected: 1,
      total: 2,
    });
  });
});

describe('no answers', () => {
  const SECRET = new Set(['answer', 'answers', 'correct', 'order', 'parts']);
  const keysIn = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.flatMap(keysIn)
      : v && typeof v === 'object'
        ? Object.entries(v).flatMap(([k, x]) => [k, ...keysIn(x)])
        : [];

  it('no reducer output nor selector holds an answer key', () => {
    const ui = run(
      ready(),
      update({ teamId: 't1', kind: 'lock-solved', lockId: 'lobby-door', by: null }),
      update({ teamId: 't1', kind: 'hint', hintId: 'lobby-h1', source: 'host' }),
      { type: 'hostTeam', team: hostTeamOf({ stuck: true }), now: NOW },
    );
    const team = ui.host!.teams[0];
    const all = [ui, stageOf(outline, team), nextHintOf(outline, team), coverageOf(outline, team)];
    expect(keysIn(all).filter((k) => SECRET.has(k))).toEqual([]);
  });
});
