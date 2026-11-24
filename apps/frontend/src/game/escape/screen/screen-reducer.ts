import type {
  EscapeAnnounce,
  EscapeBoard,
  EscapeScreenFinale,
  EscapeTeamSummary,
} from '@quiz-dock/contracts';
import type { Announcement } from '../escape-reducer';
import type { ScreenRecord } from './screen-record';

/**
 * The big screen's state (M6 §1.7), pure: the boards, announces and screen finale a
 * screen is sent, the banner queue, and the selectors the screen draws from.
 */

/** How long a banner stays up. */
export const BANNER_MS = 4000;
/** An escape stays up longer: the moment of the evening. */
export const ESCAPED_BANNER_MS = 6000;
/** Banners kept waiting behind the one shown; the lowest priority goes first. */
export const MAX_WAITING_BANNERS = 5;
/** The final minutes: 5, or 3 when the run is under SHORT_RUN_MS (owner question 3). */
export const FINAL_MS = 5 * 60_000;
export const SHORT_FINAL_MS = 3 * 60_000;
export const SHORT_RUN_MS = 30 * 60_000;
/** The tic-tac's span. */
export const LAST_SECONDS_MS = 10_000;
/** A lane shows its own time when it is this far from the show clock (extra time). */
const OWN_TIME_GAP_MS = 1000;
/** Polite messages kept for the announcer. */
const POLITE_KEPT = 10;

const PRIORITY: Record<EscapeAnnounce['kind'], number> = {
  escaped: 3,
  'stage-cleared': 2,
  'time-up': 1,
  hint: 0,
};

const SAY_KEY: Record<EscapeAnnounce['kind'], string> = {
  escaped: 'screen.banner.escaped',
  'stage-cleared': 'screen.banner.stageCleared',
  'time-up': 'screen.banner.timeUp',
  hint: 'screen.banner.hint',
};

export interface Banner extends EscapeAnnounce {
  id: number;
  durationMs: number;
  /** Epoch ms (screen clock) the banner goes; 0 while it waits. */
  until: number;
}

export interface EscapeScreenUi {
  board: EscapeBoard | null;
  finale: EscapeScreenFinale | null;
  /** Waiting, by priority then arrival. */
  banners: Banner[];
  current: Banner | null;
  /** The stage titles seen so far (the screen has no outline). */
  stageTitles: Record<number, string>;
  polite: Announcement[];
  replay: 'pending' | 'playing' | 'done';
  /** The room closed after the finale: "Thanks for playing". */
  closed: boolean;
  /** The next banner or message id. */
  seq: number;
}

export const initialScreenUi: EscapeScreenUi = {
  board: null,
  finale: null,
  banners: [],
  current: null,
  stageTitles: {},
  polite: [],
  replay: 'pending',
  closed: false,
  seq: 1,
};

export type EscapeScreenAction =
  | { type: 'board'; board: EscapeBoard }
  | { type: 'announce'; announce: EscapeAnnounce; now: number }
  | { type: 'next'; now: number }
  | { type: 'screenFinale'; finale: EscapeScreenFinale; record: ScreenRecord | null }
  | { type: 'replay'; replay: 'playing' | 'done' }
  | { type: 'closed' }
  /** `escape:closed`: the run was stopped and discarded. */
  | { type: 'stopped' };

function onBoard(ui: EscapeScreenUi, board: EscapeBoard): EscapeScreenUi {
  const prev = ui.board;
  const sameRun = prev?.gameId === board.gameId;
  if (prev && sameRun && board.clock.serverNow < prev.clock.serverNow) return ui;
  const base = sameRun || !prev ? ui : { ...initialScreenUi, seq: ui.seq, polite: ui.polite };
  const stageTitles = { ...base.stageTitles };
  for (const t of board.teams) if (t.stageTitle) stageTitles[t.stageIndex] = t.stageTitle;
  // A finale of another run is not this one's.
  const finale = base.finale && base.finale.gameId !== board.gameId ? null : base.finale;
  return { ...base, board, stageTitles, finale };
}

