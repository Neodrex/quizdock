import type {
  EscapeAnnounce,
  EscapeBoard,
  EscapeClock,
  EscapeFinale,
  EscapeHostLock,
  EscapeHostOutline,
  EscapeHostStage,
  EscapeHostState,
  EscapeHostTeam,
  EscapeTeamUpdate,
} from '@quiz-dock/contracts';
import { type Announcement, formatDelta } from '../escape-reducer';
import { formatClock } from '../team-timer';

/**
 * The host console's escape state, pure (M5 §1.6): server events in, what to show and
 * say out. It holds only what the host is sent (the host outline has no answers), so it
 * has none to leak.
 */

/** How a hint was released: free on time, asked by the team, or given by the host. */
export type HintSource = Extract<EscapeTeamUpdate, { kind: 'hint' }>['source'];

/** One command of the console, busy from its send until its answer. */
export type CommandKey =
  | 'teams'
  | 'move'
  | 'start'
  | 'pause'
  | 'time'
  | 'hint'
  | 'unlock'
  | 'end'
  | 'finale'
  | 'runAgain';

/** A line of the activity feed: an `escape` key, its team and the run time it happened at. */
export interface FeedLine extends Announcement {
  teamId: string | null;
  /** Run time (ms, pauses excluded) when the console heard of it. */
  atMs: number;
}

export interface EscapeHostUi {
  outline: EscapeHostOutline | null;
  host: EscapeHostState | null;
  /** The latest board (clock and summaries), from `escape:board` or `escape:host`. */
  board: EscapeBoard | null;
  finale: EscapeFinale | null;
  /** Oldest first, the last FEED_KEPT. */
  feed: FeedLine[];
  /** Polite messages, oldest first; the announcer speaks the ones it has not yet. */
  polite: Announcement[];
  pending: Partial<Record<CommandKey, boolean>>;
  /** `final`: the results read back after the room closed (read-only). */
  ended: 'none' | 'final';
  /** How each hint was released, per team id then hint id, as heard (not after a reload). */
  hintSources: Record<string, Record<string, HintSource>>;
  /** The next message id (feed and polite share it). */
  seq: number;
}

/** `now`: the server time estimate (`serverNow()`) when the event came. */
export type EscapeHostAction =
  | { type: 'outline'; outline: EscapeHostOutline }
  | { type: 'host'; state: EscapeHostState; now: number }
  | { type: 'hostTeam'; team: EscapeHostTeam; now: number }
  | { type: 'board'; board: EscapeBoard }
  | { type: 'teamUpdate'; update: EscapeTeamUpdate; now: number }
  | { type: 'announce'; announce: EscapeAnnounce }
  | { type: 'finale'; finale: EscapeFinale }
  | { type: 'closed'; finale: EscapeFinale }
  | { type: 'pending'; key: CommandKey; on: boolean }
  | { type: 'feed'; key: string; now: number };

export const initialEscapeHostUi: EscapeHostUi = {
  outline: null,
  host: null,
  board: null,
  finale: null,
  feed: [],
  polite: [],
  pending: {},
  ended: 'none',
  seq: 1,
  hintSources: {},
};

/** Feed lines kept (the console's sessionStorage keeps as many, §1.5). */
export const FEED_KEPT = 50;
/** Polite messages kept: the announcer has long spoken older ones. */
const POLITE_KEPT = 20;

type Params = Announcement['params'];

/** Run time at `now`: the clock as sent, run on unless paused. */
export function runMsAt(clock: EscapeClock | undefined, now: number): number {
  if (!clock) return 0;
  return clock.paused ? clock.elapsedMs : clock.elapsedMs + Math.max(0, now - clock.serverNow);
}

function line(ui: EscapeHostUi, teamId: string | null, key: string, params: Params, now: number) {
  const msg: FeedLine = {
    id: ui.seq,
    key,
    ...(params ? { params } : {}),
    teamId,
    atMs: runMsAt(ui.board?.clock, now),
  };
  return { ...ui, seq: ui.seq + 1, feed: [...ui.feed, msg].slice(-FEED_KEPT) };
}

/** A feed line that is also spoken. */
function say(ui: EscapeHostUi, teamId: string | null, key: string, params: Params, now: number) {
  const out = line(ui, teamId, key, params, now);
  const msg: Announcement = { id: out.seq, key, ...(params ? { params } : {}) };
  return { ...out, seq: out.seq + 1, polite: [...out.polite, msg].slice(-POLITE_KEPT) };
}

const lockOf = (o: EscapeHostOutline | null, lockId: string): EscapeHostLock | undefined =>
  o?.stages.flatMap((s) => s.locks).find((l) => l.id === lockId);
