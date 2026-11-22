import type {
  EscapeFinale,
  EscapePlayerState,
  EscapePlayerView,
  EscapeTeamUpdate,
} from '@quiz-dock/contracts';
import { describe, expect, it } from 'vitest';
import { type EscapeAction, type EscapeUi, escapeReducer, initialEscapeUi } from './escape-reducer';

const GAME = '0123456789abcdef0123456789abcdef';

type Team = NonNullable<EscapePlayerState['team']>;

const view = (over: Partial<EscapePlayerView> = {}): EscapePlayerView => ({
  stageIndex: 0,
  stageCount: 3,
  title: 'The vault door',
  intro: 'Find the code.',
  roles: ['lookout'],
  clues: [],
  locks: [
    { id: 'pad', label: 'Keypad', kind: 'code', solved: false, digits: true },
    {
      id: 'duo',
      label: 'Twin dials',
      kind: 'combined',
      solved: false,
      myParts: ['lookout'],
      partsDone: [],
    },
  ],
  hints: [],
  escaped: false,
  ...over,
});

const team = (over: Partial<Team> = {}): Team => ({
  id: 't1',
  name: 'Owls',
  members: [
    { playerId: 'p1', nickname: 'Ana', avatar: null, connected: true, roles: ['lookout'] },
    { playerId: 'p2', nickname: 'Ben', avatar: null, connected: true, roles: ['safecracker'] },
  ],
  stageIndex: 0,
  stageCount: 3,
  escaped: false,
  escapedMs: null,
  timedOut: false,
  hintPenaltyS: 0,
  remainingMs: 1_800_000,
  deadlineAt: 1_000_000 + 1_800_000,
  ...over,
});

/** A phone's state, running by default; `team: null` and `view: null` when forming. */
function stateOf(over: Partial<EscapePlayerState> = {}): EscapePlayerState {
  return {
    gameId: GAME,
    phase: 'running',
    clock: { serverNow: 1_000_000, paused: false, elapsedMs: 0, limitMs: 1_800_000 },
    title: 'Vault Heist',
    intro: 'Get in, get out.',
    roles: [
      { id: 'lookout', name: 'Lookout', description: 'Watches.' },
      { id: 'safecracker', name: 'Safecracker', description: 'Cracks.' },
    ],
    formation: { mode: 'auto', maxSize: null, teams: [{ id: 't1', name: 'Owls', memberCount: 2 }] },
    team: team(),
    view: view(),
    nextHint: { id: 'h1', penaltyS: 60 },
    ...over,
  };
}

const forming = () => stateOf({ phase: 'forming', team: null, view: null, nextHint: null });

const finale: EscapeFinale = {
  gameId: GAME,
  title: 'Vault Heist',
  finale: 'Well done.',
  ranking: [],
  awards: { fastest: null, fewestHints: null, teamwork: null, photoFinish: null },
};

// Every result goes through here, for the structural no-secrets check at the end.
const results: EscapeUi[] = [];
function run(...actions: EscapeAction[]): EscapeUi {
  let ui = initialEscapeUi;
  for (const a of actions) {
    ui = escapeReducer(ui, a);
    results.push(ui);
  }
  return ui;
}

const update = (u: EscapeTeamUpdate, me = 'p1'): EscapeAction => ({
  type: 'teamUpdate',
  update: u,
  me,
});
const keys = (ui: EscapeUi) => ui.polite.map((a) => a.key);
const last = (ui: EscapeUi) => ui.polite.at(-1);

