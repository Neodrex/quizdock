/**
 * Outbound escape payloads (M3 plan §2). The leak boundary: phones get
 * EscapePlayerState, whose `view` always comes from playerView; screens get
 * counts, names and stage titles, and a finale without host columns (M6); the
 * host's outline has no answer either (M5).
 * Fields are copied one by one: no template object is ever spread.
 */

import type {
  EscapeAnnounce,
  EscapeBoard,
  EscapeClock,
  EscapeFinale,
  EscapeFormation,
  EscapeHostLock,
  EscapeHostOutline,
  EscapeHostSession,
  EscapeHostState,
  EscapeHostTeam,
  EscapeLook,
  EscapeMember,
  EscapePlayerSession,
  EscapePlayerState,
  EscapeRosterEntry,
  EscapeScreenFinale,
  EscapeTeamClock,
  EscapeTeamSummary,
  EscapeTeamUpdate,
} from '@quiz-dock/contracts';
import { toolsOf } from '@quiz-dock/contracts';
import { brandThemeOf } from './brand-theme';
import { deadlineAt, remainingMs, runElapsed, stageOpenedAt } from './escape-clock';
import type { EscapeRun, EscapeSession, EscapeSnapshot, TeamRecord } from './escape-live.types';
import { awards, hashOrder, nextHint, playerView, rankTeams } from './escape-rules';
import { type SessionLimits, limitsOf } from './escape-session';
import { RACE_RESULTS_TOP, type RaceResults } from './races/race.port';
import type { EscapeTemplate, Lock, Stage, SubmitResult, TeamState } from './escape.types';

/** A player of the room, as the engine sees it (R1 decides `connected`). */
export interface RoomPlayer {
  playerId: string;
  nickname: string;
  avatar: string | null;
  connected: boolean;
  /** The account the player joined with (null: a guest). Server side only. */
  userId: string | null;
}

/** Everything a payload is built from, read once per change. */
export interface RunView {
  /** The run's game id (meta.id). */
  id: string;
  snap: EscapeSnapshot;
  run: EscapeRun;
  /** Team records in display order (run.teamIds). */
  teams: TeamRecord[];
  /** The room's players in join order. */
  players: RoomPlayer[];
  /** The room's session (M7); null for a room opened before session types. */
  session: EscapeSession | null;
  now: number;
}

