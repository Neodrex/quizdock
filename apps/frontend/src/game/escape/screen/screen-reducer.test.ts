import { describe, expect, it } from 'vitest';
import {
  BANNER_MS,
  ESCAPED_BANNER_MS,
  type EscapeScreenAction,
  type EscapeScreenUi,
  initialScreenUi,
  lanesOf,
  lastSecondsOf,
  lobbyOf,
  finalMinutesOf,
  ownTimeOf,
  screenReducer,
  showClockOf,
} from './screen-reducer';
import { announceOf, boardOf, GAME, screenFinaleOf, summaryOf } from './screen-fixtures';

const NOW = 1_000_000_000;
const MIN = 60_000;

const run = (actions: EscapeScreenAction[], from: EscapeScreenUi = initialScreenUi) =>
  actions.reduce(screenReducer, from);

const red = summaryOf();
const blue = summaryOf({ id: 't2', name: 'Team Blue' });
const green = summaryOf({ id: 't3', name: 'Team Green' });

describe('screenReducer: board', () => {
  it('replaces the board and learns the stage titles the teams reached', () => {
    const ui = run([
      { type: 'board', board: boardOf({ teams: [red, blue] }) },
      {
        type: 'board',
        board: boardOf({
          clock: { serverNow: NOW + 100, paused: false, elapsedMs: 100, limitMs: 40 * MIN },
          teams: [red, { ...blue, stageIndex: 1, stageTitle: 'The Office' }],
        }),
      },
    ]);
    expect(ui.board?.clock.serverNow).toBe(NOW + 100);
    expect(ui.stageTitles).toEqual({ 0: 'The Lobby', 1: 'The Office' });
  });

  it('drops a board older than the one shown', () => {
    const later = boardOf({
      clock: { serverNow: NOW + 500, paused: false, elapsedMs: 500, limitMs: 40 * MIN },
      teams: [red],
    });
    const ui = run([
      { type: 'board', board: later },
      { type: 'board', board: boardOf({ teams: [] }) },
    ]);
    expect(ui.board).toBe(later);
  });

  it('a new run forgets the last one: titles and finale', () => {
    const ui = run([
      { type: 'board', board: boardOf({ teams: [{ ...red, escaped: true }] }) },
      { type: 'screenFinale', finale: screenFinaleOf(), record: null },
      {
        type: 'board',
        board: boardOf({
          gameId: 'f'.repeat(32),
          clock: { serverNow: 5, paused: false, elapsedMs: 0, limitMs: 40 * MIN },
          phase: 'forming',
          teams: [{ ...blue, stageTitle: 'Other' }],
        }),
      },
    ]);
    expect(ui.board?.gameId).toBe('f'.repeat(32));
    expect(ui.stageTitles).toEqual({ 0: 'Other' });
    expect(ui.finale).toBeNull();
  });
});