describe('escapeReducer', () => {
  it('a state replaces the state; the first running after forming says the run started', () => {
    const lobby = run({ type: 'state', state: forming() });
    expect(lobby.state?.phase).toBe('forming');
    expect(lobby.polite).toEqual([]);
    const started = escapeReducer(lobby, { type: 'state', state: stateOf() });
    results.push(started);
    expect(started.state?.phase).toBe('running');
    expect(keys(started)).toEqual(['announce.started']);
    // A reload straight into a running run says nothing.
    expect(run({ type: 'state', state: stateOf() }).polite).toEqual([]);
  });

  it('a solved lock names it and who opened it, or the host', () => {
    const ui = run(
      { type: 'state', state: stateOf() },
      update({ teamId: 't1', kind: 'lock-solved', lockId: 'pad', by: 'p2' }),
    );
    expect(last(ui)).toMatchObject({
      key: 'announce.lockSolved',
      params: { lock: 'Keypad', by: 'Ben' },
    });
    const host = escapeReducer(
      ui,
      update({ teamId: 't1', kind: 'lock-solved', lockId: 'pad', by: null }),
    );
    results.push(host);
    expect(last(host)).toMatchObject({
      key: 'announce.lockSolvedByHost',
      params: { lock: 'Keypad' },
    });
  });

  it('an accepted part names the lock, the role and the player', () => {
    const ui = run(
      { type: 'state', state: stateOf() },
      update({
        teamId: 't1',
        kind: 'part-accepted',
        lockId: 'duo',
        roleId: 'safecracker',
        by: 'p2',
      }),
    );
    expect(last(ui)).toMatchObject({
      key: 'announce.partAccepted',
      params: { lock: 'Twin dials', role: 'Safecracker', by: 'Ben' },
    });
  });

  it('a cleared stage and an escape set the overlay', () => {
    const s = run(
      { type: 'state', state: stateOf() },
      update({
        teamId: 't1',
        kind: 'stage-cleared',
        stageIndex: 0,
        unlockText: 'Click.',
        by: 'p1',
      }),
    );
    expect(s.overlay).toEqual({ kind: 'stage', unlockText: 'Click.', stageIndex: 0 });
    expect(last(s)).toMatchObject({ key: 'announce.stageCleared', params: { text: 'Click.' } });
    const e = escapeReducer(
      s,
      update({ teamId: 't1', kind: 'escaped', unlockText: 'Free!', by: null }),
    );
    results.push(e);
    // The overlay never stacks: the escape replaces the stage one.
    expect(e.overlay).toEqual({ kind: 'escaped', unlockText: 'Free!' });
    expect(escapeReducer(e, { type: 'dismissOverlay' }).overlay).toBeNull();
  });

  it('a timed hint is free; an asked or host hint costs the offered penalty', () => {
    const timer = run(
      { type: 'state', state: stateOf() },
      update({ teamId: 't1', kind: 'hint', hintId: 'h1', source: 'timer' }),
    );
    expect(last(timer)).toMatchObject({ key: 'announce.hintFree' });
    expect(timer.hintTags).toEqual({ h1: 'free' });
    for (const source of ['request', 'host'] as const) {
      const paid = run(
        { type: 'state', state: stateOf() },
        update({ teamId: 't1', kind: 'hint', hintId: 'h1', source }),
      );
      expect(last(paid)).toMatchObject({ key: 'announce.hintPaid', params: { seconds: 60 } });
      expect(paid.hintTags).toEqual({ h1: 'paid' });
    }
    const none = run(
      { type: 'state', state: stateOf({ nextHint: { id: 'h1', penaltyS: 0 } }) },
      update({ teamId: 't1', kind: 'hint', hintId: 'h1', source: 'host' }),
    );
    expect(last(none)).toMatchObject({ key: 'announce.hint' });
    expect(none.hintTags).toEqual({});
  });

  it('time added or taken is said as +m:ss or −m:ss', () => {
    const plus = run(
      { type: 'state', state: stateOf() },
      update({ teamId: 't1', kind: 'time', deltaMs: 120_000 }),
    );
    expect(last(plus)).toMatchObject({ key: 'announce.timeChanged', params: { delta: '+2:00' } });
    const minus = run(
      { type: 'state', state: stateOf() },
      update({ teamId: 't1', kind: 'time', deltaMs: -60_000 }),
    );
    expect(last(minus)).toMatchObject({ key: 'announce.timeChanged', params: { delta: '−1:00' } });
  });

  it('time up is assertive, as are clock warnings', () => {
    const up = run({ type: 'state', state: stateOf() }, update({ teamId: 't1', kind: 'time-up' }));
    expect(up.assertive).toMatchObject({ key: 'announce.timeUp' });
    const warn = run({ type: 'state', state: stateOf() }, { type: 'clockWarning', minutes: 5 });
    expect(warn.assertive).toMatchObject({ key: 'announce.minutesLeft', params: { count: 5 } });
    // The same warning again is a new message, so the region speaks it again.
    const again = escapeReducer(warn, { type: 'clockWarning', minutes: 5 });
    results.push(again);
    expect(again.assertive?.id).not.toBe(warn.assertive?.id);
  });

  it('my own wrong try is left to the ack; a teammate’s is said', () => {
    const mine = run(
      { type: 'state', state: stateOf() },
      update({ teamId: 't1', kind: 'wrong', by: 'p1' }),
    );
    expect(mine.polite).toEqual([]);
    const theirs = run(
      { type: 'state', state: stateOf() },
      update({ teamId: 't1', kind: 'wrong', by: 'p2' }),
    );
    expect(last(theirs)).toMatchObject({ key: 'announce.teammateWrong', params: { by: 'Ben' } });
  });

  it('ignores another team’s update', () => {
    const ui = run({ type: 'state', state: stateOf() }, update({ teamId: 't9', kind: 'time-up' }));
    expect(ui.assertive).toBeNull();
  });

  it('the submit ack says a wrong answer and a rate limit', () => {
    const wrong = run(
      { type: 'state', state: stateOf() },
      { type: 'submitAck', lockId: 'pad', ack: { ok: true, outcome: 'wrong' } },
    );
    expect(last(wrong)).toMatchObject({ key: 'announce.wrong' });
    const limited = run(
      { type: 'state', state: stateOf() },
      {
        type: 'submitAck',
        lockId: 'pad',
        ack: { ok: false, reason: 'rate-limited', retryAfterMs: 11_200 },
      },
    );
    expect(last(limited)).toMatchObject({ key: 'announce.rateLimited', params: { seconds: 12 } });
    const solved = run(
      { type: 'state', state: stateOf() },
      { type: 'submitAck', lockId: 'pad', ack: { ok: true, outcome: 'lock-solved' } },
    );
    expect(solved.polite).toEqual([]);
  });

  it('a hint a teammate took first is said', () => {
    const ui = run(
      { type: 'state', state: stateOf() },
      { type: 'hintAck', ack: { ok: false, reason: 'no-hint' } },
    );
    expect(last(ui)).toMatchObject({ key: 'announce.hintTaken' });
  });

  it('says pause, resume and a role change from the new state', () => {
    const paused = stateOf({ clock: { serverNow: 1, paused: true, elapsedMs: 0, limitMs: 1 } });
    const ui = run(
      { type: 'state', state: stateOf() },
      { type: 'state', state: paused },
      { type: 'state', state: stateOf() },
    );
    expect(keys(ui)).toEqual(['announce.paused', 'announce.resumed']);
    const moved = run(
      { type: 'state', state: stateOf() },
      update({ teamId: 't1', kind: 'roles' }),
      { type: 'state', state: stateOf({ view: view({ roles: ['lookout', 'safecracker'] }) }) },
    );
    expect(last(moved)).toMatchObject({
      key: 'announce.rolesChanged',
      params: { roles: 'Lookout, Safecracker' },
    });
  });

  describe('end of the run', () => {
    it('a finale then game:ended is final', () => {
      const ui = run(
        { type: 'state', state: stateOf() },
        { type: 'finale', finale },
        { type: 'gameEnded' },
      );
      expect(ui.finale).toEqual(finale);
      expect(ui.ended).toBe('final');
    });

    it('game:ended while running waits for the finale, or for the timeout', () => {
      const waiting = run({ type: 'state', state: stateOf() }, { type: 'gameEnded' });
      expect(waiting.ended).toBe('waiting');
      const got = escapeReducer(waiting, { type: 'finale', finale });
      results.push(got);
      expect(got.ended).toBe('final');
      const timedOut = escapeReducer(waiting, { type: 'finaleTimeout' });
      results.push(timedOut);
      expect(timedOut).toMatchObject({ ended: 'final', finale: null });
    });

    it('drops a finale of another run', () => {
      const ui = run(
        { type: 'state', state: stateOf() },
        { type: 'finale', finale: { ...finale, gameId: 'e'.repeat(32) } },
      );
      expect(ui.finale).toBeNull();
      // With no state yet (a reload into an ended room) the finale is taken as it is.
      expect(run({ type: 'finale', finale }).finale).toEqual(finale);
    });

    it('game:ended while forming is final: nothing was played', () => {
      expect(run({ type: 'state', state: forming() }, { type: 'gameEnded' }).ended).toBe('final');
    });

    it('a new game in the room resets the finale, the overlay and the end', () => {
      const ui = run(
        { type: 'state', state: stateOf() },
        update({ teamId: 't1', kind: 'escaped', unlockText: 'Free!', by: null }),
        { type: 'finale', finale },
        { type: 'gameEnded' },
        { type: 'state', state: { ...forming(), gameId: 'f'.repeat(32) } },
      );
      expect(ui).toMatchObject({ finale: null, overlay: null, ended: 'none' });
      expect(ui.state?.gameId).toBe('f'.repeat(32));
    });
  });
});

// Last, so it sees every result above (tests in a file run in order).
it('no reducer output ever holds an answer-shaped key', () => {
  const banned = new Set(['answer', 'answers', 'correct', 'order', 'parts']);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        expect(banned.has(k), `key "${k}"`).toBe(false);
        walk(x);
      }
    }
  };
  expect(results.length).toBeGreaterThan(20);
  for (const r of results) walk(JSON.parse(JSON.stringify(r)));
});