const own = <T>(rec: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(rec, key) ? rec[key] : undefined;

const elapsedOf = (v: RunView) => runElapsed(v.run.clock, v.now);

const currentStage = (tpl: EscapeTemplate, team: TeamState): Stage =>
  tpl.stages[Math.min(team.stageIndex, tpl.stages.length - 1)];

export function clockOf(v: RunView): EscapeClock {
  return {
    serverNow: v.now,
    paused: !!v.run.clock.pausedAt,
    elapsedMs: elapsedOf(v),
    limitMs: v.run.clock.limitMs,
  };
}

function teamClockOf(v: RunView, rec: TeamRecord): EscapeTeamClock {
  return {
    remainingMs: remainingMs(v.run.clock, rec.team, elapsedOf(v)),
    deadlineAt: rec.timedOut ? null : deadlineAt(v.run.clock, rec.team, v.now),
  };
}

/** The formation with `recs` listed (every team by default). */
export function formationOf(v: RunView, recs: readonly TeamRecord[] = v.teams): EscapeFormation {
  return {
    mode: v.run.formation,
    maxSize: v.run.maxSize || null,
    teams: recs.map((r) => ({
      id: r.team.id,
      name: r.team.name,
      memberCount: r.team.members.length,
    })),
  };
}

/**
 * A view's players by id and each player's team record, built once per view
 * (M9 Task 9.4): a host state asks for every team's members and every
 * player's team, which was teams × players. Views are never changed in place
 * (a new view gets new arrays), so the arrays key the index.
 */
const playerIndex = new WeakMap<RoomPlayer[], Map<string, RoomPlayer>>();
const teamIndex = new WeakMap<TeamRecord[], Map<string, TeamRecord>>();

function playersById(v: RunView): Map<string, RoomPlayer> {
  let byId = playerIndex.get(v.players);
  if (!byId) {
    byId = new Map(v.players.map((p) => [p.playerId, p]));
    playerIndex.set(v.players, byId);
  }
  return byId;
}

function recsByPlayer(v: RunView): Map<string, TeamRecord> {
  let byPlayer = teamIndex.get(v.teams);
  if (!byPlayer) {
    byPlayer = new Map();
    // The first team listing a player wins, as a find over the teams would.
    for (const r of v.teams)
      for (const id of r.team.members) if (!byPlayer.has(id)) byPlayer.set(id, r);
    teamIndex.set(v.teams, byPlayer);
  }
  return byPlayer;
}

function membersOf(v: RunView, team: TeamState): EscapeMember[] {
  const byId = playersById(v);
  return team.members.map((id) => {
    const p = byId.get(id);
    return {
      playerId: id,
      nickname: p?.nickname ?? '',
      avatar: p?.avatar ?? null,
      connected: p?.connected ?? false,
      roles: [...(own(team.roles, id) ?? [])],
    };
  });
}

const recOf = (v: RunView, playerId: string) => recsByPlayer(v).get(playerId) ?? null;

/** The session for one phone: its type and race, and whether it is the phone host. */
export function playerSessionOf(v: RunView, playerId: string): EscapePlayerSession | null {
  const s = v.session;
  if (!s) return null;
  const userId = v.players.find((p) => p.playerId === playerId)?.userId ?? null;
  return {
    type: s.type,
    raceFormat: s.race?.format ?? null,
    startsAt: s.race?.startsAt ?? null,
    isPhoneHost:
      s.phoneHostUserId !== null &&
      (userId === s.phoneHostUserId || (!!s.phoneHostPlayerId && playerId === s.phoneHostPlayerId)),
  };
}

/** To one phone. */
export function playerStateOf(v: RunView, playerId: string): EscapePlayerState {
  const tpl = v.snap.template;
  const rec = recOf(v, playerId);
  const live = v.run.phase === 'running';
  const playing =
    v.run.phase === 'running' && rec !== null && rec.team.escapedAt === null && !rec.timedOut;
  const hint = playing ? nextHint(tpl, rec.team) : null;
  return {
    gameId: v.id,
    session: playerSessionOf(v, playerId),
    phase: v.run.phase,
    clock: clockOf(v),
    title: tpl.title,
    intro: tpl.intro,
    roles: tpl.roles.map((r) => ({ id: r.id, name: r.name, description: r.description })),
    // A race (M7 §1.7) lists the phone's own team only: 500 phones never get 500 teams each.
    formation: viewLimits(v) ? formationOf(v, rec ? [rec] : []) : formationOf(v),
    team: rec && {
      ...teamClockOf(v, rec),
      id: rec.team.id,
      name: rec.team.name,
      members: membersOf(v, rec.team),
      stageIndex: rec.team.stageIndex,
      stageCount: tpl.stages.length,
      escaped: rec.team.escapedAt !== null,
      escapedMs: rec.team.escapedAt,
      timedOut: rec.timedOut,
      hintPenaltyS: rec.team.hintPenaltyS,
      ...(rec.code ? { code: rec.code } : {}),
    },
    view: live && rec ? playerView(tpl, rec.team, playerId, v.id) : null,
    nextHint: hint && { id: hint.id, penaltyS: hint.penaltyS },
  };
}

/** One team on the big screen: counts and titles, no secrets. */
export function teamSummaryOf(v: RunView, rec: TeamRecord): EscapeTeamSummary {
  const tpl = v.snap.template;
  const { team } = rec;
  const stage = currentStage(tpl, team);
  const members = membersOf(v, team);
  return {
    id: team.id,
    name: team.name,
    memberCount: members.length,
    connectedCount: members.filter((m) => m.connected).length,
    stageIndex: team.stageIndex,
    stageCount: tpl.stages.length,
    stageTitle: stage.title,
    locksSolved: team.solved.length,
    locksTotal: stage.locks.length,
    hintsUsed: team.hintsUsed.length,
    escaped: team.escapedAt !== null,
    escapedAtMs: team.escapedAt,
    timedOut: rec.timedOut,
    ...teamClockOf(v, rec),
  };
}

const unassignedOf = (v: RunView) => v.players.filter((p) => !recOf(v, p.playerId));

/**
 * The lobby roster (M6 owner answer 1): while forming, every player in join
 * order by nickname, with their team or null. Nothing else of a player. A race
 * sends none (M7 §1.7): its count is in `session.totals.players`.
 */
function rosterOf(v: RunView): EscapeRosterEntry[] {
  if (v.run.phase !== 'forming' || viewLimits(v)) return [];
  return v.players.map((p) => ({
    teamId: recOf(v, p.playerId)?.team.id ?? null,
    nickname: p.nickname,
    connected: p.connected,
  }));
}

/** The payload limits of the run's session (a race's); null: none. */
export const viewLimits = (v: RunView): SessionLimits | null =>
  v.session ? limitsOf(v.session.type) : null;

/**
 * Negative when `a` ranks before `b`, the M6 screen's rule (`lanesOf`): escaped
 * teams by their escape run time, then stage, locks solved and time left.
 */
export function compareSummaries(a: EscapeTeamSummary, b: EscapeTeamSummary): number {
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

/**
 * Every team's summary by place (ties share one, team order among them), the
 * screen's rule moved to the server so a race board can send its top teams only.
 */
export function placesOf(v: RunView): { summary: EscapeTeamSummary; place: number }[] {
  const all = v.teams.map((r) => teamSummaryOf(v, r));
  const sorted = all
    .map((summary, i) => ({ summary, i }))
    .sort((a, b) => compareSummaries(a.summary, b.summary) || a.i - b.i);
  let place = 0;
  return sorted.map(({ summary }, k) => {
    if (k === 0 || compareSummaries(sorted[k - 1].summary, summary) !== 0) place = k + 1;
    return { summary, place };
  });
}

export function boardOf(v: RunView): EscapeBoard {
  const limits = viewLimits(v);
  const teams = limits
    ? placesOf(v)
        .slice(0, limits.boardTeams)
        .map((p) => p.summary)
    : v.teams.map((r) => teamSummaryOf(v, r));
  return {
    gameId: v.id,
    session: v.session && {
      type: v.session.type,
      startsAt: v.session.race?.startsAt ?? null,
      totals: {
        teams: v.teams.length,
        players: v.players.length,
        escaped: v.teams.filter((r) => r.team.escapedAt !== null).length,
      },
    },
    phase: v.run.phase,
    clock: clockOf(v),
    title: v.snap.template.title,
    formation: { mode: v.run.formation, maxSize: v.run.maxSize || null },
    teams,
    unassigned: unassignedOf(v).length,
    roster: rosterOf(v),
  };
}

export function announceOf(kind: EscapeAnnounce['kind'], team: TeamState): EscapeAnnounce {
  return {
    kind,
    teamId: team.id,
    teamName: team.name,
    // The team has moved on when it cleared a stage: announce the stage it cleared.
    stageIndex: kind === 'stage-cleared' ? team.stageIndex - 1 : team.stageIndex,
  };
}

/**
 * What a submit (or a host unlock, `by` null) did, for the team's phones and
 * the host; null when refused. Wrong answers and parts only ever come from a
 * player, so their `by` is a player id.
 */
export function submitUpdateOf(
  tpl: EscapeTemplate,
  teamId: string,
  result: SubmitResult,
  by: string | null,
  roleId?: string,
): EscapeTeamUpdate | null {
  switch (result.outcome) {
    case 'wrong':
      return { teamId, kind: 'wrong', by: by ?? '' };
    case 'part-accepted':
      return {
        teamId,
        kind: 'part-accepted',
        lockId: result.lockId,
        roleId: roleId ?? '',
        by: by ?? '',
      };
    case 'lock-solved':
      return { teamId, kind: 'lock-solved', lockId: result.lockId, by };
    case 'stage-cleared':
      return {
        teamId,
        kind: 'stage-cleared',
        stageIndex: result.stageIndex,
        unlockText: tpl.stages[result.stageIndex].unlockText,
        by,
      };
    case 'escaped':
      return { teamId, kind: 'escaped', unlockText: tpl.stages.at(-1)!.unlockText, by };
    case 'refused':
      return null;
  }
}

/** A hint released: its id only, the text goes in the team's `view.hints`. */
export function hintUpdateOf(
  teamId: string,
  hintId: string,
  source: 'request' | 'timer' | 'host',
): EscapeTeamUpdate {
  return { teamId, kind: 'hint', hintId, source };
}

export function timeUpOf(teamId: string): EscapeTeamUpdate {
  return { teamId, kind: 'time-up' };
}

const copyRecord = (rec: Record<string, string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, [...v]]));

