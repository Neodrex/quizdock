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
  EscapeHostState,
  EscapeHostTeam,
  EscapeMember,
  EscapePlayerState,
  EscapeRosterEntry,
  EscapeScreenFinale,
  EscapeTeamClock,
  EscapeTeamSummary,
  EscapeTeamUpdate,
} from '@quiz-dock/contracts';
import { deadlineAt, remainingMs, runElapsed, stageOpenedAt } from './escape-clock';
import type { EscapeRun, EscapeSnapshot, TeamRecord } from './escape-live.types';
import { awards, hashOrder, nextHint, playerView, rankTeams } from './escape-rules';
import type { EscapeTemplate, Lock, Stage, SubmitResult, TeamState } from './escape.types';

/** A player of the room, as the engine sees it (R1 decides `connected`). */
export interface RoomPlayer {
  playerId: string;
  nickname: string;
  avatar: string | null;
  connected: boolean;
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

export function formationOf(v: RunView): EscapeFormation {
  return {
    mode: v.run.formation,
    maxSize: v.run.maxSize || null,
    teams: v.teams.map((r) => ({
      id: r.team.id,
      name: r.team.name,
      memberCount: r.team.members.length,
    })),
  };
}

function membersOf(v: RunView, team: TeamState): EscapeMember[] {
  const byId = new Map(v.players.map((p) => [p.playerId, p]));
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

const recOf = (v: RunView, playerId: string) =>
  v.teams.find((r) => r.team.members.includes(playerId)) ?? null;

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
    phase: v.run.phase,
    clock: clockOf(v),
    title: tpl.title,
    intro: tpl.intro,
    roles: tpl.roles.map((r) => ({ id: r.id, name: r.name, description: r.description })),
    formation: formationOf(v),
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
    timedOut: rec.timedOut,
    ...teamClockOf(v, rec),
  };
}

const unassignedOf = (v: RunView) => v.players.filter((p) => !recOf(v, p.playerId));

/**
 * The lobby roster (M6 owner answer 1): while forming, every player in join
 * order by nickname, with their team or null. Nothing else of a player.
 */
function rosterOf(v: RunView): EscapeRosterEntry[] {
  if (v.run.phase !== 'forming') return [];
  return v.players.map((p) => ({
    teamId: recOf(v, p.playerId)?.team.id ?? null,
    nickname: p.nickname,
    connected: p.connected,
  }));
}

export function boardOf(v: RunView): EscapeBoard {
  return {
    gameId: v.id,
    phase: v.run.phase,
    clock: clockOf(v),
    title: v.snap.template.title,
    formation: { mode: v.run.formation, maxSize: v.run.maxSize || null },
    teams: v.teams.map((r) => teamSummaryOf(v, r)),
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

export function hostStateOf(v: RunView): EscapeHostState {
  return {
    gameId: v.id,
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
 * The finale for a screen (M6 §1.4), from the stored finale and the run: field
 * by field, without the host columns (`adjustMs`, `hostUnlocks`, `paidHints`)
 * and without any player id. Members stay nicknames (owner answer 1). Adds
 * what the split-time replay needs: every stage title, the run limit and
 * which teams timed out.
 */
export function screenFinaleOf(finale: EscapeFinale, v: RunView): EscapeScreenFinale {
  const timedOut = new Set(v.teams.filter((r) => r.timedOut).map((r) => r.team.id));
  const { awards: a } = finale;
  return {
    gameId: finale.gameId,
    title: finale.title,
    finale: finale.finale,
    limitMs: v.run.clock.limitMs,
    stages: v.snap.template.stages.map((s) => ({ title: s.title })),
    ranking: finale.ranking.map((r) => ({
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