/**
 * Shows the next waiting banner when the current one is done (or none is up). While the
 * run is paused the queue waits: the next banner (and its sound) comes on resume.
 */
function advance(ui: EscapeScreenUi, now: number): EscapeScreenUi {
  if (ui.current && now < ui.current.until) return ui;
  if (ui.board?.clock.paused) return ui.current ? { ...ui, current: null } : ui;
  const [next, ...rest] = ui.banners;
  if (!next) return ui.current ? { ...ui, current: null } : ui;
  const shown = { ...next, until: now + next.durationMs };
  const msg: Announcement = {
    id: ui.seq,
    key: SAY_KEY[next.kind],
    params: { team: next.teamName, stage: next.stageIndex + 1 },
  };
  return {
    ...ui,
    current: shown,
    banners: rest,
    seq: ui.seq + 1,
    polite: [...ui.polite, msg].slice(-POLITE_KEPT),
  };
}

/**
 * An announce carries no run id: one of a new run that came before its first board would
 * queue under the last run's board. It cannot happen in practice: a run's first board
 * goes out at `escape:open`, while forming, and announces only come once it runs.
 */
function onAnnounce(ui: EscapeScreenUi, a: EscapeAnnounce, now: number): EscapeScreenUi {
  // A second hint for a team already waiting for one says nothing new.
  const dup =
    a.kind === 'hint' && ui.banners.some((b) => b.kind === 'hint' && b.teamId === a.teamId);
  if (dup) return ui;
  const banner: Banner = {
    kind: a.kind,
    teamId: a.teamId,
    teamName: a.teamName,
    stageIndex: a.stageIndex,
    id: ui.seq,
    durationMs: a.kind === 'escaped' ? ESCAPED_BANNER_MS : BANNER_MS,
    until: 0,
  };
  // Stable: by priority, then arrival; past the cap the lowest (latest of them) goes.
  const banners = [...ui.banners, banner]
    .sort((x, y) => PRIORITY[y.kind] - PRIORITY[x.kind])
    .slice(0, MAX_WAITING_BANNERS + (ui.current ? 0 : 1));
  return advance({ ...ui, banners, seq: ui.seq + 1 }, now);
}

export function screenReducer(ui: EscapeScreenUi, a: EscapeScreenAction): EscapeScreenUi {
  switch (a.type) {
    case 'board':
      return onBoard(ui, a.board);
    case 'announce':
      return onAnnounce(ui, a.announce, a.now);
    case 'next':
      return advance(ui, a.now);
    case 'screenFinale': {
      const replayed =
        !!a.record && a.record.gameId === a.finale.gameId && a.record.replayed === true;
      return { ...ui, finale: a.finale, replay: replayed ? 'done' : 'pending' };
    }
    case 'replay':
      return { ...ui, replay: a.replay };
    case 'closed':
      return { ...ui, closed: true };
    case 'stopped':
      return initialScreenUi;
  }
}

// ---- Selectors ----

export type Lane = EscapeTeamSummary & { place: number };

/**
 * Negative when `a` ranks before `b`: escaped teams by their escape run time (the
 * server's, so extra time and a reload change nothing), then stage, locks, time left.
 */
function compareTeams(a: EscapeTeamSummary, b: EscapeTeamSummary): number {
  if (a.escaped !== b.escaped) return a.escaped ? -1 : 1;
  if (a.escaped) {
    const byTime = (a.escapedAtMs ?? Infinity) - (b.escapedAtMs ?? Infinity);
    if (byTime) return byTime;
  } else {
    if (a.stageIndex !== b.stageIndex) return b.stageIndex - a.stageIndex;
    if (a.locksSolved !== b.locksSolved) return b.locksSolved - a.locksSolved;
  }
  return b.remainingMs - a.remainingMs;
}