const hintOf = (o: EscapeHostOutline | null, hintId: string) =>
  o?.stages.flatMap((s) => s.hints).find((h) => h.id === hintId);
const roleName = (o: EscapeHostOutline | null, roleId: string) =>
  o?.roles.find((r) => r.id === roleId)?.name ?? roleId;
const nickname = (t: EscapeHostTeam, playerId: string) =>
  t.members.find((m) => m.playerId === playerId)?.nickname ?? '?';

/** What changed in a team that is worth a line: stuck, a player gone. */
function diffTeam(
  ui: EscapeHostUi,
  prev: EscapeHostTeam | undefined,
  next: EscapeHostTeam,
  now: number,
): EscapeHostUi {
  if (!prev) return ui;
  let out = ui;
  if (!prev.stuck && next.stuck && !next.escaped && !next.timedOut) {
    out = say(
      out,
      next.id,
      'host.feed.stuck',
      { team: next.name, stage: next.stageTitle, minutes: Math.floor(next.timeOnStageMs / 60_000) },
      now,
    );
  }
  for (const m of next.members) {
    const before = prev.members.find((p) => p.playerId === m.playerId);
    if (before?.connected && !m.connected) {
      out = say(out, next.id, 'host.feed.disconnected', { name: m.nickname, team: next.name }, now);
    }
  }
  return out;
}

function onHost(ui: EscapeHostUi, state: EscapeHostState, now: number): EscapeHostUi {
  // A new run in the room: nothing of the last one carries over but the outline,
  // which the sync sends just before.
  if (ui.host && ui.host.gameId !== state.gameId) {
    return {
      ...initialEscapeHostUi,
      seq: ui.seq,
      outline: ui.outline,
      host: state,
      board: state.board,
    };
  }
  let out: EscapeHostUi = { ...ui, board: state.board };
  for (const t of state.teams)
    out = diffTeam(
      out,
      ui.host?.teams.find((p) => p.id === t.id),
      t,
      now,
    );
  return { ...out, host: state };
}

function onHostTeam(ui: EscapeHostUi, team: EscapeHostTeam, now: number): EscapeHostUi {
  const host = ui.host;
  const prev = host?.teams.find((t) => t.id === team.id);
  // An unknown team waits for the next escape:host.
  if (!host || !prev) return ui;
  const out = diffTeam(ui, prev, team, now);
  return { ...out, host: { ...host, teams: host.teams.map((t) => (t.id === team.id ? team : t)) } };
}

function onBoard(ui: EscapeHostUi, board: EscapeBoard): EscapeHostUi {
  const host = ui.host;
  if (!host) return { ...ui, board };
  const summaries = new Map(board.teams.map((s) => [s.id, s]));
  // The summaries move on; what only the host team has (solved, parts, members…) stays.
  const teams = host.teams.map((t) => {
    const s = summaries.get(t.id);
    return s ? { ...t, ...s } : t;
  });
  return { ...ui, board, host: { ...host, board, teams } };
}

function onTeamUpdate(ui: EscapeHostUi, u: EscapeTeamUpdate, now: number): EscapeHostUi {
  const host = ui.host;
  const team = host?.teams.find((t) => t.id === u.teamId);
  if (!host || !team) return ui;
  const o = ui.outline;
  const name = team.name;
  switch (u.kind) {
    case 'wrong': {
      // Counted, not said: too chatty (§1.7). The next escape:host-team has the true count.
      const teams = host.teams.map((t) => (t.id === team.id ? { ...t, wrong: t.wrong + 1 } : t));
      return { ...ui, host: { ...host, teams } };
    }
    case 'part-accepted':
      return line(
        ui,
        team.id,
        'host.feed.partAccepted',
        {
          team: name,
          by: nickname(team, u.by),
          role: roleName(o, u.roleId),
          lock: lockOf(o, u.lockId)?.label ?? '',
        },
        now,
      );
    case 'lock-solved': {
      const lock = lockOf(o, u.lockId)?.label ?? '';
      return u.by === null
        ? line(ui, team.id, 'host.feed.lockSolvedByHost', { team: name, lock }, now)
        : line(
            ui,
            team.id,
            'host.feed.lockSolved',
            { team: name, lock, by: nickname(team, u.by) },
            now,
          );
    }
    case 'stage-cleared':
      return say(
        ui,
        team.id,
        'host.feed.stageCleared',
        { team: name, stage: o?.stages[u.stageIndex]?.title ?? '' },
        now,
      );
    case 'escaped':
      return say(
        ui,
        team.id,
        'host.feed.escaped',
        { team: name, time: formatClock(runMsAt(ui.board?.clock, now)) },
        now,
      );
    case 'hint': {
      const sources = { ...ui.hintSources[team.id], [u.hintId]: u.source };
      ui = { ...ui, hintSources: { ...ui.hintSources, [team.id]: sources } };
      if (u.source === 'timer') return line(ui, team.id, 'host.feed.hintFree', { team: name }, now);
      const seconds = hintOf(o, u.hintId)?.penaltyS ?? 0;
      const key = u.source === 'host' ? 'host.feed.hintGiven' : 'host.feed.hintAsked';
      return line(ui, team.id, key, { team: name, seconds }, now);
    }
    case 'roles':
      return line(ui, team.id, 'host.feed.roles', { team: name }, now);
    case 'time':
      return line(
        ui,
        team.id,
        'host.feed.time',
        { team: name, delta: formatDelta(u.deltaMs) },
        now,
      );
    case 'time-up':
      return say(ui, team.id, 'host.feed.timeUp', { team: name }, now);
  }
}