export function hostTeamOf(v: RunView, rec: TeamRecord): EscapeHostTeam {
  const { team } = rec;
  return {
    ...teamSummaryOf(v, rec),
    members: membersOf(v, team),
    solved: [...team.solved],
    partsDone: copyRecord(team.parts),
    wrong: team.wrong,
    hintIds: [...team.hintsUsed],
    paidHintIds: [...team.paidHints],
    hintPenaltyS: team.hintPenaltyS,
    adjustMs: team.adjustMs,
    hostUnlocks: [...team.hostUnlocks],
    solvesBy: Object.fromEntries(Object.entries(team.solvesBy)),
    stageClearedAt: [...team.stageClearedAt],
    lastProgressAt: rec.lastProgressAt,
    stuck: rec.stuck,
    timeOnStageMs:
      team.escapedAt !== null || v.run.phase === 'forming'
        ? 0
        : Math.max(0, elapsedOf(v) - stageOpenedAt(team)),
  };
}

/**
 * The session for the host (M7 §1.4), field by field: of the licence, its
 * organisation's name, expiry and package only.
 */
export function hostSessionOf(v: RunView): EscapeHostSession | null {
  const s = v.session;
  if (!s) return null;
  return {
    type: s.type,
    cap: s.cap,
    joined: v.players.length,
    race: s.race && {
      format: s.race.format,
      startsAt: s.race.startsAt,
      started: s.race.started,
      // M9 Task 9.6: a Site race's link, for the console's notice (host only).
      ...(s.race.siteRaceId && {
        siteLinked: s.race.siteLinked ?? true,
        ...(s.race.siteLost && { siteLost: true }),
        ...(s.race.siteMissing && { siteMissing: true }),
      }),
    },
    licence: s.licence && {
      organisationName: s.licence.brand?.name ?? null,
      expiresAt: s.licence.expiresAt,
      package: s.licence.package,
    },
    tools: [...toolsOf(s.type)],
  };
}