describe('screenReducer: banners', () => {
  const announce = (over: Parameters<typeof announceOf>[0], now = NOW): EscapeScreenAction => ({
    type: 'announce',
    announce: announceOf(over),
    now,
  });

  it('shows the first banner at once, for BANNER_MS, and says it politely', () => {
    const ui = run([announce({ kind: 'stage-cleared', stageIndex: 1 })]);
    expect(ui.current).toMatchObject({ kind: 'stage-cleared', until: NOW + BANNER_MS });
    expect(ui.banners).toEqual([]);
    expect(ui.polite.at(-1)).toMatchObject({
      key: 'screen.banner.stageCleared',
      params: { team: 'Team Red', stage: 2 },
    });
  });

  it('an escape stays ESCAPED_BANNER_MS', () => {
    const ui = run([announce({ kind: 'escaped' })]);
    expect(ui.current?.until).toBe(NOW + ESCAPED_BANNER_MS);
    expect(ESCAPED_BANNER_MS).toBe(6000);
    expect(BANNER_MS).toBe(4000);
  });

  it('waits by priority: escaped, stage cleared, time up, hint', () => {
    const ui = run([
      announce({ kind: 'hint', teamId: 't9' }),
      announce({ kind: 'hint', teamId: 't1' }),
      announce({ kind: 'time-up', teamId: 't2' }),
      announce({ kind: 'stage-cleared', teamId: 't3' }),
      announce({ kind: 'escaped', teamId: 't4' }),
    ]);
    expect(ui.current).toMatchObject({ kind: 'hint', teamId: 't9' });
    expect(ui.banners.map((b) => b.kind)).toEqual(['escaped', 'stage-cleared', 'time-up', 'hint']);
  });

  it('keeps at most 5 waiting: the lowest priority goes', () => {
    const ui = run([
      announce({ kind: 'escaped', teamId: 't0' }),
      announce({ kind: 'hint', teamId: 'h1' }),
      announce({ kind: 'stage-cleared', teamId: 's1' }),
      announce({ kind: 'stage-cleared', teamId: 's2' }),
      announce({ kind: 'stage-cleared', teamId: 's3' }),
      announce({ kind: 'stage-cleared', teamId: 's4' }),
      announce({ kind: 'stage-cleared', teamId: 's5' }),
    ]);
    expect(ui.banners).toHaveLength(5);
    expect(ui.banners.map((b) => b.teamId)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('collapses two waiting hints of the same team into one', () => {
    const ui = run([
      announce({ kind: 'escaped', teamId: 't0' }),
      announce({ kind: 'hint', teamId: 't1' }),
      announce({ kind: 'hint', teamId: 't1' }),
      announce({ kind: 'hint', teamId: 't2' }),
    ]);
    expect(ui.banners.map((b) => `${b.kind}:${b.teamId}`)).toEqual(['hint:t1', 'hint:t2']);
  });

  it('next(now) keeps the banner until its time, then shows the next, then none', () => {
    let ui = run([announce({ kind: 'stage-cleared' }), announce({ kind: 'hint' })]);
    ui = screenReducer(ui, { type: 'next', now: NOW + BANNER_MS - 1 });
    expect(ui.current?.kind).toBe('stage-cleared');
    ui = screenReducer(ui, { type: 'next', now: NOW + BANNER_MS });
    expect(ui.current).toMatchObject({ kind: 'hint', until: NOW + 2 * BANNER_MS });
    expect(ui.polite.at(-1)?.key).toBe('screen.banner.hint');
    ui = screenReducer(ui, { type: 'next', now: NOW + 2 * BANNER_MS });
    expect(ui.current).toBeNull();
    expect(ui.banners).toEqual([]);
  });
});

describe('screenReducer: banners while paused', () => {
  const paused = (on: boolean) =>
    boardOf({ clock: { serverNow: NOW, paused: on, elapsedMs: 0, limitMs: 40 * MIN } });

  it('waits until the run resumes, then shows the next banner', () => {
    const waiting = run([
      { type: 'board', board: paused(true) },
      { type: 'announce', announce: announceOf({ kind: 'hint' }), now: NOW },
    ]);
    expect(waiting.current).toBeNull();
    expect(waiting.banners).toHaveLength(1);
    expect(waiting.polite).toEqual([]);
    const resumed = run(
      [
        {
          type: 'board',
          board: { ...paused(false), clock: { ...paused(false).clock, serverNow: NOW + 1 } },
        },
        { type: 'next', now: NOW + 5000 },
      ],
      waiting,
    );
    expect(resumed.current).toMatchObject({ kind: 'hint', until: NOW + 5000 + BANNER_MS });
  });

  it('lets the banner up at the pause finish its time, and shows no other', () => {
    const ui = run([
      { type: 'announce', announce: announceOf({ kind: 'stage-cleared' }), now: NOW },
      { type: 'announce', announce: announceOf({ kind: 'hint' }), now: NOW },
      { type: 'board', board: paused(true) },
      { type: 'next', now: NOW + BANNER_MS },
    ]);
    expect(ui.current).toBeNull();
    expect(ui.banners.map((b) => b.kind)).toEqual(['hint']);
  });
});

describe('screenReducer: finale', () => {
  it('sets the finale, replay pending', () => {
    const finale = screenFinaleOf();
    const ui = run([{ type: 'screenFinale', finale, record: null }]);
    expect(ui.finale).toBe(finale);
    expect(ui.replay).toBe('pending');
  });

  it('replay is done when the record says this run was replayed', () => {
    const finale = screenFinaleOf();
    const record = { pin: '482913', gameId: GAME, replayed: true, finale };
    expect(run([{ type: 'screenFinale', finale, record }]).replay).toBe('done');
    const other = { ...record, gameId: 'f'.repeat(32) };
    expect(run([{ type: 'screenFinale', finale, record: other }]).replay).toBe('pending');
    const notYet = { ...record, replayed: false };
    expect(run([{ type: 'screenFinale', finale, record: notYet }]).replay).toBe('pending');
  });

  it('replay moves to playing and done; closed is kept', () => {
    const ui = run([
      { type: 'screenFinale', finale: screenFinaleOf(), record: null },
      { type: 'replay', replay: 'playing' },
      { type: 'replay', replay: 'done' },
      { type: 'closed' },
    ]);
    expect(ui.replay).toBe('done');
    expect(ui.closed).toBe(true);
  });
});

describe('lanesOf', () => {
  it('keeps team order and gives live places', () => {
    const board = boardOf({
      teams: [
        { ...red, stageIndex: 1, locksSolved: 0 },
        { ...blue, stageIndex: 1, locksSolved: 1 },
        { ...green, stageIndex: 2 },
      ],
    });
    expect(lanesOf(board).map((l) => [l.id, l.place])).toEqual([
      ['t1', 3],
      ['t2', 2],
      ['t3', 1],
    ]);
  });

  it('puts escaped teams first, by their escape run time', () => {
    const board = boardOf({
      teams: [
        { ...red, escaped: true, escapedAtMs: 1_500_000, stageIndex: 3 },
        { ...blue, stageIndex: 2 },
        { ...green, escaped: true, escapedAtMs: 1_200_000, stageIndex: 3 },
      ],
    });
    expect(lanesOf(board).map((l) => [l.id, l.place])).toEqual([
      ['t1', 2],
      ['t2', 3],
      ['t3', 1],
    ]);
  });

  it('a team given extra time that escaped later stays behind, even on a fresh screen (a reload)', () => {
    // Red got +5:00 and escaped at 30:00, with more time left than Blue, out at 28:00.
    const board = boardOf({
      teams: [
        { ...red, escaped: true, escapedAtMs: 1_800_000, remainingMs: 900_000, deadlineAt: null },
        { ...blue, escaped: true, escapedAtMs: 1_680_000, remainingMs: 720_000, deadlineAt: null },
      ],
    });
    const ui = run([{ type: 'board', board }]);
    expect(lanesOf(ui.board!).map((l) => [l.id, l.place])).toEqual([
      ['t1', 2],
      ['t2', 1],
    ]);
  });

  it('then by time left; equal teams share a place', () => {
    const board = boardOf({
      teams: [
        { ...red, remainingMs: 100_000 },
        { ...blue, remainingMs: 200_000 },
        { ...green, remainingMs: 100_000 },
      ],
    });
    expect(lanesOf(board).map((l) => l.place)).toEqual([2, 1, 2]);
  });
});

describe('showClockOf', () => {
  const running = (teams = [red, blue], paused = false) =>
    boardOf({
      clock: { serverNow: NOW, paused, elapsedMs: 0, limitMs: 40 * MIN },
      teams,
    });

  it('counts down to the latest deadline of the teams still playing', () => {
    const board = running([
      { ...red, deadlineAt: NOW + 10 * MIN },
      { ...blue, deadlineAt: NOW + 12 * MIN },
      { ...green, deadlineAt: NOW + 30 * MIN, escaped: true },
    ]);
    expect(showClockOf(board, NOW + MIN)).toEqual({
      remainingMs: 11 * MIN,
      deadlineAt: NOW + 12 * MIN,
      paused: false,
    });
  });

  it('freezes while paused', () => {
    const board = running(
      [
        { ...red, deadlineAt: null, remainingMs: 7 * MIN },
        { ...blue, deadlineAt: null, remainingMs: 9 * MIN },
      ],
      true,
    );
    expect(showClockOf(board, NOW + 5 * MIN)).toEqual({
      remainingMs: 9 * MIN,
      deadlineAt: null,
      paused: true,
    });
  });

  it('is null when no team is still playing, or before the run', () => {
    expect(showClockOf(running([{ ...red, escaped: true }]), NOW)).toBeNull();
    expect(showClockOf(boardOf({ phase: 'forming', teams: [red] }), NOW)).toBeNull();
  });

  it('a team given +2:00 shows its own time; the others do not', () => {
    const board = running([
      { ...red, deadlineAt: NOW + 10 * MIN },
      { ...blue, deadlineAt: NOW + 12 * MIN },
    ]);
    const show = showClockOf(board, NOW)!;
    expect(ownTimeOf(board.teams[0], show, NOW)).toBe(10 * MIN);
    expect(ownTimeOf(board.teams[1], show, NOW)).toBeNull();
    // Within a second of the show clock: no own time.
    expect(ownTimeOf({ ...red, deadlineAt: NOW + 12 * MIN - 900 }, show, NOW)).toBeNull();
  });
});

describe('final minutes', () => {
  const at = (limitMs: number, remaining: number) =>
    boardOf({
      clock: { serverNow: NOW, paused: false, elapsedMs: 0, limitMs },
      teams: [{ ...red, deadlineAt: NOW + remaining }],
    });

  it('5 minutes for a 45-minute run', () => {
    expect(finalMinutesOf(at(45 * MIN, 5 * MIN + 1000), NOW)).toBe(false);
    expect(finalMinutesOf(at(45 * MIN, 5 * MIN), NOW)).toBe(true);
  });

  it('3 minutes for a 20-minute run', () => {
    expect(finalMinutesOf(at(20 * MIN, 4 * MIN), NOW)).toBe(false);
    expect(finalMinutesOf(at(20 * MIN, 3 * MIN), NOW)).toBe(true);
  });

  it('the last seconds are the last 10', () => {
    expect(lastSecondsOf(at(45 * MIN, 11_000), NOW)).toBe(false);
    expect(lastSecondsOf(at(45 * MIN, 10_000), NOW)).toBe(true);
  });
});

describe('lobbyOf', () => {
  it('gives each team its count against the cap, its players, and who is waiting', () => {
    const board = boardOf({
      phase: 'forming',
      formation: { mode: 'self', maxSize: 5 },
      teams: [red, { ...blue, memberCount: 0 }],
      unassigned: 1,
      roster: [
        { teamId: 't1', nickname: 'Ana', connected: true },
        { teamId: null, nickname: 'Zoe', connected: true },
        { teamId: 't1', nickname: 'Ben', connected: false },
        { teamId: 't1', nickname: 'Cy', connected: true },
      ],
    });
    expect(lobbyOf(board)).toEqual({
      selfFormation: true,
      teams: [
        {
          id: 't1',
          name: 'Team Red',
          count: 3,
          label: '3 / 5',
          full: false,
          members: [
            { nickname: 'Ana', connected: true },
            { nickname: 'Ben', connected: false },
            { nickname: 'Cy', connected: true },
          ],
        },
        { id: 't2', name: 'Team Blue', count: 0, label: '0 / 5', full: false, members: [] },
      ],
      unassigned: 1,
      waiting: ['Zoe'],
    });
  });

  it('no cap: the count alone; auto formation', () => {
    const lobby = lobbyOf(boardOf({ phase: 'forming', teams: [red] }));
    expect(lobby.selfFormation).toBe(false);
    expect(lobby.teams[0].label).toBe('3');
  });
});

/** §1.4: none of these reaches the screen's state or what it draws from it. */
const FORBIDDEN = [
  'answer',
  'answers',
  'unlockText',
  'text',
  'body',
  'clues',
  'playerId',
  'adjustMs',
  'hostUnlocks',
  'paidHints',
  'paidHintIds',
  'hintIds',
  'solvesBy',
  'partsDone',
  'solved',
];

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, into));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  return into;
}

describe('the screen state holds no secret', () => {
  it('a JSON walk over every output finds no forbidden key', () => {
    const board = boardOf({
      teams: [red, { ...blue, escaped: true, escapedAtMs: 1_000 }],
      roster: [{ teamId: 't1', nickname: 'Ana', connected: true }],
    });
    const ui = run([
      { type: 'board', board },
      { type: 'announce', announce: announceOf({ kind: 'escaped' }), now: NOW },
      { type: 'announce', announce: announceOf({ kind: 'hint' }), now: NOW },
      { type: 'screenFinale', finale: screenFinaleOf(), record: null },
    ]);
    const outputs = [ui, lanesOf(board), showClockOf(board, NOW), lobbyOf(board)];
    const keys = keysOf(JSON.parse(JSON.stringify(outputs)));
    expect(FORBIDDEN.filter((k) => keys.has(k))).toEqual([]);
  });
});