export function escapeHostReducer(ui: EscapeHostUi, a: EscapeHostAction): EscapeHostUi {
  switch (a.type) {
    case 'outline':
      return { ...ui, outline: a.outline };
    case 'host':
      return onHost(ui, a.state, a.now);
    case 'hostTeam':
      return onHostTeam(ui, a.team, a.now);
    case 'board':
      return onBoard(ui, a.board);
    case 'teamUpdate':
      return onTeamUpdate(ui, a.update, a.now);
    case 'announce':
      // The screens' banners: the host already has each from its team update.
      return ui;
    case 'finale':
      // A late finale of the room's last run, once a new one is on: not ours.
      if (ui.host && a.finale.gameId !== ui.host.gameId) return ui;
      return { ...ui, finale: a.finale };
    case 'closed':
      return { ...ui, finale: a.finale, ended: 'final' };
    case 'pending':
      return { ...ui, pending: { ...ui.pending, [a.key]: a.on } };
    case 'feed':
      return line(ui, null, a.key, undefined, a.now);
  }
}

// ── Selectors ──

export interface HostLockView extends EscapeHostLock {
  solved: boolean;
  /** Opened by the host (`escape:unlock`): marked in the results. */
  byHost: boolean;
  /** Combined locks: the role ids entered so far. */
  partsDone: string[];
}

/** The team's current stage and its locks' state; null once escaped or before a stage. */
export function stageOf(
  outline: EscapeHostOutline,
  team: EscapeHostTeam,
): { stage: EscapeHostStage; locks: HostLockView[] } | null {
  const stage = team.escaped ? undefined : outline.stages[team.stageIndex];
  if (!stage) return null;
  return {
    stage,
    locks: stage.locks.map((l) => ({
      ...l,
      solved: team.solved.includes(l.id),
      byHost: team.hostUnlocks.includes(l.id),
      partsDone: team.partsDone[l.id] ?? [],
    })),
  };
}

/** The stage's first hint the team has not had, with its text and cost; null when none is left. */
export function nextHintOf(
  outline: EscapeHostOutline,
  team: EscapeHostTeam,
): EscapeHostStage['hints'][number] | null {
  const stage = team.escaped ? undefined : outline.stages[team.stageIndex];
  return stage?.hints.find((h) => !team.hintIds.includes(h.id)) ?? null;
}

export interface Coverage {
  roles: { id: string; name: string; holders: string[] }[];
  /** No member at all. */
  empty: boolean;
  /** Fewer members than roles: each player holds more than one. */
  shared: boolean;
  /** Role ids nobody holds (a team with members). */
  unheld: string[];
}

/** Who holds each role of the team; null in parallel mode (no roles to cover). */
export function coverageOf(outline: EscapeHostOutline, team: EscapeHostTeam): Coverage | null {
  if (outline.mode !== 'roles') return null;
  const roles = outline.roles.map((r) => ({
    id: r.id,
    name: r.name,
    holders: team.members.filter((m) => m.roles.includes(r.id)).map((m) => m.nickname),
  }));
  const empty = team.members.length === 0;
  return {
    roles,
    empty,
    shared: !empty && team.members.length < roles.length,
    unheld: empty ? [] : roles.filter((r) => r.holders.length === 0).map((r) => r.id),
  };
}

/** Readiness is the connection state (owner question 3): connected of total. */
export function readinessOf(team: Pick<EscapeHostTeam, 'members'>): {
  connected: number;
  total: number;
} {
  return {
    connected: team.members.filter((m) => m.connected).length,
    total: team.members.length,
  };
}