export function hostStateOf(v: RunView): EscapeHostState {
  return {
    gameId: v.id,
    session: hostSessionOf(v),
    board: boardOf(v),
    formation: formationOf(v),
    teams: v.teams.map((r) => hostTeamOf(v, r)),
    unassigned: unassignedOf(v).map((p) => ({
      playerId: p.playerId,
      nickname: p.nickname,
      connected: p.connected,
    })),
    templateVersion: v.snap.version,
  };
}

/**
 * A lock without what opens it (owner question 1): labels and part roles only.
 * Sequence items come in a per-run hash order (`seed`), as the phones get them:
 * a template authored in solution order would show the solution otherwise.
 */
function hostLockOf(l: Lock, seed: string): EscapeHostLock {
  const base = { id: l.id, label: l.label, kind: l.kind };
  switch (l.kind) {
    case 'code':
    case 'phrase':
      return base;
    case 'choice':
      return { ...base, options: l.options.map(({ id, label, image }) => ({ id, label, image })) };
    case 'sequence':
      return { ...base, items: hashOrder(l.items, `${seed}:${l.id}`) };
    case 'combined':
      return { ...base, partRoles: l.parts.map((p) => p.roleId) };
  }
}

/** The frozen template for the host console, without any answer (M5 §1.4). `gameId`: the run's. */
export function hostOutlineOf(snap: EscapeSnapshot, gameId: string): EscapeHostOutline {
  const t = snap.template;
  return {
    templateId: snap.templateId,
    version: snap.version,
    title: t.title,
    intro: t.intro,
    mode: t.mode,
    difficulty: t.difficulty,
    targetMinutes: t.targetMinutes,
    roles: t.roles.map(({ id, name, description }) => ({ id, name, description })),
    stages: t.stages.map((s) => ({
      id: s.id,
      title: s.title,
      intro: s.intro,
      unlockText: s.unlockText,
      locks: s.locks.map((l) => hostLockOf(l, gameId)),
      clues: s.clues.map(({ id, roleId, kind, body }) => ({ id, roleId, kind, body })),
      hints: s.hints.map(({ id, text, penaltyS, releaseAfterS }) => ({
        id,
        text,
        penaltyS,
        releaseAfterS,
      })),
    })),
  };
}

/** Ranking and awards of every team; members by nickname. */
/** `gameId`: the run's, for `escape:results`. */
export function finaleOf(v: RunView, gameId: string): EscapeFinale {
  const tpl = v.snap.template;
  const teams = v.teams.map((r) => r.team);
  const names = new Map(v.players.map((p) => [p.playerId, p.nickname]));
  const a = awards(teams);
  return {
    gameId,
    title: tpl.title,
    finale: tpl.finale,
    ranking: rankTeams(teams).map(({ team, place, scoreMs }) => ({
      teamId: team.id,
      name: team.name,
      place,
      scoreMs,
      escaped: team.escapedAt !== null,
      stagesCleared: team.stageClearedAt.length,
      stageClearedAt: [...team.stageClearedAt],
      hintsUsed: team.hintsUsed.length,
      paidHints: team.paidHints.length,
      hintPenaltyS: team.hintPenaltyS,
      adjustMs: team.adjustMs,
      hostUnlocks: team.hostUnlocks.length,
      members: team.members.map((id) => names.get(id) ?? ''),
    })),
    awards: {
      fastest: a.fastest,
      fewestHints: a.fewestHints,
      teamwork: a.teamwork,
      photoFinish: a.photoFinish && [a.photoFinish[0], a.photoFinish[1]],
    },
  };
}