/** The lanes in team order (owner question 5), each with its live place; ties share one. */
export function lanesOf(board: EscapeBoard): Lane[] {
  return board.teams.map((t) => ({
    ...t,
    place: 1 + board.teams.filter((o) => compareTeams(o, t) < 0).length,
  }));
}

export interface ShowClock {
  remainingMs: number;
  /** Server epoch ms the run ends; null when frozen (paused). */
  deadlineAt: number | null;
  paused: boolean;
}

const playing = (t: EscapeTeamSummary) => !t.escaped && !t.timedOut;

/** A team's time left at `now` (server clock). */
function remainingOf(t: EscapeTeamSummary, now: number, paused: boolean): number {
  return paused || t.deadlineAt === null ? t.remainingMs : Math.max(0, t.deadlineAt - now);
}

/**
 * The run clock: the latest deadline among the teams still playing, which is when the
 * run ends. Frozen while paused. Null before the run, after it, or with no team playing.
 */
export function showClockOf(board: EscapeBoard, now: number): ShowClock | null {
  if (board.phase !== 'running') return null;
  const left = board.teams.filter(playing);
  if (!left.length) return null;
  const paused = board.clock.paused;
  const deadlines = left.map((t) => t.deadlineAt).filter((d): d is number => d !== null);
  if (paused || !deadlines.length) {
    return { remainingMs: Math.max(...left.map((t) => t.remainingMs)), deadlineAt: null, paused };
  }
  const deadlineAt = Math.max(...deadlines);
  return { remainingMs: Math.max(0, deadlineAt - now), deadlineAt, paused };
}

/** A lane's own time, when it differs from the show clock by more than a second; else null. */
export function ownTimeOf(t: EscapeTeamSummary, show: ShowClock, now: number): number | null {
  if (!playing(t)) return null;
  const own = remainingOf(t, now, show.paused);
  return Math.abs(own - show.remainingMs) > OWN_TIME_GAP_MS ? own : null;
}

/** The final-minutes span for a run of `limitMs`. */
export function finalMsOf(limitMs: number): number {
  return limitMs < SHORT_RUN_MS ? SHORT_FINAL_MS : FINAL_MS;
}

export function finalMinutesOf(board: EscapeBoard, now: number): boolean {
  const show = showClockOf(board, now);
  return !!show && show.remainingMs <= finalMsOf(board.clock.limitMs);
}

export function lastSecondsOf(board: EscapeBoard, now: number): boolean {
  const show = showClockOf(board, now);
  return !!show && show.remainingMs <= LAST_SECONDS_MS;
}

export interface LobbyPlayer {
  nickname: string;
  connected: boolean;
}

export interface LobbyTeam {
  id: string;
  name: string;
  count: number;
  /** "3 / 5", or "3" without a cap. */
  label: string;
  full: boolean;
  /** Nicknames, in join order (owner answer 1), each with whether the phone is on. */
  members: LobbyPlayer[];
}

export interface Lobby {
  /** Players pick their team on their phone. */
  selfFormation: boolean;
  teams: LobbyTeam[];
  unassigned: number;
  /** Nicknames of the players with no team yet. */
  waiting: string[];
}

export function lobbyOf(board: EscapeBoard): Lobby {
  const { maxSize, mode } = board.formation;
  return {
    selfFormation: mode === 'self',
    teams: board.teams.map((t) => ({
      id: t.id,
      name: t.name,
      count: t.memberCount,
      label: maxSize === null ? `${t.memberCount}` : `${t.memberCount} / ${maxSize}`,
      full: maxSize !== null && t.memberCount >= maxSize,
      members: board.roster
        .filter((r) => r.teamId === t.id)
        .map((r) => ({ nickname: r.nickname, connected: r.connected })),
    })),
    unassigned: board.unassigned,
    waiting: board.roster.filter((r) => r.teamId === null).map((r) => r.nickname),
  };
}