/**
 * The finale for one phone (M7 §1.7): whole, except in a race, where it holds
 * the top `finaleTop` teams plus the phone's own row, and `totalTeams`.
 */
export function finaleFor(
  finale: EscapeFinale,
  teamId: string | null,
  limits: SessionLimits | null,
): EscapeFinale {
  if (!limits) return finale;
  const top = finale.ranking.slice(0, limits.finaleTop);
  const own = finale.ranking.find((r) => r.teamId === teamId);
  const ranking = own && !top.includes(own) ? [...top, own] : top;
  return { ...finale, ranking, totalTeams: finale.ranking.length };
}

/**
 * The finale for a screen (M6 §1.4), from the stored finale and the run: field
 * by field, without the host columns (`adjustMs`, `hostUnlocks`, `paidHints`)
 * and without any player id. Members stay nicknames (owner answer 1). Adds
 * what the split-time replay needs: every stage title, the run limit and
 * which teams timed out.
 */
export function screenFinaleOf(finale: EscapeFinale, v: RunView): EscapeScreenFinale {
  const timedOut = new Set(v.teams.filter((r) => r.timedOut).map((r) => r.team.id));
  const { awards: a } = finale;
  // A race's screen gets its top teams only (M7 §1.7).
  const limits = viewLimits(v);
  const rows = limits ? finale.ranking.slice(0, limits.finaleTop) : finale.ranking;
  return {
    gameId: finale.gameId,
    ...(limits ? { totalTeams: finale.ranking.length } : {}),
    title: finale.title,
    finale: finale.finale,
    limitMs: v.run.clock.limitMs,
    endedMs: v.run.clock.endedElapsedMs,
    stages: v.snap.template.stages.map((s) => ({ title: s.title })),
    ranking: rows.map((r) => ({
      teamId: r.teamId,
      name: r.name,
      place: r.place,
      scoreMs: r.scoreMs,
      escaped: r.escaped,
      timedOut: timedOut.has(r.teamId),
      stagesCleared: r.stagesCleared,
      stageClearedAt: [...r.stageClearedAt],
      hintsUsed: r.hintsUsed,
      hintPenaltyS: r.hintPenaltyS,
      members: [...r.members],
    })),
    awards: {
      fastest: a.fastest,
      fewestHints: a.fewestHints,
      teamwork: a.teamwork,
      photoFinish: a.photoFinish && [a.photoFinish[0], a.photoFinish[1]],
    },
  };
}

/**
 * M8: what a Site race's room reports after its finale: the finale's ranking
 * (hint penalties included, as the podium shows it), top RACE_RESULTS_TOP rows,
 * team names only (in a solo race, the player's nickname), never an id.
 */
export function raceResultsOf(finale: EscapeFinale, pin: string, endedAt: number): RaceResults {
  return {
    pin,
    endedAt,
    totalTeams: finale.ranking.length,
    top: finale.ranking.slice(0, RACE_RESULTS_TOP).map((r) => ({
      place: r.place,
      name: r.name,
      escaped: r.escaped,
      // The score (run time plus penalties), the time the ranking is by; not the raw run time.
      timeMs: r.escaped ? r.scoreMs : null,
      stages: r.stagesCleared,
    })),
  };
}

/**
 * escape:look (M7 §1.9): a hosted event's licence brand, or (M8) a Site race's
 * channel brand, as a theme, plus its name, logo and intro. Never the licence's
 * id, organisation or uses, nor the Site race id. Unbranded otherwise.
 */
export function lookOf(session: EscapeSession | null): EscapeLook {
  const brand =
    session?.type === 'hosted'
      ? session.licence?.brand
      : session?.type === 'race'
        ? session.race?.brand
        : null;
  if (!brand) return { theme: null, brand: null };
  return {
    theme: brandThemeOf(brand),
    brand: { name: brand.name, logoUrl: brand.logoUrl, intro: brand.intro },
  };
}
